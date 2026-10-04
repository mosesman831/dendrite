import type { EventStore } from "./store.js";
import type { PrivacyLevel } from "./types.js";
import { localDate } from "./time.js";

export interface Habit {
  name: string;
  /** Full-text query that counts as doing it (defaults to the name). */
  query?: string;
  stream?: string;
  every_days?: number;
}

export interface HabitStatus {
  name: string;
  every_days: number;
  last: string | null;
  days_ago: number | null;
  /** Occurrences in the current unbroken chain (gaps ≤ every_days, still within the window today). */
  streak: number;
  done_30d: number;
  overdue: boolean;
}

const DAY = 86_400_000;

export function habitStatus(store: EventStore, habits: Habit[], o: { now?: string; timezone?: string; maxPrivacy?: PrivacyLevel } = {}): HabitStatus[] {
  const tz = o.timezone ?? "UTC";
  const now = o.now ?? new Date().toISOString();
  const today = Date.parse(localDate(now, tz));
  return habits.map((h) => {
    const every = h.every_days ?? 7;
    const days = [
      ...new Set(
        store
          .query({ q: h.query ?? h.name, stream: h.stream, maxPrivacy: o.maxPrivacy ?? "sensitive", order: "desc", limit: 1000, to: now })
          .events.filter((e) => !e.source.startsWith("trigger:"))
          .map((e) => localDate(e.occurred_at, tz)),
      ),
    ].sort().reverse();
    const last = days[0] ?? null;
    const daysAgo = last ? Math.round((today - Date.parse(last)) / DAY) : null;
    let streak = 0;
    if (daysAgo != null && daysAgo <= every) {
      streak = 1;
      for (let i = 1; i < days.length && (Date.parse(days[i - 1]!) - Date.parse(days[i]!)) / DAY <= every; i++) streak++;
    }
    return {
      name: h.name,
      every_days: every,
      last,
      days_ago: daysAgo,
      streak,
      done_30d: days.filter((d) => today - Date.parse(d) < 30 * DAY).length,
      overdue: daysAgo == null || daysAgo > every,
    };
  });
}

export function renderHabits(rows: HabitStatus[]): string {
  if (!rows.length) return "No habits configured (add `habits:` to config).\n";
  return (
    rows
      .map(
        (h) =>
          `${h.overdue ? "⚠" : "✓"} ${h.name}: ${h.last ? `last ${h.days_ago === 0 ? "today" : `${h.days_ago}d ago`}` : "never recorded"} · every ${h.every_days}d · ${h.done_30d}× in 30d${h.streak > 1 ? ` · streak ${h.streak}` : ""}`,
      )
      .join("\n") + "\n"
  );
}
