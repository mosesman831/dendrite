import { habitStatus, type Habit } from "./habits.js";
import { sourceHealth } from "./sources.js";
import { listPeople } from "./people.js";
import type { DendriteConfig } from "../config.js";
import type { EventStore } from "./store.js";
import type { PrivacyLevel } from "./types.js";
import { addDays, dayRange } from "./time.js";
import { summarizeDay, type TimelineEntry } from "./timeline.js";
import { listLoops, type OpenLoop } from "./loops.js";

export interface BriefingOptions {
  timezone?: string;
  maxPrivacy?: PrivacyLevel;
  agendaStreams?: string[];
  soonDays?: number;
  lookbackYears?: number;
  /** Max drifting people to suggest reconnecting with (0 disables). */
  reconnect?: number;
  /** Warn about continuous sources that went silent (default true). */
  captureWarnings?: boolean;
  habits?: Habit[];
  now?: string;
}

export interface Briefing {
  date: string;
  timezone: string;
  agenda: TimelineEntry[];
  loops: { overdue: OpenLoop[]; today: OpenLoop[]; soon: OpenLoop[]; undated: number };
  yesterday: { date: string; total: number; streams: Array<{ stream: string; count: number }>; highlights: TimelineEntry[] };
  on_this_day: Array<{ date: string; years_ago: number; highlights: TimelineEntry[] }>;
  reconnect: Array<{ entity: string; days_since: number; typical_gap_days: number | null }>;
  stale_sources: Array<{ source: string; hours_since: number }>;
  habits_due: Array<{ name: string; days_ago: number | null; every_days: number }>;
}

export function briefOptionsFromConfig(config: DendriteConfig): BriefingOptions {
  const b = config.brief;
  return {
    timezone: config.vault?.timezone,
    maxPrivacy: b?.include_sensitive ? "sensitive" : "normal",
    agendaStreams: b?.agenda_streams,
    soonDays: b?.soon_days,
    lookbackYears: b?.lookback_years,
    habits: config.habits,
  };
}

function shiftYears(date: string, n: number): string | null {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y - n, m - 1, d));
  return t.getUTCMonth() === m - 1 ? t.toISOString().slice(0, 10) : null; // skip Feb 29 in non-leap years
}

/** Deterministic morning briefing: today's agenda, loops by urgency, yesterday's highlights, and this day in past years. */
export function buildBriefing(store: EventStore, date: string, o: BriefingOptions = {}): Briefing {
  const tz = o.timezone ?? "UTC";
  const base = { timezone: tz, maxPrivacy: o.maxPrivacy ?? "normal" };
  const top = (s: { highlights: TimelineEntry[]; timeline: TimelineEntry[] }, n: number) =>
    (s.highlights.length ? s.highlights : s.timeline).slice(0, n);

  const agenda = summarizeDay(store, date, { ...base, stream: o.agendaStreams ?? ["calendar"], maxTimeline: 50 }).timeline;

  const active = listLoops(store, { status: "active", maxPrivacy: base.maxPrivacy, limit: 500 });
  const soonEnd = addDays(date, o.soonDays ?? 3);
  const loops = {
    overdue: active.filter((l) => l.due_date && l.due_date < date),
    today: active.filter((l) => l.due_date === date),
    soon: active.filter((l) => l.due_date && l.due_date > date && l.due_date <= soonEnd),
    undated: active.filter((l) => !l.due_date).length,
  };

  const yd = addDays(date, -1);
  const y = summarizeDay(store, yd, base);
  const yesterday = { date: yd, total: y.total, streams: y.streams.map((s) => ({ stream: s.stream, count: s.count })), highlights: top(y, 6) };

  const on_this_day: Briefing["on_this_day"] = [];
  for (let k = 1; k <= (o.lookbackYears ?? 5); k++) {
    const d = shiftYears(date, k);
    if (!d) continue;
    const s = summarizeDay(store, d, base);
    if (s.total) on_this_day.push({ date: d, years_ago: k, highlights: top(s, 3) });
  }

  const n = o.reconnect ?? 3;
  const reconnect = n
    ? listPeople(store, { now: dayRange(date, tz).to, maxPrivacy: base.maxPrivacy, limit: 500 })
        .filter((p) => p.drifting)
        .sort((a, b) => b.mentions - a.mentions || a.entity.localeCompare(b.entity))
        .slice(0, n)
        .map(({ entity, days_since, typical_gap_days }) => ({ entity, days_since, typical_gap_days }))
    : [];
  const stale_sources =
    o.captureWarnings === false
      ? []
      : sourceHealth(store, { now: o.now })
          .filter((s) => s.stale)
          .map(({ source, hours_since }) => ({ source, hours_since }));
  const habits_due = habitStatus(store, o.habits ?? [], { now: o.now ?? dayRange(date, tz).to, timezone: tz, maxPrivacy: base.maxPrivacy })
    .filter((h) => h.overdue)
    .map(({ name, days_ago, every_days }) => ({ name, days_ago, every_days }));
  return { date, timezone: tz, agenda, loops, yesterday, on_this_day, reconnect, stale_sources, habits_due };
}

const entry = (e: TimelineEntry) => `- ${e.time} [${e.stream}] ${e.summary}`;
const loopLine = (l: OpenLoop) => `- [ ] ${l.text}${l.due_date ? ` (due ${l.due_date})` : ""} \`${l.id.slice(0, 8)}\``;

export function renderBriefing(b: Briefing): string {
  const out = [`# Briefing — ${b.date}`, "", "## Today"];
  out.push(...(b.agenda.length ? b.agenda.map(entry) : ["_Nothing scheduled._"]));

  const { overdue, today, soon, undated } = b.loops;
  if (overdue.length || today.length || soon.length || undated) {
    out.push("", "## Open loops");
    if (overdue.length) out.push("**Overdue**", ...overdue.map(loopLine));
    if (today.length) out.push("**Due today**", ...today.map(loopLine));
    if (soon.length) out.push("**Coming up**", ...soon.map(loopLine));
    if (undated) out.push(`_+${undated} open loop${undated === 1 ? "" : "s"} without a due date_`);
  }

  if (b.yesterday.total) {
    out.push("", `## Yesterday (${b.yesterday.date}) — ${b.yesterday.total} events`);
    out.push(b.yesterday.streams.map((s) => `${s.stream} ${s.count}`).join(" · "));
    out.push(...b.yesterday.highlights.map(entry));
  }

  if (b.on_this_day.length) {
    out.push("", "## On this day");
    for (const d of b.on_this_day) out.push(`**${d.years_ago} year${d.years_ago === 1 ? "" : "s"} ago (${d.date})**`, ...d.highlights.map(entry));
  }
  if (b.reconnect.length) {
    out.push("", "## Reconnect");
    for (const r of b.reconnect) out.push(`- ${r.entity}: usually every ~${r.typical_gap_days}d, last mentioned ${r.days_since}d ago`);
  }
  if (b.habits_due?.length) {
    out.push("", "## Habits due");
    for (const h of b.habits_due) out.push(`- ${h.name}: ${h.days_ago == null ? "never recorded" : `${h.days_ago}d since last`} (every ${h.every_days}d)`);
  }
  if (b.stale_sources?.length) {
    out.push("", "## Capture gaps");
    for (const s of b.stale_sources) out.push(`- ${s.source}: nothing received for ${Math.round(s.hours_since)}h — check the device/app`);
  }

  return out.join("\n") + "\n";
}
