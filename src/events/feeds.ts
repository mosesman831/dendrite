import type { EventStore } from "./store.js";
import { ingestEvents, type IngestOptions } from "./ingest.js";
import type { PrivacyLevel } from "./types.js";

export interface FeedSub {
  name: string;
  url?: string;
  url_env?: string;
  interval_min?: number;
  stream?: string;
  privacy?: PrivacyLevel;
}

export interface FeedItem {
  id: string | null;
  title: string;
  link: string | null;
  at: string | null;
  summary: string;
}

export interface FeedSyncResult {
  name: string;
  ok: boolean;
  items: number;
  accepted: number;
  duplicates: number;
  error?: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
      e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENTITIES[e.toLowerCase()] ?? m),
    );
}

const plain = (s: string) => decode(decode(s).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

function tag(block: string, ...names: string[]): string | null {
  for (const n of names) {
    const m = new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`, "i").exec(block);
    if (m) return m[1];
  }
  return null;
}

function isoOrNull(s: string | null): string | null {
  if (!s) return null;
  const t = Date.parse(decode(s).trim());
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Minimal RSS 2.0 / Atom parser — enough for activity feeds (Letterboxd, Goodreads, YouTube, blogs). */
export function parseFeed(xml: string): FeedItem[] {
  const blocks = [...xml.matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)].map((m) => m[2]);
  return blocks.map((b) => {
    const atomLink = /<link\b[^>]*?(?:rel="alternate"[^>]*?)?href="([^"]+)"[^>]*\/?>/i.exec(b)?.[1];
    const link = atomLink ? decode(atomLink) : tag(b, "link") ? plain(tag(b, "link")!) : null;
    return {
      id: tag(b, "guid", "id") ? plain(tag(b, "guid", "id")!) : null,
      title: plain(tag(b, "title") ?? ""),
      link: link || null,
      at: isoOrNull(tag(b, "pubDate", "published", "updated", "dc:date")),
      summary: plain(tag(b, "description", "summary", "content", "media:description") ?? "").slice(0, 500),
    };
  });
}

type FetchText = (url: string) => Promise<string>;

const defaultFetch: FetchText = async (url) => {
  const r = await fetch(url, { headers: { accept: "application/rss+xml, application/atom+xml, application/xml, */*" }, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
};

export function feedUrl(f: FeedSub, env: NodeJS.ProcessEnv = process.env): string | null {
  const u = f.url_env ? env[f.url_env] : f.url;
  return u?.trim() || null;
}

/** Pull one RSS/Atom feed into the event log. Append-only; idempotent per guid (or link). */
export async function syncFeed(
  store: EventStore,
  f: FeedSub,
  ingest: IngestOptions,
  fetchText: FetchText = defaultFetch,
  env: NodeJS.ProcessEnv = process.env,
  now: () => string = () => new Date().toISOString(),
): Promise<FeedSyncResult> {
  const res: FeedSyncResult = { name: f.name, ok: false, items: 0, accepted: 0, duplicates: 0 };
  const url = feedUrl(f, env);
  if (!url) return { ...res, error: f.url_env ? `${f.url_env} not set` : "no url" };
  try {
    const at = now();
    const evs = parseFeed(await fetchText(url))
      .filter((i) => i.title || i.summary)
      .map((i) => ({
        stream: f.stream ?? "feed",
        kind: "item",
        source: `feed:${f.name}`,
        external_id: `${f.name}:${i.id ?? i.link ?? `${i.title}|${i.at ?? ""}`}`,
        occurred_at: i.at ?? at,
        text: [i.title, i.summary && i.summary !== i.title ? i.summary : ""].filter(Boolean).join(" — "),
        data: { url: i.link, feed: f.name },
        ...(f.privacy ? { privacy: f.privacy } : {}),
      }));
    res.items = evs.length;
    for (let i = 0; i < evs.length; i += ingest.maxBatch) {
      const r = ingestEvents(store, evs.slice(i, i + ingest.maxBatch), ingest);
      res.accepted += r.accepted;
      res.duplicates += r.duplicates;
    }
    res.ok = true;
  } catch (e) {
    res.error = (e as Error).message.replace(/https?:\/\/\S+/g, "<url>");
  }
  return res;
}
