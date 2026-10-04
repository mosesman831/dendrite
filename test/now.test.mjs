import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { dist } from "./helpers.mjs";

const { EventStore } = await dist("events/store.js");
const { ingestEvents, DEFAULT_INGEST_OPTIONS } = await dist("events/ingest.js");
const { buildNow, renderNow } = await dist("events/now.js");

test("now snapshot: place, due loops, habits, recent; secret + future excluded", () => {
  const store = new EventStore(new Database(":memory:"));
  const opts = { ...DEFAULT_INGEST_OPTIONS, loops: { exclude: [], autoResolve: true, timezone: "UTC" } };
  ingestEvents(store, [
    { stream: "location", kind: "point", lat: 51.5, lon: -0.12, data: { a: 1 }, occurred_at: "2026-10-04T07:30:00Z" },
    { stream: "note", kind: "m", text: "Remind me to pay rent today", occurred_at: "2026-10-04T07:00:00Z" },
    { stream: "note", kind: "m", text: "secret diary line", privacy: "secret", occurred_at: "2026-10-04T07:40:00Z" },
    { stream: "note", kind: "m", text: "future plan", occurred_at: "2026-10-05T07:40:00Z" },
  ], opts);
  const places = [{ name: "Home", lat: 51.5, lon: -0.12, radius_m: 100 }];
  const n = buildNow(store, { now: "2026-10-04T08:00:00Z", places, habits: [{ name: "gym", every_days: 2 }] });
  assert.equal(n.where.place, "Home");
  assert.deepEqual(n.loops_due.map((l) => l.due_date), ["2026-10-04"]);
  assert.deepEqual(n.habits_due, ["gym"]);
  assert.equal(n.recent.length, 2);
  const md = renderNow(n);
  assert.match(md, /\*\*Where:\*\* Home/);
  assert.doesNotMatch(md, /secret diary|future plan/);
});

test("now snapshot: last_here recalls earlier events at the current place", () => {
  const store = new EventStore(new Database(":memory:"));
  ingestEvents(store, [
    { stream: "note", kind: "m", text: "Great flat white, met Ines here", entities: ["Blue Cafe"], occurred_at: "2026-09-20T10:00:00Z" },
    { stream: "note", kind: "m", text: "secret at cafe", entities: ["Blue Cafe"], privacy: "secret", occurred_at: "2026-09-21T10:00:00Z" },
    { stream: "location", kind: "point", lat: 40.0, lon: -3.0, data: { a: 1 }, occurred_at: "2026-10-04T07:50:00Z" },
  ], DEFAULT_INGEST_OPTIONS);
  const places = [{ name: "Blue Cafe", lat: 40.0, lon: -3.0, radius_m: 50 }];
  const n = buildNow(store, { now: "2026-10-04T08:00:00Z", places });
  assert.equal(n.where.place, "Blue Cafe");
  assert.deepEqual(n.last_here.map((e) => e.summary), ["Great flat white, met Ines here"]);
  assert.match(renderNow(n), /\*\*Last time at Blue Cafe:\*\*\n- 2026-09-20 \[note\] Great flat white/);
  assert.deepEqual(buildNow(store, { now: "2026-10-04T08:00:00Z" }).last_here, []);
});
