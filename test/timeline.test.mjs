import { test, after } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { dist } from "./helpers.mjs";

const { EventStore } = await dist("events/store.js");
const { ingestEvents } = await dist("events/ingest.js");
const { summarizeDay, summarizeWeek, renderDigestMarkdown, renderTimelineText, weekStart, eventSummary } = await dist(
  "events/timeline.js",
);
const { resolveDate } = await dist("commands/timeline.js");

const db = new Database(":memory:");
after(() => db.close());
const store = new EventStore(db);
ingestEvents(store, [
  { stream: "health", kind: "steps", data: { count: 4000 }, occurred_at: "2026-07-01T07:00:00Z" },
  { stream: "health", kind: "steps", data: { count: 6000 }, occurred_at: "2026-07-01T18:00:00Z" },
  { stream: "location", kind: "visit", text: "Coffee at Monmouth Coffee", occurred_at: "2026-07-01T08:30:00Z" },
  { stream: "note", kind: "entry", text: "I decided to accept the offer from Acme Corp #career", occurred_at: "2026-07-01T12:00:00Z" },
  { stream: "note", kind: "entry", text: "late night (BST next day)", occurred_at: "2026-07-01T23:30:00Z" },
  { stream: "chat", kind: "message", text: "other day", occurred_at: "2026-07-03T10:00:00Z" },
  { stream: "vault", kind: "pw", text: "hidden", privacy: "secret", occurred_at: "2026-07-01T09:00:00Z" },
]);

test("summarizeDay aggregates streams, metrics, entities, highlights", () => {
  const s = summarizeDay(store, "2026-07-01");
  assert.equal(s.total, 5);
  const health = s.streams.find((x) => x.stream === "health");
  assert.deepEqual(health.metrics["steps.count"], { count: 2, sum: 10000, min: 4000, max: 6000, avg: 5000 });
  assert.ok(s.entities.some((e) => e.entity === "Acme Corp"));
  assert.deepEqual(s.tags, [{ tag: "career", count: 1 }]);
  assert.ok(s.highlights.some((h) => h.summary.includes("decided")));
  assert.ok(!s.timeline.some((t) => t.summary === "hidden"));
});

test("timezone shifts day boundaries", () => {
  const s = summarizeDay(store, "2026-07-01", { timezone: "Europe/London" });
  assert.equal(s.total, 4);
  assert.equal(summarizeDay(store, "2026-07-02", { timezone: "Europe/London" }).total, 1);
});

test("week summary + render", () => {
  assert.equal(weekStart("2026-07-01"), "2026-06-29");
  assert.equal(weekStart("2026-07-05"), "2026-06-29");
  const w = summarizeWeek(store, "2026-07-03");
  assert.equal(w.label, "2026-W27");
  assert.equal(w.total, 6);
  const md = renderDigestMarkdown(w);
  assert.match(md, /^---\ntype: digest/);
  assert.match(md, /### 2026-07-03/);
  assert.match(md, /steps.count: sum 10000/);
  assert.match(renderTimelineText(w), /location\/visit/);
  assert.match(renderDigestMarkdown(summarizeDay(store, "2020-01-01")), /No events recorded/);
});

test("eventSummary + resolveDate", () => {
  assert.equal(eventSummary({ text: null, data: { bpm: 60, nested: {} }, kind: "hr" }), "bpm=60");
  assert.equal(eventSummary({ text: "  a\n b ", data: null, kind: "x" }), "a b");
  assert.equal(resolveDate("2026-01-02", "UTC"), "2026-01-02");
  assert.match(resolveDate("yesterday", "UTC"), /^\d{4}-\d{2}-\d{2}$/);
  assert.throws(() => resolveDate("nope", "UTC"));
});
