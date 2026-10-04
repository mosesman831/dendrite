import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { dist } from "./helpers.mjs";

const { EventStore } = await dist("events/store.js");
const { ingestEvents, DEFAULT_INGEST_OPTIONS } = await dist("events/ingest.js");
const { buildPrep, renderPrep } = await dist("events/prep.js");

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
