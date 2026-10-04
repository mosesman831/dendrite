import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { dist } from "./helpers.mjs";

const { EventStore } = await dist("events/store.js");
const { ingestEvents, DEFAULT_INGEST_OPTIONS } = await dist("events/ingest.js");
const { pruneNoiseEntities } = await dist("events/aliases.js");

test("pruneNoiseEntities: dry run lists, apply removes only noise (exact case), keeps real names", () => {
  const store = new EventStore(new Database(":memory:"));
  ingestEvents(store, [
    { stream: "note", kind: "n", text: "x one", occurred_at: "2026-10-01T00:00:00Z", entities: ["Deep", "Ines"] },
    { stream: "note", kind: "n", text: "x two", occurred_at: "2026-10-02T00:00:00Z", entities: ["Deep", "Planning"] },
    { stream: "note", kind: "n", text: "x three", occurred_at: "2026-10-03T00:00:00Z", entities: ["deep"] },
  ], DEFAULT_INGEST_OPTIONS);
  assert.deepEqual(pruneNoiseEntities(store), [{ entity: "Deep", events: 2 }, { entity: "Planning", events: 1 }]);
  assert.equal(store.query({ entity: "Deep" }).events.length, 3);
  pruneNoiseEntities(store, { apply: true });
  assert.deepEqual(pruneNoiseEntities(store), []);
  const all = store.query({ order: "asc" }).events.map((e) => e.entities);
  assert.deepEqual(all, [["Ines"], [], ["deep"]]);
  assert.equal(store.query({ entity: "Ines" }).events.length, 1);
});
