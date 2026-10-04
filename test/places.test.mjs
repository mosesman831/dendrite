import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { dist } from "./helpers.mjs";

const { EventStore } = await dist("events/store.js");
const { ingestEvents, DEFAULT_INGEST_OPTIONS } = await dist("events/ingest.js");
const { matchPlace, distanceM, backfillPlaces, placeVisits } = await dist("events/places.js");

const places = [
  { name: "Home", lat: 51.5, lon: -0.12, radius_m: 100, privacy: "sensitive" },
  { name: "Office", lat: 51.52, lon: -0.08, radius_m: 200 },
];

test("distance + nearest match within radius", () => {
  assert.ok(Math.abs(distanceM(51.5, -0.12, 51.5009, -0.12) - 100) < 1);
  assert.equal(matchPlace(51.5005, -0.12, places)?.name, "Home");
  assert.equal(matchPlace(51.51, -0.1, places), null);
  assert.equal(matchPlace(null, 1, places), null);
});

test("ingest tags geo events with place entity, tag and privacy; backfill catches old events", () => {
  const store = new EventStore(new Database(":memory:"));
  const pt = (lat, lon, h) => ({ stream: "location", kind: "point", lat, lon, data: { accuracy: 5 }, occurred_at: `2026-10-03T${h}:00:00Z` });
  ingestEvents(store, [pt(51.5001, -0.1201, "07"), pt(51.52, -0.0801, "10"), pt(10, 10, "12")], { ...DEFAULT_INGEST_OPTIONS, places });
  const evs = store.query({ stream: ["location"], maxPrivacy: "sensitive", limit: 10 }).events;
  const home = evs.find((e) => e.occurred_at.startsWith("2026-10-03T07"));
  assert.deepEqual([home.entities, home.tags, home.privacy], [["Home"], ["at:home"], "sensitive"]);
  assert.equal(evs.find((e) => e.occurred_at.startsWith("2026-10-03T10")).entities[0], "Office");

  ingestEvents(store, [pt(51.52, -0.08, "15")], DEFAULT_INGEST_OPTIONS); // ingested before Office existed
  assert.equal(backfillPlaces(store, places), 1);
  assert.equal(backfillPlaces(store, places), 0);
  assert.deepEqual(placeVisits(store, places).map((v) => [v.name, v.events]), [["Home", 1], ["Office", 2]]);
  assert.equal(store.query({ q: "Office", maxPrivacy: "normal", limit: 10 }).events.length, 2);
});
