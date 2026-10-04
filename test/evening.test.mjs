import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { dist } from "./helpers.mjs";

const { EventStore } = await dist("events/store.js");
const { ingestEvents } = await dist("events/ingest.js");
const { trackLoops } = await dist("events/loops.js");
const { buildEvening, renderEvening, parseEveningPrompt } = await dist("events/evening.js");

test("evening recap: today's counts, people, highlights, loops due tomorrow; privacy", () => {
  const store = new EventStore(new Database(":memory:"));
  const r = ingestEvents(store, [
    { stream: "chat", kind: "message", text: "Lunch with Ines at the market", occurred_at: "2026-10-03T12:00:00Z" },
    { stream: "note", kind: "note", text: "I'll send Oscar the deck tomorrow", occurred_at: "2026-10-03T15:00:00Z" },
    { stream: "health", kind: "note", text: "Therapy session", privacy: "sensitive", occurred_at: "2026-10-03T17:00:00Z" },
    { stream: "chat", kind: "message", text: "Yesterday's thing", occurred_at: "2026-10-02T12:00:00Z" },
  ]);
  trackLoops(store, store.query({ limit: 10 }).events, { timezone: "UTC" });
  const e = buildEvening(store, "2026-10-03", { timezone: "UTC" });
  assert.equal(r.accepted, 4);
  assert.equal(e.total, 2);
  assert.ok(e.people.includes("Ines"));
  assert.equal(e.highlights.length, 2);
  assert.deepEqual(e.due_tomorrow, ["send Oscar the deck tomorrow"]);
  const md = renderEvening(e);
  assert.match(md, /How was your day\?/);
  assert.doesNotMatch(md, /Therapy/);
  assert.match(renderEvening(buildEvening(store, "2026-09-01")), /Nothing captured today/);
});

test("parseEveningPrompt recognises the recap it renders", () => {
  const md = renderEvening({ date: "2026-10-03", total: 0, streams: [], people: [], highlights: [], due_tomorrow: [] });
  assert.equal(parseEveningPrompt(md), "2026-10-03");
  assert.equal(parseEveningPrompt("# Evening — 2026-10-03\nunrelated"), null);
  assert.equal(parseEveningPrompt("How was your day?"), null);
});
