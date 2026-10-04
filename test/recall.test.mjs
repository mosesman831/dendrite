import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { dist } from "./helpers.mjs";

const { recall, entityProfile } = await dist("events/recall.js");
const { EventStore } = await dist("events/store.js");
const { ingestEvents } = await dist("events/ingest.js");

const db = new Database(":memory:");
const s = new EventStore(db);
ingestEvents(s, [
  { stream: "location", kind: "visit", text: "Arrived at Riverside Cafe", occurred_at: "2026-10-01T09:50:00Z", entities: ["Riverside Cafe"] },
  { stream: "chat", kind: "message", text: "Coffee with Ada about the robotics grant", occurred_at: "2026-10-01T10:00:00Z", entities: ["Ada", "Riverside Cafe"], importance: 0.9 },
  { stream: "health", kind: "hr", data: { bpm: 80 }, occurred_at: "2026-10-01T10:10:00Z" },
  { stream: "chat", kind: "message", text: "Ada sent the grant draft", occurred_at: "2026-10-03T18:00:00Z", entities: ["Ada"] },
  { stream: "note", kind: "entry", text: "Ada secret thing", occurred_at: "2026-10-03T19:00:00Z", entities: ["Ada"], privacy: "secret" },
  { stream: "note", kind: "entry", text: "unrelated", occurred_at: "2026-10-02T12:00:00Z" },
]);

test("recall search: hits with surrounding context, secret hidden", () => {
  const p = recall(s, { q: "grant" });
  assert.equal(p.mode, "search");
  assert.equal(p.hits.length, 2);
  assert.equal(p.hits[0].event.text, "Ada sent the grant draft");
  const cafe = p.hits[1];
  assert.deepEqual(cafe.context.map((c) => c.stream), ["location", "health"]);
  assert.match(p.markdown, /\[chat\/message\] Coffee with Ada/);
  assert.match(p.markdown, /^ {2}- .*\[health\/hr\]/m);
  assert.ok(!p.markdown.includes("secret thing"));
  assert.equal(p.entities[0].entity, "Ada");
  assert.equal(recall(s, { q: "grant", contextMin: 0 }).hits[1].context.length, 0);
});

test("recall around a time", () => {
  const p = recall(s, { at: "2026-10-01T10:00:00Z", windowMin: 15 });
  assert.equal(p.mode, "around");
  assert.deepEqual(p.hits.map((h) => h.event.stream), ["location", "chat", "health"]);
  assert.equal(p.range.from, "2026-10-01T09:45:00.000Z");
  assert.throws(() => recall(s, {}), /needs q, entity, or at/);
});

test("entityProfile", () => {
  const p = entityProfile(s, "ada");
  assert.equal(p.count, 2);
  assert.equal(p.first_at, "2026-10-01T10:00:00.000Z");
  assert.deepEqual(p.streams, [{ stream: "chat", count: 2 }]);
  assert.ok(p.related.some((r) => r.entity === "Riverside Cafe" && r.count === 1));
  assert.equal(p.recent.length, 2);
  assert.equal(entityProfile(s, "ada", { maxPrivacy: "secret" }).count, 3);
  assert.equal(entityProfile(s, "nobody").count, 0);
});
