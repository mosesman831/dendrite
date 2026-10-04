import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { ImportOptions, ParsedImport } from "./importers.js";

export type Browser = "chrome" | "firefox" | "safari";

const CHROME_EPOCH_US = 11_644_473_600_000_000n;
const SAFARI_EPOCH_S = 978_307_200;
const SECRET_PARAMS = /^(token|access_token|id_token|refresh_token|code|key|api_?key|password|pass|pwd|secret|sig|signature|auth|session|sid|otp)$/i;

/** Drop credential-like query params; keep the rest (search queries are valuable memory). */
export function scrubUrl(raw: string): string {
  try {
    const u = new URL(raw);
    for (const k of [...u.searchParams.keys()]) if (SECRET_PARAMS.test(k)) u.searchParams.delete(k);
    u.hash = "";
    return u.toString();
  } catch {
    return raw;
  }
}

export function detectBrowser(db: Database.Database): Browser | null {
  const tables = new Set(
    (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>).map((r) => r.name),
  );
  if (tables.has("urls") && tables.has("visits")) return "chrome";
  if (tables.has("moz_places") && tables.has("moz_historyvisits")) return "firefox";
  if (tables.has("history_items") && tables.has("history_visits")) return "safari";
  return null;
}

interface Row {
  id: number;
  url: string;
  title: string | null;
  t: number | bigint;
  duration?: number | bigint | null;
}

/**
 * Read Chrome/Edge/Brave `History`, Firefox `places.sqlite`, or Safari `History.db`.
 * The file is copied first because browsers hold a lock while running.
 */
export function readBrowserHistory(path: string, opts: ImportOptions & { since?: string; limit?: number } = {}): ParsedImport {
  const dir = mkdtempSync(join(tmpdir(), "dendrite-browser-"));
  const copy = join(dir, "h.db");
  copyFileSync(path, copy);
  for (const suf of ["-wal", "-shm"]) if (existsSync(path + suf)) copyFileSync(path + suf, copy + suf);
  const db = new Database(copy, { readonly: true, fileMustExist: true });
  db.defaultSafeIntegers(true);
  try {
    const browser = detectBrowser(db);
    if (!browser) throw new Error("not a recognised Chrome/Firefox/Safari history database");
    const sinceMs = opts.since ? Date.parse(opts.since) : 0;
    const limit = opts.limit ?? 1_000_000;
    let rows: Row[];
    let toMs: (t: number | bigint) => number;
    if (browser === "chrome") {
      toMs = (t) => Number((BigInt(t) - CHROME_EPOCH_US) / 1000n);
      rows = db
        .prepare(
          `SELECT v.id AS id, u.url AS url, u.title AS title, v.visit_time AS t, v.visit_duration AS duration
           FROM visits v JOIN urls u ON u.id = v.url WHERE v.visit_time >= ? ORDER BY v.visit_time LIMIT ?`,
        )
        .all(BigInt(sinceMs) * 1000n + CHROME_EPOCH_US, limit) as Row[];
    } else if (browser === "firefox") {
      toMs = (t) => Number(BigInt(t) / 1000n);
      rows = db
        .prepare(
          `SELECT v.id AS id, p.url AS url, p.title AS title, v.visit_date AS t
           FROM moz_historyvisits v JOIN moz_places p ON p.id = v.place_id WHERE v.visit_date >= ? ORDER BY v.visit_date LIMIT ?`,
        )
        .all(BigInt(sinceMs) * 1000n, limit) as Row[];
    } else {
      db.defaultSafeIntegers(false);
      toMs = (t) => (Number(t) + SAFARI_EPOCH_S) * 1000;
      rows = db
        .prepare(
          `SELECT v.id AS id, i.url AS url, v.title AS title, v.visit_time AS t
           FROM history_visits v JOIN history_items i ON i.id = v.history_item WHERE v.visit_time >= ? ORDER BY v.visit_time LIMIT ?`,
        )
        .all(sinceMs / 1000 - SAFARI_EPOCH_S, limit) as Row[];
    }
    const items: unknown[] = [];
    const errors: ParsedImport["errors"] = [];
    rows.forEach((r, i) => {
      if (!/^https?:/i.test(r.url)) return;
      const ms = toMs(r.t);
      if (!Number.isFinite(ms) || ms <= 0) return void errors.push({ index: i, error: "bad visit time" });
      const url = scrubUrl(r.url);
      let host = "";
      try {
        host = new URL(url).hostname.replace(/^www\./, "");
      } catch {
        /* keep empty */
      }
      const title = r.title?.trim() || null;
      const durS = r.duration ? Math.round(Number(r.duration) / 1e6) : undefined;
      items.push({
        stream: opts.stream ?? "browser",
        kind: opts.kind ?? "visit",
        source: opts.source ?? browser,
        occurred_at: new Date(ms).toISOString(),
        ended_at: durS && durS > 0 ? new Date(ms + durS * 1000).toISOString() : undefined,
        external_id: `${browser}:${String(r.id)}`,
        text: title ? `${title} — ${host}` : url,
        entities: host ? [host] : undefined,
        data: { url, title, host, duration_s: durS || undefined },
      });
    });
    return { items, errors };
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
