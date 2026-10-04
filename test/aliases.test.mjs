import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { dist } from "./helpers.mjs";

const { EventStore } = await dist("events/store.js");
const { ingestEvents, DEFAULT_INGEST_OPTIONS } = await dist("events/ingest.js");
const { applyAliases, aliasUsage } = await dist("events/aliases.js");

const aliases = { "Priya Shah": ["Priya", "P. Shah"] };
const ev = (text, h) => ({ stream: "note", kind: "m", text, occurred_at: `2026-10-03T0${h}:00:00Z` });

test("aliases collapse at ingest and via backfill", () => {
  const store = new EventStore(new Database(":memory:"));
  ingestEvents(store, [ev("Lunch with Priya at noon", 1)], DEFAULT_INGEST_OPTIONS);
  ingestEvents(store, [ev("Coffee with Priya today", 2)], { ...DEFAULT_INGEST_OPTIONS, aliases });
  const byEnt = () => store.query({ entity: "Priya Shah", limit: 10 }).events.length;
  assert.equal(byEnt(), 1);
  assert.deepEqual(aliasUsage(store, aliases).map((u) => u.events), [1, 0]);
  assert.equal(applyAliases(store, aliases), 1);
  assert.equal(byEnt(), 2);
  assert.equal(store.query({ entity: "Priya", limit: 10 }).events.length, 0);
  assert.equal(applyAliases(store, aliases), 0);
  assert.equal(store.query({ q: "Shah", limit: 10 }).events.length, 2);
});
