import type { EventStore } from "./store.js";
import type { EventRecord, PrivacyLevel } from "./types.js";
import { addDays, dayRange, isoWeek, localDate, localTime } from "./time.js";

export interface NumericStat {
  count: number;
  sum: number;
  min: number;
  max: number;
  avg: number;
}

export interface StreamDigest {
  stream: string;
  count: number;
  kinds: Record<string, number>;
  /** Numeric aggregates of top-level `data` fields, keyed `kind.field`. */
  metrics: Record<string, NumericStat>;
}

export interface TimelineEntry {
  id: string;
  date: string;
  time: string;
  stream: string;
  kind: string;
  summary: string;
  importance: number;
  entities: string[];
}

export interface RangeSummary {
  label: string;
  period: "day" | "week" | "range";
  from: string;
  to: string;
  timezone: string;
  total: number;
  streams: StreamDigest[];
  entities: Array<{ entity: string; count: number }>;
  tags: Array<{ tag: string; count: number }>;
  highlights: TimelineEntry[];
  timeline: TimelineEntry[];
  truncated: boolean;
  event_ids: string[];
}

export interface SummarizeOptions {
  timezone?: string;
  maxPrivacy?: PrivacyLevel;
  stream?: string | string[];
  maxTimeline?: number;
  highlightThreshold?: number;
}

/** One-line human summary of an event, preferring text, then compact data. */
export function eventSummary(e: Pick<EventRecord, "text" | "data" | "kind">, max = 160): string {
  let s = e.text?.trim() ?? "";
  if (!s && e.data && typeof e.data === "object") {
    s = Object.entries(e.data as Record<string, unknown>)
      .filter(([, v]) => v === null || ["string", "number", "boolean"].includes(typeof v))
      .slice(0, 6)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
  }
  if (!s) s = e.kind;
  s = s.replace(/\s+/g, " ");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function bump<K>(m: Map<K, number>, k: K, n = 1): void {
  m.set(k, (m.get(k) ?? 0) + n);
}

export function summarizeRange(
  store: EventStore,
  range: { from: string; to: string; label?: string; period?: RangeSummary["period"] },
  opts: SummarizeOptions = {},
): RangeSummary {
  const tz = opts.timezone ?? "UTC";
  const maxTimeline = opts.maxTimeline ?? 500;
  const threshold = opts.highlightThreshold ?? 0.65;
  const streams = new Map<string, StreamDigest>();
  const entities = new Map<string, number>();
  const tags = new Map<string, number>();
  const timeline: TimelineEntry[] = [];
  const ids: string[] = [];
  let total = 0;
  for (const e of store.iterate({
    from: range.from,
    to: range.to,
    stream: opts.stream,
    maxPrivacy: opts.maxPrivacy ?? "sensitive",
  })) {
    total++;
    ids.push(e.id);
    let sd = streams.get(e.stream);
    if (!sd) {
      sd = { stream: e.stream, count: 0, kinds: {}, metrics: {} };
      streams.set(e.stream, sd);
    }
    sd.count++;
    sd.kinds[e.kind] = (sd.kinds[e.kind] ?? 0) + 1;
    if (e.data && typeof e.data === "object" && !Array.isArray(e.data)) {
      for (const [k, v] of Object.entries(e.data as Record<string, unknown>)) {
        if (typeof v !== "number" || !Number.isFinite(v)) continue;
        const key = `${e.kind}.${k}`;
        const m = (sd.metrics[key] ??= { count: 0, sum: 0, min: v, max: v, avg: 0 });
        m.count++;
        m.sum += v;
        m.min = Math.min(m.min, v);
        m.max = Math.max(m.max, v);
        m.avg = m.sum / m.count;
      }
    }
    e.entities.forEach((x) => bump(entities, x));
    e.tags.forEach((x) => bump(tags, x));
    const entry: TimelineEntry = {
      id: e.id,
      date: localDate(e.occurred_at, tz),
      time: localTime(e.occurred_at, tz),
      stream: e.stream,
      kind: e.kind,
      summary: eventSummary(e),
      importance: e.importance,
      entities: e.entities,
    };
    if (timeline.length < maxTimeline) timeline.push(entry);
    else if (entry.importance >= threshold) timeline.push(entry);
  }
  const top = <K>(m: Map<K, number>, n: number) =>
    [...m.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, n);
  const highlights = [...timeline]
    .filter((t) => t.importance >= threshold)
    .sort((a, b) => b.importance - a.importance || a.id.localeCompare(b.id))
    .slice(0, 12)
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const sd of streams.values()) {
    for (const m of Object.values(sd.metrics)) m.avg = Math.round(m.avg * 100) / 100;
  }
  return {
    label: range.label ?? `${range.from}..${range.to}`,
    period: range.period ?? "range",
    from: range.from,
    to: range.to,
    timezone: tz,
    total,
    streams: [...streams.values()].sort((a, b) => b.count - a.count || a.stream.localeCompare(b.stream)),
    entities: top(entities, 25).map(([entity, count]) => ({ entity, count })),
    tags: top(tags, 25).map(([tag, count]) => ({ tag, count })),
    highlights,
    timeline,
    truncated: total > timeline.length,
    event_ids: ids,
  };
}

/** Monday (YYYY-MM-DD) of the ISO week containing date. */
export function weekStart(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7;
  return addDays(date, 1 - dow);
}

export function summarizeDay(store: EventStore, date: string, opts: SummarizeOptions = {}): RangeSummary {
  const r = dayRange(date, opts.timezone);
  return summarizeRange(store, { ...r, label: date, period: "day" }, opts);
}

export function summarizeWeek(store: EventStore, date: string, opts: SummarizeOptions = {}): RangeSummary {
  const start = weekStart(date);
  const from = dayRange(start, opts.timezone).from;
  const to = dayRange(addDays(start, 7), opts.timezone).from;
  return summarizeRange(store, { from, to, label: isoWeek(start), period: "week" }, opts);
}

function fmtNum(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/** Deterministic Obsidian-friendly markdown digest. */
export function renderDigestMarkdown(s: RangeSummary): string {
  const fm = [
    "---",
    `type: digest`,
    `period: ${s.period}`,
    `label: "${s.label}"`,
    `from: ${s.from}`,
    `to: ${s.to}`,
    `timezone: ${s.timezone}`,
    `event_count: ${s.total}`,
    `streams: [${s.streams.map((x) => x.stream).join(", ")}]`,
    `generated_by: dendrite`,
    "---",
    "",
  ];
  const out = [...fm, `# ${s.period === "week" ? "Week" : s.period === "day" ? "Day" : "Digest"} ${s.label}`, ""];
  if (!s.total) {
    out.push("_No events recorded._", "");
    return out.join("\n");
  }
  out.push(`**${s.total} events** across ${s.streams.length} stream(s).`, "");
  if (s.highlights.length) {
    out.push("## Highlights", "");
    for (const h of s.highlights) out.push(`- ${s.period === "day" ? h.time : `${h.date} ${h.time}`} · *${h.stream}* — ${h.summary}`);
    out.push("");
  }
  out.push("## Streams", "");
  for (const sd of s.streams) {
    const kinds = Object.entries(sd.kinds)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k} ×${n}`)
      .join(", ");
    out.push(`- **${sd.stream}** (${sd.count}): ${kinds}`);
    for (const [key, m] of Object.entries(sd.metrics).slice(0, 8)) {
      out.push(`  - ${key}: sum ${fmtNum(m.sum)}, avg ${fmtNum(m.avg)}, min ${fmtNum(m.min)}, max ${fmtNum(m.max)}`);
    }
  }
  out.push("");
  if (s.entities.length) {
    out.push("## People, places & things", "");
    out.push(s.entities.slice(0, 15).map((e) => `${e.entity} (${e.count})`).join(" · "), "");
  }
  if (s.tags.length) out.push(`Tags: ${s.tags.map((t) => `#${t.tag}`).join(" ")}`, "");
  out.push("## Timeline", "");
  let lastDate = "";
  for (const t of s.timeline) {
    if (s.period !== "day" && t.date !== lastDate) {
      out.push(`### ${t.date}`);
      lastDate = t.date;
    }
    out.push(`- ${t.time} \`${t.stream}/${t.kind}\` ${t.summary}`);
  }
  if (s.truncated) out.push("", `_…${s.total - s.timeline.length} lower-importance events omitted._`);
  out.push("");
  return out.join("\n");
}

/** Plain-text timeline for terminals. */
export function renderTimelineText(s: RangeSummary): string {
  const lines = [`${s.label} — ${s.total} events (${s.timezone})`];
  let lastDate = "";
  for (const t of s.timeline) {
    if (s.period !== "day" && t.date !== lastDate) {
      lines.push(`\n${t.date}`);
      lastDate = t.date;
    }
    const star = t.importance >= 0.65 ? "★" : " ";
    lines.push(`${star} ${t.time}  ${`${t.stream}/${t.kind}`.padEnd(22)} ${t.summary}`);
  }
  if (s.truncated) lines.push(`… ${s.total - s.timeline.length} more`);
  return lines.join("\n");
}
