import type { EventStore } from "./store.js";
import { sourceHealth } from "./sources.js";

export interface EventLogHealth {
  events: number;
  oldest: string | null;
  newest_received: string | null;
  undistilled: number;
  integrity: string;
  loops_active: number;
  stale_sources: Array<{ source: string; hours_since: number }>;
  api_open: boolean;
  warnings: string[];
}

/** Read-only health of the event log: SQLite integrity, freshness, stale feeds, open API. */
export function eventLogHealth(store: EventStore, o: { apiKeys: number; now?: string }): EventLogHealth {
  const db = store.db;
  const agg = db
    .prepare(
      `SELECT COUNT(*) AS events, MIN(occurred_at) AS oldest, MAX(received_at) AS newest_received,
              SUM(CASE WHEN distilled_at IS NULL THEN 1 ELSE 0 END) AS undistilled FROM events`,
    )
    .get() as { events: number; oldest: string | null; newest_received: string | null; undistilled: number | null };
  const qc = db.prepare(`PRAGMA quick_check`).all() as Array<Record<string, string>>;
  const integrity = qc.map((r) => Object.values(r)[0]).join("; ") || "ok";
  const loops_active = (
    db.prepare(`SELECT COUNT(*) AS c FROM open_loops WHERE status IN ('open','snoozed')`).get() as { c: number }
  ).c;
  const stale_sources = sourceHealth(store, { now: o.now })
    .filter((s) => s.stale)
    .map((s) => ({ source: s.source, hours_since: s.hours_since }));
  const api_open = o.apiKeys === 0;
  const warnings: string[] = [];
  if (integrity !== "ok") warnings.push(`SQLite integrity: ${integrity}`);
  if (api_open) warnings.push("No API keys or webhook token set — /v1 API is open to anyone who can reach it");
  for (const s of stale_sources) warnings.push(`Feed ${s.source} silent for ${s.hours_since}h`);
  return { ...agg, undistilled: agg.undistilled ?? 0, integrity, loops_active, stale_sources, api_open, warnings };
}
