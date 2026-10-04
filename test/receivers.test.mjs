import { test } from "node:test";
import assert from "node:assert/strict";
import { dist } from "./helpers.mjs";

const { fromOwnTracks, fromOverland, fromHealthAutoExport, looseIso } = await dist("events/receivers.js");

test("looseIso handles HAE offsets and garbage", () => {
  assert.equal(looseIso("2026-10-03 07:00:00 +0100"), "2026-10-03T06:00:00.000Z");
  assert.equal(looseIso("2026-10-03T06:00:00Z"), "2026-10-03T06:00:00.000Z");
  assert.equal(looseIso("nope"), null);
  assert.equal(looseIso(5), null);
});

test("OwnTracks location + transition; ignores other types", () => {
  const ev = fromOwnTracks([
    { _type: "location", lat: 51.5, lon: -0.12, tst: 1790000000, acc: 10, batt: 80, tid: "mo" },
    { _type: "transition", event: "leave", desc: "Office", tst: 1790000100, lat: 51.5, lon: -0.1, tid: "mo" },
    { _type: "waypoint", tst: 1 },
    { _type: "location" },
  ]);
  assert.equal(ev.length, 2);
  assert.deepEqual(ev[0].data, { accuracy: 10, battery: 80, device: "mo" });
  assert.equal(ev[0].external_id, "owntracks:mo:1790000000");
  assert.equal(ev[1].kind, "leave");
  assert.equal(ev[1].text, "Left Office");
});

test("Overland GeoJSON batch", () => {
  const ev = fromOverland({
    locations: [
      { type: "Feature", geometry: { type: "Point", coordinates: [-0.12, 51.5] }, properties: { timestamp: "2026-10-03T06:00:00Z", speed: 1.2, motion: ["walking"], device_id: "iphone" } },
      { type: "Feature", geometry: { type: "LineString", coordinates: [] }, properties: {} },
    ],
  });
  assert.equal(ev.length, 1);
  assert.deepEqual([ev[0].lat, ev[0].lon, ev[0].tags, ev[0].data.speed_ms], [51.5, -0.12, ["walking"], 1.2]);
  assert.deepEqual(fromOverland({}), []);
});

test("Health Auto Export metrics + workouts are sensitive", () => {
  const ev = fromHealthAutoExport({
    data: {
      metrics: [
        { name: "step_count", units: "count", data: [{ date: "2026-10-03 00:00:00 +0100", qty: 8123, source: "iPhone" }] },
        { name: "heart_rate", units: "bpm", data: [{ date: "2026-10-03 08:00:00 +0100", Min: 55, Avg: 70, Max: 120 }] },
      ],
      workouts: [{ id: "w1", name: "Outdoor Run", start: "2026-10-03 07:00:00 +0100", end: "2026-10-03 07:30:00 +0100", duration: 1800, activeEnergyBurned: { qty: 300, units: "kcal" } }],
    },
  });
  assert.equal(ev.length, 3);
  assert.ok(ev.every((e) => e.privacy === "sensitive" && e.stream === "health"));
  assert.deepEqual(ev[0].data, { value: 8123, unit: "count", origin: "iPhone" });
  assert.deepEqual(ev[1].data, { value: 70, unit: "bpm", min: 55, max: 120 });
  assert.equal(ev[2].ended_at, "2026-10-03T06:30:00.000Z");
  assert.deepEqual(ev[2].data, { duration_s: 1800, energy_kcal: 300 });
});
