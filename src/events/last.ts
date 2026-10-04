import type { EventStore } from "./store.js";
import type { EventRecord, PrivacyLevel } from "./types.js";
import { eventSummary } from "./timeline.js";
import { localDate } from "./time.js";

export interface LastTime {
  query: string;
  last: EventRecord | null;
  days_ago: number | null;
  /** Distinct local days with a match (within the scanned window). */
  days_seen: number;
  typical_gap_days: number | null;
  recent_days: string[];
}

const DAY = 86_400_000;

/** "When did I last …?" — most recent match plus how often it usually happens. */
export function lastTime(store: EventStore, query: string, o: { now?: string; timezone?: string; maxPrivacy?: PrivacyLevel; scan?: number } = {}): LastTime {
  const tz = o.timezone ?? "UTC";
  const now = o.now ?? new Date().toISOString();
  const evs = store
    .query({ q: query, maxPrivacy: o.maxPrivacy ?? "normal", order: "desc", limit: o.scan ?? 500, to: now })
    .events.filter((e) => !e.source.startsWith("trigger:"));
  const last = evs[0] ?? null;
  const days = [...new Set(evs.map((e) => localDate(e.occurred_at, tz)))].sort();
  const gaps = days.slice(1).map((d, i) => (Date.parse(d) - Date.parse(days[i]!)) / DAY).sort((a, b) => a - b);
  return {
    query,
    last,
    days_ago: last ? Math.floor((Date.parse(localDate(now, tz)) - Date.parse(localDate(last.occurred_at, tz))) / DAY) : null,
    days_seen: days.length,
    typical_gap_days: gaps.length ? Math.round(gaps[Math.floor(gaps.length / 2)]!) : null,
    recent_days: days.slice(-5).reverse(),
  };
}

export function renderLastTime(r: LastTime, tz = "UTC"): string {
  if (!r.last) return `No record of “${r.query}”.\n`;
  const ago = r.days_ago === 0 ? "today" : r.days_ago === 1 ? "yesterday" : `${r.days_ago} days ago`;
  const lines = [`Last “${r.query}”: ${localDate(r.last.occurred_at, tz)} (${ago}) — ${eventSummary(r.last)}`];
  if (r.days_seen > 1)
    lines.push(`Seen on ${r.days_seen} days${r.typical_gap_days ? `, usually every ~${r.typical_gap_days}d` : ""}. Recent: ${r.recent_days.join(", ")}`);
  if (r.typical_gap_days && r.days_ago != null && r.days_ago > 2 * r.typical_gap_days) lines.push(`That's over twice the usual gap.`);
  return lines.join("\n") + "\n";
}
