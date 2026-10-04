import type { EventStore } from "./store.js";
import type { PrivacyLevel } from "./types.js";
import { listLoops } from "./loops.js";
import { addDays } from "./time.js";
import { summarizeDay } from "./timeline.js";

export interface EveningRecap {
  date: string;
  total: number;
  streams: Array<{ stream: string; count: number }>;
  people: string[];
  highlights: string[];
  due_tomorrow: string[];
}

/** End-of-day recap of what the log captured today, plus tomorrow's due loops. */
export function buildEvening(store: EventStore, date: string, o: { timezone?: string; maxPrivacy?: PrivacyLevel } = {}): EveningRecap {
  const maxPrivacy = o.maxPrivacy ?? "normal";
  const s = summarizeDay(store, date, { timezone: o.timezone, maxPrivacy });
  const tomorrow = addDays(date, 1);
  return {
    date,
    total: s.total,
    streams: s.streams.map((x) => ({ stream: x.stream, count: x.count })).slice(0, 6),
    people: s.entities.slice(0, 5).map((e) => e.entity),
    highlights: [...new Map([...s.highlights, ...s.timeline].map((h) => [h.id, h])).values()]
      .slice(0, 3)
      .sort((a, b) => a.time.localeCompare(b.time))
      .map((h) => `${h.time} ${h.summary}`),
    due_tomorrow: listLoops(store, { maxPrivacy }).filter((l) => l.due_date === tomorrow).map((l) => l.text),
  };
}

export function renderEvening(r: EveningRecap): string {
  const out = [`# Evening — ${r.date}`];
  if (r.total) {
    out.push(`${r.total} events: ${r.streams.map((s) => `${s.stream} ${s.count}`).join(", ")}`);
    if (r.people.length) out.push(`With: ${r.people.join(", ")}`);
    for (const h of r.highlights) out.push(`- ${h}`);
  } else out.push("Nothing captured today.");
  if (r.due_tomorrow.length) out.push("", "Due tomorrow:", ...r.due_tomorrow.map((t) => `☐ ${t}`));
  out.push("", "How was your day? Reply with anything worth remembering — it's logged, and \"I'll…\" becomes an open loop.");
  return out.join("\n");
}
