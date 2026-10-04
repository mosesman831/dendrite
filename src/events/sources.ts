import type { EventStore } from "./store.js";

export interface SourceHealthOptions {
  now?: string;
  windowDays?: number;
  /** A source is stale when silent for longer than factor × its p90 gap (floored at minHours). */
  factor?: number;
  minHours?: number;
  /** Sources with fewer active days are one-shot imports, not continuous feeds. */
  minActiveDays?: number;
}

export interface SourceRow {
  source: string;
  events: number;
  days_active: number;
  last_received: string;
  hours_since: number;
  p90_gap_hours: number | null;
  continuous: boolean;
  stale: boolean;
  /** Last sync error for pulled subscriptions (calendars, feeds). */
  error?: string;
}

interface SyncStatus {
  attempt_at: string;
  ok_at: string | null;
  error: string | null;
  interval_min: number;
}

/** Remember the outcome of a pull subscription, so health reflects sync success rather than whether anything new arrived. */
export function recordSync(store: EventStore, source: string, intervalMin: number, error?: string, now = new Date().toISOString()): void {
  const prev = store.getCheckpoint(`sync:${source}`);
  const p = prev ? (JSON.parse(prev) as SyncStatus) : null;
  const s: SyncStatus = { attempt_at: now, ok_at: error ? (p?.ok_at ?? null) : now, error: error ?? null, interval_min: intervalMin };
  store.setCheckpoint(`sync:${source}`, JSON.stringify(s));
}

const H = 3_600_000;
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Liveness of each ingest source by arrival time (received_at), so backfilled imports don't look live. */
export function sourceHealth(store: EventStore, o: SourceHealthOptions = {}): SourceRow[] {
  const now = Date.parse(o.now ?? new Date().toISOString());
  const since = new Date(now - (o.windowDays ?? 30) * 24 * H).toISOString();
  const rows = store.db
    .prepare(
      `SELECT source, received_at FROM events WHERE received_at >= ? AND source NOT LIKE 'derived:%' AND source NOT LIKE 'trigger:%' ORDER BY source, received_at`,
    )
    .all(since) as Array<{ source: string; received_at: string }>;
  const by = new Map<string, number[]>();
  for (const r of rows) {
    const list = by.get(r.source) ?? [];
    list.push(Date.parse(r.received_at));
    by.set(r.source, list);
  }
  const out: SourceRow[] = [];
  for (const [source, ts] of by) {
    const days = new Set(ts.map((t) => new Date(t).toISOString().slice(0, 10))).size;
    const gaps = ts.slice(1).map((t, i) => t - ts[i]!).filter((g) => g > 60_000).sort((a, b) => a - b);
    const p90 = gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * 0.9))]! : null;
    const last = ts[ts.length - 1]!;
    const hours = (now - last) / H;
    const continuous = days >= (o.minActiveDays ?? 3) && p90 != null;
    const limit = Math.max(o.minHours ?? 6, ((p90 ?? 0) / H) * (o.factor ?? 3));
    out.push({
      source,
      events: ts.length,
      days_active: days,
      last_received: new Date(last).toISOString(),
      hours_since: round1(hours),
      p90_gap_hours: p90 == null ? null : round1(p90 / H),
      continuous,
      stale: continuous && hours > limit,
    });
  }
  const subs = store.db.prepare(`SELECT name, value FROM checkpoints WHERE name LIKE 'sync:%'`).all() as Array<{ name: string; value: string }>;
  for (const c of subs) {
    const source = c.name.slice(5);
    const s = JSON.parse(c.value) as SyncStatus;
    const ref = Date.parse(s.ok_at ?? s.attempt_at);
    const hours = (now - ref) / H;
    const limit = Math.max(o.minHours ?? 6, (s.interval_min / 60) * (o.factor ?? 3));
    const base = out.find((r) => r.source === source);
    const row: SourceRow = base ?? { source, events: 0, days_active: 0, last_received: s.ok_at ?? s.attempt_at, hours_since: 0, p90_gap_hours: null, continuous: true, stale: false };
    row.continuous = true;
    row.hours_since = round1(hours);
    row.stale = !s.ok_at || hours > limit;
    if (s.error) row.error = s.error;
    if (!base) out.push(row);
  }
  return out.sort((a, b) => Number(b.stale) - Number(a.stale) || b.events - a.events);
}

export function renderSources(rows: SourceRow[]): string {
  if (!rows.length) return "No events received in the window.\n";
  return (
    rows
      .map(
        (r) =>
          `${r.stale ? "⚠" : r.continuous ? "●" : "○"} ${r.source.padEnd(22)} ${String(r.events).padStart(7)} ev  ${String(r.days_active).padStart(2)}d active  last ${r.hours_since}h ago${r.p90_gap_hours != null ? `  (p90 gap ${r.p90_gap_hours}h)` : ""}${r.stale ? "  STALE" : ""}${r.error ? `  (${r.error})` : ""}`,
      )
      .join("\n") + "\n"
  );
}
