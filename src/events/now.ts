import type { EventStore } from "./store.js";
import type { PrivacyLevel } from "./types.js";
import { eventSummary } from "./timeline.js";
import { localDate, localTime } from "./time.js";
import { listLoops } from "./loops.js";
import { matchPlace, type Place } from "./places.js";
import { habitStatus, type Habit } from "./habits.js";
import { sourceHealth } from "./sources.js";

export interface NowOptions {
  now?: string;
  timezone?: string;
  maxPrivacy?: PrivacyLevel;
  places?: Place[];
  habits?: Habit[];
  recent?: number;
}

export interface NowSnapshot {
  now: string;
  local: string;
  where: { place: string | null; lat: number; lon: number; at: string } | null;
  recent: Array<{ at: string; stream: string; summary: string }>;
  loops_due: Array<{ id: string; text: string; due_date: string | null }>;
  habits_due: string[];
  stale_sources: string[];
  /** Earlier non-location events tagged with the current place (before this visit). */
  last_here: Array<{ at: string; stream: string; summary: string }>;
}

/** One-call situational awareness for an agent: where the user is, what just happened, what's due, what's broken. */
export function buildNow(store: EventStore, o: NowOptions = {}): NowSnapshot {
  const tz = o.timezone ?? "UTC";
  const now = o.now ?? new Date().toISOString();
  const maxPrivacy = o.maxPrivacy ?? "normal";
  const today = localDate(now, tz);
  const geo = store.query({ stream: ["location", "movement"], maxPrivacy, limit: 20, order: "desc", to: now }).events.find((e) => e.lat != null && e.lon != null);
  const recent = store
    .query({ maxPrivacy, limit: o.recent ?? 8, order: "desc", to: now })
    .events.map((e) => ({ at: e.occurred_at, stream: e.stream, summary: eventSummary(e) }));
  const place = geo ? (matchPlace(geo.lat, geo.lon, o.places)?.name ?? null) : null;
  const before = new Date(Date.parse(now) - 12 * 3600_000).toISOString();
  const last_here = place
    ? store
        .query({ entity: place, maxPrivacy, limit: 50, order: "desc", to: before })
        .events.filter((e) => e.stream !== "location" && e.stream !== "movement")
        .slice(0, 3)
        .map((e) => ({ at: e.occurred_at, stream: e.stream, summary: eventSummary(e) }))
    : [];
  return {
    now,
    local: `${today} ${localTime(now, tz)} ${tz}`,
    where: geo ? { place, lat: geo.lat!, lon: geo.lon!, at: geo.occurred_at } : null,
    recent,
    loops_due: listLoops(store, { status: "active", maxPrivacy, limit: 500 })
      .filter((l) => l.due_date && l.due_date <= today)
      .map((l) => ({ id: l.id, text: l.text, due_date: l.due_date })),
    habits_due: habitStatus(store, o.habits ?? [], { now, timezone: tz, maxPrivacy }).filter((h) => h.overdue).map((h) => h.name),
    stale_sources: sourceHealth(store, { now }).filter((s) => s.stale).map((s) => s.source),
    last_here,
  };
}

export function renderNow(n: NowSnapshot, tz = "UTC"): string {
  const out = [`# Now — ${n.local}`];
  if (n.where)
    out.push(`**Where:** ${n.where.place ?? `${n.where.lat.toFixed(4)}, ${n.where.lon.toFixed(4)}`} (as of ${localDate(n.where.at, tz)} ${localTime(n.where.at, tz)})`);
  if (n.last_here?.length)
    out.push("", `**Last time at ${n.where?.place}:**`, ...n.last_here.map((r) => `- ${localDate(r.at, tz)} [${r.stream}] ${r.summary}`));
  if (n.loops_due.length) out.push("", "**Due / overdue:**", ...n.loops_due.map((l) => `- [ ] ${l.text} (due ${l.due_date}) \`${l.id.slice(0, 8)}\``));
  if (n.habits_due.length) out.push("", `**Habits due:** ${n.habits_due.join(", ")}`);
  if (n.stale_sources.length) out.push("", `**Capture gaps:** ${n.stale_sources.join(", ")} silent — recent data may be missing`);
  out.push("", "**Recent:**", ...(n.recent.length ? n.recent.map((r) => `- ${localDate(r.at, tz)} ${localTime(r.at, tz)} [${r.stream}] ${r.summary}`) : ["_nothing recorded_"]));
  return out.join("\n") + "\n";
}
