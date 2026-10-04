import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { dist } from "./helpers.mjs";

const { EventStore } = await dist("events/store.js");
const { ingestEvents, DEFAULT_INGEST_OPTIONS } = await dist("events/ingest.js");
const { eventLogHealth } = await dist("events/health.js");

test("event log health: counts, integrity, open-API warning", () => {
  const store = new EventStore(new Database(":memory:"));
  const opts = { ...DEFAULT_INGEST_OPTIONS, loops: { exclude: [], autoResolve: false, timezone: "UTC" } };
  ingestEvents(store, [
    { stream: "note", kind: "m", text: "Remind me to water plants", occurred_at: "2026-10-01T09:00:00Z" },
    { stream: "note", kind: "m", text: "hello", occurred_at: "2026-10-02T09:00:00Z" },
  ], opts);
  const h = eventLogHealth(store, { apiKeys: 0 });
  assert.equal(h.events, 2);
  assert.equal(h.oldest, "2026-10-01T09:00:00.000Z");
  assert.equal(h.undistilled, 2);
  assert.equal(h.integrity, "ok");
  assert.equal(h.loops_active, 1);
  assert.ok(h.api_open);
  assert.match(h.warnings.join("\n"), /API is open/);
  assert.equal(eventLogHealth(store, { apiKeys: 1 }).warnings.length, 0);
});
