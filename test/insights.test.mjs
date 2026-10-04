import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { dist } from "./helpers.mjs";

const { EventStore } = await dist("events/store.js");
const { ingestEvents, DEFAULT_INGEST_OPTIONS } = await dist("events/ingest.js");
const { computeInsights, renderInsights } = await dist("events/insights.js");

test("insights: deltas, new/faded entities, metrics, rhythm, follow-through, privacy", () => {
  const store = new EventStore(new Database(":memory:"));
  const opts = { ...DEFAULT_INGEST_OPTIONS, loops: { exclude: ["health"], autoResolve: true, timezone: "UTC" } };
  const ev = (d, h, stream, text, extra = {}) => ({ stream, kind: extra.kind ?? "m", text, occurred_at: `2026-${d}T${String(h).padStart(2, "0")}:00:00Z`, ...extra });
  ingestEvents(store, [
    // previous week (09-21..09-27)
    ev("09-22", 9, "note", "Lunch chat with Oscar"), ev("09-23", 9, "note", "Oscar again"), ev("09-24", 9, "note", "Called Oscar"),
    ev("09-22", 7, "health", null, { kind: "steps", data: { steps: 10000 } }),
    // this week (09-28..10-04)
    ev("09-28", 21, "note", "Dinner with Priya"), ev("09-29", 21, "note", "Priya sent the plan"), ev("09-29", 22, "note", "I need to book flights"),
    ev("09-30", 21, "note", "Booked the flights finally — done"), ev("10-01", 21, "note", "I'll clean the garage"),
    ev("09-28", 7, "health", null, { kind: "steps", data: { steps: 8000 } }), ev("09-29", 7, "health", null, { kind: "steps", data: { steps: 9000 } }),
    ev("10-02", 20, "note", "Secret Bob stuff", { privacy: "secret" }),
  ], opts);
  assert.equal(computeInsights(store, { to: "2026-10-04", timezone: "UTC" }).total.count, 5); // health is sensitive by default
  const i = computeInsights(store, { to: "2026-10-04", days: 7, timezone: "UTC", maxPrivacy: "sensitive" });
  assert.deepEqual(i.period, { from: "2026-09-28", to: "2026-10-04", days: 7 });
  assert.deepEqual(i.previous, { from: "2026-09-21", to: "2026-09-27" });
  assert.equal(i.total.count, 7);
  assert.equal(i.total.previous, 4);
  assert.equal(i.total.change, 75);
  assert.ok(i.new_entities.includes("Priya"));
  assert.ok(i.faded_entities.includes("Oscar"));
  assert.ok(!i.entities.some((e) => e.entity === "Bob"));
  const steps = i.metrics.find((m) => m.key === "health/steps.steps");
  assert.deepEqual([steps.avg, steps.previous_avg, steps.change], [8500, 10000, -15]);
  assert.equal(i.rhythm.peak_hour, 21);
  assert.deepEqual(i.rhythm.quiet_days, ["2026-10-02", "2026-10-03", "2026-10-04"]);
  assert.equal(i.loops.created, 2);
  assert.equal(i.loops.done, 1);
  assert.equal(i.loops.follow_through, 100);
  assert.equal(i.loops.open_now, 1);
  const md = renderInsights(i);
  for (const s of ["**7 events** (▲ 75%", "## Streams", "New this period: Priya", "Not mentioned since: Oscar", "health/steps.steps: 8,500 (▼ 15% from 10,000)", "Most active hour: 21:00", "2 loops opened · 1 done"]) assert.ok(md.includes(s), s);
});

test("insights: empty window", () => {
  const store = new EventStore(new Database(":memory:"));
  assert.match(renderInsights(computeInsights(store, { to: "2026-10-04" })), /No events/);
});
