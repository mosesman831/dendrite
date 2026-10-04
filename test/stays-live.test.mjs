import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { dist } from "./helpers.mjs";

const { EventStore } = await dist("events/store.js");
const { ingestEvents, DEFAULT_INGEST_OPTIONS } = await dist("events/ingest.js");
const { deriveLiveStays } = await dist("events/stays.js");

test("live stays: closed stays only, named by place, privacy inherited, idempotent", () => {
  const store = new EventStore(new Database(":memory:"));
  const places = [{ name: "Home", lat: 51.5, lon: -0.12, radius_m: 150, privacy: "sensitive" }];
  const opts = { ...DEFAULT_INGEST_OPTIONS, places };
  const pt = (m, lat, lon) => ({ stream: "location", kind: "point", lat, lon, data: { acc: 5 }, occurred_at: new Date(Date.parse("2026-10-03T07:00:00Z") + m * 60_000).toISOString() });
  // 40 min at home, then 30 min at a café (still there)
  const pts = [];
  for (let m = 0; m <= 40; m += 5) pts.push(pt(m, 51.5 + m * 1e-6, -0.12));
  for (let m = 60; m <= 90; m += 5) pts.push(pt(m, 51.53, -0.1));
  ingestEvents(store, pts, opts);
  const r = deriveLiveStays(store, { from: "2026-10-03T00:00:00Z", places }, opts);
  assert.equal(r.created, 1);
  const stays = store.query({ stream: ["location"], kind: "stay", maxPrivacy: "sensitive", limit: 10 }).events;
  assert.equal(stays.length, 1);
  assert.equal(stays[0].text, "At Home for ~40 min");
  assert.equal(stays[0].privacy, "sensitive");
  assert.deepEqual(stays[0].entities.includes("Home"), true);
  assert.equal(deriveLiveStays(store, { from: "2026-10-03T00:00:00Z", places }, opts).created, 0);
  // leave the café → its stay closes
  ingestEvents(store, [pt(120, 51.6, -0.2)], opts);
  assert.equal(deriveLiveStays(store, { from: "2026-10-03T00:00:00Z", places }, opts).created, 1);
});
