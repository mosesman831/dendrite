import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { dist } from "./helpers.mjs";

const { EventStore } = await dist("events/store.js");
const { ingestEvents, DEFAULT_INGEST_OPTIONS } = await dist("events/ingest.js");
const { buildPrep, renderPrep, dueNudges, dueFollowups, renderFollowup } = await dist("events/prep.js");

test("meeting prep: next meeting's people with history + open loops; nothing → message", () => {
  const store = new EventStore(new Database(":memory:"));
  const now = "2026-10-05T10:00:00Z";
  assert.equal(buildPrep(store, { now }).meeting, null);
  assert.match(renderPrep(buildPrep(store, { now })), /No upcoming meeting/);
  ingestEvents(store, [
    { stream: "chat", kind: "message", text: "Ines asked about the grant budget", occurred_at: "2026-09-28T12:00:00Z", entities: ["Ines"] },
    { stream: "note", kind: "note", text: "I'll send Ines the budget draft by friday", occurred_at: "2026-10-01T09:00:00Z", entities: ["Ines"] },
    { stream: "calendar", kind: "cancelled", text: "Cancelled: Sync with Bob", occurred_at: "2026-10-05T11:00:00Z", entities: ["Bob"] },
    { stream: "calendar", kind: "event", text: "Lunch with Ines", occurred_at: "2026-10-05T13:00:00Z", entities: ["Ines"] },
  ], { ...DEFAULT_INGEST_OPTIONS, loops: { exclude: [], autoResolve: false, timezone: "UTC" } });
  const p = buildPrep(store, { now });
  assert.equal(p.meeting.summary.includes("Lunch with Ines"), true);
  assert.equal(p.people.length, 1);
  assert.equal(p.people[0].entity, "Ines");
  assert.equal(p.people[0].last_at, "2026-10-01T09:00:00.000Z");
  assert.equal(p.people[0].recent.length, 2);
  assert.ok(p.people[0].open_loops.some((l) => /budget draft/.test(l.text)));
  const md = renderPrep(p);
  assert.match(md, /# Prep — .*Lunch with Ines/);
  assert.match(md, /## Ines/);
  assert.match(md, /- \[ \] .*budget draft/);
  assert.equal(buildPrep(store, { now, eventId: "nope" }).meeting, null);
});

test("dueNudges: once per entry within the window; privacy respected for explicit ids", () => {
  const store = new EventStore(new Database(":memory:"));
  ingestEvents(store, [
    { stream: "calendar", kind: "event", text: "Call with Oscar", occurred_at: "2026-10-05T10:10:00Z", entities: ["Oscar"] },
    { stream: "calendar", kind: "event", text: "Therapy", occurred_at: "2026-10-05T10:12:00Z", privacy: "secret" },
    { stream: "calendar", kind: "event", text: "Dinner with Ines", occurred_at: "2026-10-05T19:00:00Z", entities: ["Ines"] },
  ], DEFAULT_INGEST_OPTIONS);
  const sent = new Set();
  const now = "2026-10-05T10:00:00Z";
  const first = dueNudges(store, { now, minutes: 15, sent });
  assert.equal(first.length, 1);
  assert.match(first[0].meeting.summary, /Oscar/);
  assert.equal(dueNudges(store, { now, minutes: 15, sent }).length, 0);
  const secret = store.query({ stream: "calendar", maxPrivacy: "secret", q: "Therapy" }).events[0];
  assert.equal(buildPrep(store, { now, eventId: secret.id }).meeting, null);
});

test("dueFollowups: recently ended entries with people, once each", () => {
  const store = new EventStore(new Database(":memory:"));
  ingestEvents(store, [
    { stream: "calendar", kind: "event", text: "Call with Oscar", occurred_at: "2026-10-05T09:00:00Z", ended_at: "2026-10-05T09:50:00Z", entities: ["Oscar"] },
    { stream: "calendar", kind: "event", text: "focus block", occurred_at: "2026-10-05T09:00:00Z", ended_at: "2026-10-05T09:55:00Z" },
    { stream: "calendar", kind: "event", text: "Old sync with Ines", occurred_at: "2026-10-05T07:00:00Z", ended_at: "2026-10-05T08:00:00Z", entities: ["Ines"] },
    { stream: "calendar", kind: "event", text: "Later with Ines", occurred_at: "2026-10-05T11:00:00Z", ended_at: "2026-10-05T12:00:00Z", entities: ["Ines"] },
  ], DEFAULT_INGEST_OPTIONS);
  const sent = new Set();
  const now = "2026-10-05T10:00:00Z";
  const f = dueFollowups(store, { now, minutes: 30, sent });
  assert.deepEqual(f.map((x) => x.entities), [["Oscar"]]);
  assert.match(renderFollowup(f[0]), /How did .*Call with Oscar.* go\?.*Oscar/);
  assert.equal(dueFollowups(store, { now, minutes: 30, sent }).length, 0);
});
