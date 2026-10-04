import type { EventStore } from "./store.js";
import type { PrivacyLevel } from "./types.js";
import { addDays, dayRange, localDate, localTime } from "./time.js";

export interface InsightsOptions {
  /** Last local date of the window (inclusive). */
  to: string;
  days?: number;
  timezone?: string;
  maxPrivacy?: PrivacyLevel;
}

interface Delta {
  count: number;
  previous: number;
  change: number | null;
}

export interface Insights {
  period: { from: string; to: string; days: number };
  previous: { from: string; to: string };
  total: Delta;
  streams: Array<{ stream: string } & Delta>;
  entities: Array<{ entity: string } & Delta>;
  new_entities: string[];
  faded_entities: string[];
  metrics: Array<{ key: string; avg: number; previous_avg: number | null; change: number | null }>;
  rhythm: { busiest_day: { date: string; count: number } | null; peak_hour: number | null; quiet_days: string[]; hours: number[] };
  loops: { created: number; done: number; dropped: number; open_now: number; follow_through: number | null };
}

interface Window {
  total: number;
  streams: Map<string, number>;
  entities: Map<string, number>;
  metrics: Map<string, { sum: number; n: number }>;
  days: Map<string, number>;
  hours: number[];
}

const pct = (now: number, prev: number) => (prev ? Math.round(((now - prev) / prev) * 100) : null);
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

function scan(store: EventStore, fromDate: string, toDate: string, tz: string, maxPrivacy: PrivacyLevel): Window {
  const w: Window = { total: 0, streams: new Map(), entities: new Map(), metrics: new Map(), days: new Map(), hours: Array(24).fill(0) };
  const from = dayRange(fromDate, tz).from;
  const to = dayRange(toDate, tz).to;
  for (const e of store.iterate({ from, to, maxPrivacy })) {
    if (e.source.startsWith("trigger:")) continue;
    w.total++;
    bump(w.streams, e.stream);
    for (const x of e.entities) bump(w.entities, x);
    bump(w.days, localDate(e.occurred_at, tz));
    w.hours[Number(localTime(e.occurred_at, tz).slice(0, 2))]!++;
    if (e.data && typeof e.data === "object" && !Array.isArray(e.data))
      for (const [k, v] of Object.entries(e.data as Record<string, unknown>)) {
        if (typeof v !== "number" || !Number.isFinite(v)) continue;
        const key = `${e.stream}/${e.kind}.${k}`;
        const m = w.metrics.get(key) ?? { sum: 0, n: 0 };
        m.sum += v;
        m.n++;
        w.metrics.set(key, m);
      }
  }
  return w;
}

/** Deterministic period-over-period patterns over the event log. */
export function computeInsights(store: EventStore, o: InsightsOptions): Insights {
  const tz = o.timezone ?? "UTC";
  const days = Math.max(1, Math.min(366, Math.floor(o.days ?? 7)));
  const maxPrivacy = o.maxPrivacy ?? "normal";
  const from = addDays(o.to, -(days - 1));
  const pTo = addDays(from, -1);
  const pFrom = addDays(pTo, -(days - 1));
  const cur = scan(store, from, o.to, tz, maxPrivacy);
  const prev = scan(store, pFrom, pTo, tz, maxPrivacy);

  const delta = (a: number, b: number): Delta => ({ count: a, previous: b, change: pct(a, b) });
  const ranked = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  const streams = ranked(cur.streams).map(([stream, n]) => ({ stream, ...delta(n, prev.streams.get(stream) ?? 0) }));
  for (const [stream, n] of ranked(prev.streams)) if (!cur.streams.has(stream)) streams.push({ stream, ...delta(0, n) });

  const entities = ranked(cur.entities)
    .slice(0, 15)
    .map(([entity, n]) => ({ entity, ...delta(n, prev.entities.get(entity) ?? 0) }));
  const new_entities = ranked(cur.entities)
    .filter(([k, n]) => n >= 2 && !prev.entities.has(k))
    .slice(0, 10)
    .map(([k]) => k);
  const faded_entities = ranked(prev.entities)
    .filter(([k, n]) => n >= 3 && !cur.entities.has(k))
    .slice(0, 10)
    .map(([k]) => k);

  const metrics = [...cur.metrics.entries()]
    .sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]))
    .slice(0, 12)
    .map(([key, m]) => {
      const avg = Math.round((m.sum / m.n) * 100) / 100;
      const p = prev.metrics.get(key);
      const previous_avg = p ? Math.round((p.sum / p.n) * 100) / 100 : null;
      return { key, avg, previous_avg, change: previous_avg ? pct(avg, previous_avg) : null };
    });

  const quiet_days: string[] = [];
  for (let d = from; d <= o.to; d = addDays(d, 1)) if (!cur.days.has(d)) quiet_days.push(d);
  const busiest = ranked(cur.days)[0];
  const peak = cur.total ? cur.hours.indexOf(Math.max(...cur.hours)) : null;

  const lo = dayRange(from, tz).from;
  const hi = dayRange(o.to, tz).to;
  const lv = maxPrivacy === "normal" ? ["normal"] : ["normal", "sensitive"];
  const ph = lv.map(() => "?").join(",");
  const q = (sql: string, ...args: unknown[]) => (store.db.prepare(sql).get(...args, ...lv) as { n: number }).n;
  const created = q(`SELECT COUNT(*) n FROM open_loops WHERE created_at >= ? AND created_at < ? AND privacy IN (${ph})`, lo, hi);
  const done = q(`SELECT COUNT(*) n FROM open_loops WHERE status = 'done' AND resolved_at >= ? AND resolved_at < ? AND privacy IN (${ph})`, lo, hi);
  const dropped = q(`SELECT COUNT(*) n FROM open_loops WHERE status = 'dropped' AND resolved_at >= ? AND resolved_at < ? AND privacy IN (${ph})`, lo, hi);
  const open_now = q(`SELECT COUNT(*) n FROM open_loops WHERE status IN ('open','snoozed') AND privacy IN (${ph})`);

  return {
    period: { from, to: o.to, days },
    previous: { from: pFrom, to: pTo },
    total: delta(cur.total, prev.total),
    streams,
    entities,
    new_entities,
    faded_entities,
    metrics,
    rhythm: { busiest_day: busiest ? { date: busiest[0], count: busiest[1] } : null, peak_hour: peak, quiet_days, hours: cur.hours },
    loops: { created, done, dropped, open_now, follow_through: done + dropped ? Math.round((done / (done + dropped)) * 100) : null },
  };
}

const arrow = (c: number | null) => (c === null ? "new" : c > 0 ? `▲ ${c}%` : c < 0 ? `▼ ${-c}%` : "=");
const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });

export function renderInsights(i: Insights): string {
  const out = [`# Insights — ${i.period.from} → ${i.period.to} (${i.period.days} days)`, ""];
  if (!i.total.count && !i.total.previous) return out.concat("_No events in this window or the one before it._").join("\n") + "\n";
  out.push(`**${fmt(i.total.count)} events** (${i.total.previous ? arrow(i.total.change) : "no data"} vs ${i.previous.from} → ${i.previous.to})`);
  if (i.streams.length) out.push("", "## Streams", ...i.streams.map((s) => `- ${s.stream}: ${fmt(s.count)} (${s.previous ? arrow(s.change) : "new"})`));
  if (i.entities.length) {
    out.push("", "## People, places & things", ...i.entities.map((e) => `- ${e.entity}: ${e.count}${e.previous ? ` (was ${e.previous})` : ""}`));
    if (i.new_entities.length) out.push(`New this period: ${i.new_entities.join(", ")}`);
    if (i.faded_entities.length) out.push(`Not mentioned since: ${i.faded_entities.join(", ")}`);
  }
  if (i.metrics.length)
    out.push("", "## Metrics (average)", ...i.metrics.map((m) => `- ${m.key}: ${fmt(m.avg)}${m.previous_avg !== null ? ` (${arrow(m.change)} from ${fmt(m.previous_avg)})` : ""}`));
  const r = i.rhythm;
  out.push("", "## Rhythm");
  if (r.busiest_day) out.push(`Busiest day: ${r.busiest_day.date} (${r.busiest_day.count})`);
  if (r.peak_hour !== null) out.push(`Most active hour: ${String(r.peak_hour).padStart(2, "0")}:00`);
  out.push(r.quiet_days.length ? `Days with nothing captured: ${r.quiet_days.join(", ")}` : "Something captured every day ✓");
  const l = i.loops;
  if (l.created || l.done || l.dropped || l.open_now)
    out.push("", "## Follow-through", `${l.created} loops opened · ${l.done} done · ${l.dropped} dropped${l.follow_through !== null ? ` · ${l.follow_through}% completed` : ""} · ${l.open_now} open now`);
  return out.join("\n") + "\n";
}
