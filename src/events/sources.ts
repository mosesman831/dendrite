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
  return out.sort((a, b) => Number(b.stale) - Number(a.stale) || b.events - a.events);
}

export function renderSources(rows: SourceRow[]): string {
  if (!rows.length) return "No events received in the window.\n";
  return (
    rows
      .map(
        (r) =>
          `${r.stale ? "⚠" : r.continuous ? "●" : "○"} ${r.source.padEnd(22)} ${String(r.events).padStart(7)} ev  ${String(r.days_active).padStart(2)}d active  last ${r.hours_since}h ago${r.p90_gap_hours != null ? `  (p90 gap ${r.p90_gap_hours}h)` : ""}${r.stale ? "  STALE" : ""}`,
      )
      .join("\n") + "\n"
  );
}
