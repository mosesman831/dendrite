import type { EventStore } from "./store.js";
import { ingestEvents, type IngestOptions } from "./ingest.js";
import { parseIcs } from "./importers.js";
import type { PrivacyLevel } from "./types.js";

export interface CalendarSub {
  name: string;
  url?: string;
  url_env?: string;
  interval_min?: number;
  privacy?: PrivacyLevel;
}

export interface CalendarSyncResult {
  name: string;
  ok: boolean;
  events: number;
  accepted: number;
  duplicates: number;
  error?: string;
}

type FetchText = (url: string) => Promise<string>;

const defaultFetch: FetchText = async (url) => {
  const r = await fetch(url, { headers: { accept: "text/calendar, */*" }, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
};

export function calendarUrl(c: CalendarSub, env: NodeJS.ProcessEnv = process.env): string | null {
  const u = c.url_env ? env[c.url_env] : c.url;
  return u?.trim() ? u.trim().replace(/^webcal:/i, "https:") : null;
}

/** Pull one ICS subscription into the event log. Idempotent via VEVENT UID (+RECURRENCE-ID). */
export async function syncCalendar(
  store: EventStore,
  c: CalendarSub,
  ingest: IngestOptions,
  fetchText: FetchText = defaultFetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CalendarSyncResult> {
  const res: CalendarSyncResult = { name: c.name, ok: false, events: 0, accepted: 0, duplicates: 0 };
  const url = calendarUrl(c, env);
  if (!url) return { ...res, error: c.url_env ? `${c.url_env} not set` : "no url" };
  try {
    const { items } = parseIcs(await fetchText(url), { source: `ics:${c.name}` });
    const evs = (items as Array<Record<string, unknown>>).map((e) => ({
      ...e,
      ...(c.privacy ? { privacy: c.privacy } : {}),
      external_id: e.external_id ? `${c.name}:${e.external_id}` : undefined,
    }));
    res.events = evs.length;
    for (let i = 0; i < evs.length; i += ingest.maxBatch) {
      const r = ingestEvents(store, evs.slice(i, i + ingest.maxBatch), ingest);
      res.accepted += r.accepted;
      res.duplicates += r.duplicates;
    }
    res.ok = true;
  } catch (e) {
    // Never echo the URL: subscription links are secrets.
    res.error = (e as Error).message.replace(/https?:\/\/\S+/g, "<url>");
  }
  return res;
}
