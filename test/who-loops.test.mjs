import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { dist } from "./helpers.mjs";

const { EventStore } = await dist("events/store.js");
const { ingestEvents, DEFAULT_INGEST_OPTIONS } = await dist("events/ingest.js");
const { entityProfile } = await dist("events/recall.js");
const { setLoopStatus, listLoops } = await dist("events/loops.js");

test("entity profile lists active open loops mentioning the person", () => {
  const store = new EventStore(new Database(":memory:"));
  const opts = { ...DEFAULT_INGEST_OPTIONS, loops: { exclude: [], autoResolve: false, timezone: "UTC" } };
  ingestEvents(store, [
    { stream: "note", kind: "m", text: "Remind me to send Oscar the slides by friday", entities: ["Oscar"], occurred_at: "2026-10-01T09:00:00Z" },
    { stream: "note", kind: "m", text: "TODO: book dentist", occurred_at: "2026-10-01T10:00:00Z" },
    { stream: "note", kind: "m", text: "Remind me to ask Oscar about the flat", entities: ["Oscar"], occurred_at: "2026-10-02T09:00:00Z" },
    { stream: "note", kind: "m", text: "Remind me to tell Oscar the secret", entities: ["Oscar"], privacy: "secret", occurred_at: "2026-10-02T10:00:00Z" },
  ], opts);
  const p = entityProfile(store, "oscar");
  assert.equal(p.open_loops.length, 2);
  assert.ok(p.open_loops.every((l) => /Oscar/.test(l.text)));
  assert.ok(p.open_loops[0].due_date, "dated loop sorts first");
  const flat = listLoops(store).find((l) => /flat/.test(l.text));
  setLoopStatus(store, flat.id, "done");
  assert.equal(entityProfile(store, "Oscar").open_loops.length, 1);
});
