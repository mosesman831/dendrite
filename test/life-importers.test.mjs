import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { dist } from "./helpers.mjs";

const L = await dist("events/importers-life.js");
const { detectFormat } = await dist("events/importers.js");
const { importPath } = await dist("commands/import.js");
const { EventStore } = await dist("events/store.js");
const { DEFAULT_INGEST_OPTIONS } = await dist("events/ingest.js");

const tmp = mkdtempSync(join(tmpdir(), "dendrite-life-"));
const db = new Database(":memory:");
const store = new EventStore(db);
after(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

const HEALTH = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE HealthData [ <!ELEMENT HealthData (Record*)> ]>
<HealthData locale="en_GB">
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="Moses&apos;s iPhone" unit="count" creationDate="2026-10-01 09:00:00 +0100" startDate="2026-10-01 08:00:00 +0100" endDate="2026-10-01 08:30:00 +0100" value="1234"/>
 <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Watch" unit="count/min" startDate="2026-10-01 08:05:00 +0100" endDate="2026-10-01 08:05:00 +0100" value="72">
  <MetadataEntry key="HKMetadataKeyHeartRateMotionContext" value="1"/>
 </Record>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Watch" startDate="2026-09-30 23:00:00 +0100" endDate="2026-10-01 07:00:00 +0100" value="HKCategoryValueSleepAnalysisAsleepCore"/>
 <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30.5" durationUnit="min" totalDistance="5.2" totalDistanceUnit="km" sourceName="Watch" startDate="2026-10-01 18:00:00 +0100" endDate="2026-10-01 18:30:30 +0100"/>
 <ActivitySummary dateComponents="2026-10-01" activeEnergyBurned="450.5" appleExerciseTime="35" appleStandHours="10"/>
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" unit="count" startDate="2020-01-01 08:00:00 +0000" endDate="2020-01-01 08:30:00 +0000" value="5"/>
</HealthData>
`;

test("apple health helpers", () => {
  assert.equal(L.appleDate("2026-10-01 08:00:00 +0100"), "2026-10-01T08:00:00+01:00");
  assert.equal(L.appleKind("HKQuantityTypeIdentifierStepCount"), "step_count");
  assert.equal(L.appleKind("HKQuantityTypeIdentifierHeartRateVariabilitySDNN"), "heart_rate_variability_sdnn");
  assert.equal(L.appleKind("HKWorkoutActivityTypeRunning"), "running");
  const hr = L.appleHealthLine(' <Record type="HKQuantityTypeIdentifierHeartRate" unit="count/min" startDate="2026-10-01 08:05:00 +0100" endDate="2026-10-01 08:05:00 +0100" value="72">');
  assert.equal(hr.kind, "heart_rate");
  assert.equal(hr.data.value, 72);
  assert.equal(hr.ended_at, undefined);
  assert.equal(L.appleHealthLine("<MetadataEntry key='x'/>"), null);
});

test("apple health streaming import: filters, workouts, summaries, idempotent", async () => {
  const p = join(tmp, "export.xml");
  writeFileSync(p, HEALTH);
  assert.equal(detectFormat(p, HEALTH.slice(0, 4096)), "apple-health");
  let s = await importPath(store, p, DEFAULT_INGEST_OPTIONS, { since: "2026-01-01" });
  assert.equal(s.format, "apple-health");
  assert.equal(s.accepted, 5);
  const steps = store.query({ stream: "health", kind: "step_count", maxPrivacy: "secret" }).events;
  assert.equal(steps.length, 1);
  assert.equal(steps[0].data.value, 1234);
  assert.equal(steps[0].data.device, "Moses's iPhone");
  assert.equal(steps[0].privacy, "sensitive");
  const sleep = store.query({ kind: "sleep_analysis", maxPrivacy: "secret" }).events[0];
  assert.equal(sleep.data.value, "SleepAnalysisAsleepCore");
  const run = store.query({ stream: "fitness" }).events[0];
  assert.equal(run.kind, "workout_running");
  assert.equal(run.data.distance, 5.2);
  assert.equal(store.query({ kind: "activity_summary", maxPrivacy: "secret" }).events[0].data.appleExerciseTime, 35);
  s = await importPath(store, p, DEFAULT_INGEST_OPTIONS, { since: "2026-01-01" });
  assert.equal(s.accepted, 0);
  assert.equal(s.duplicates, 5);
  s = await importPath(store, p, { ...DEFAULT_INGEST_OPTIONS, maxBatch: 2 }, { types: ["step_count"] });
  assert.equal(s.parsed, 2);
  assert.equal(s.accepted, 1);
});

test("takeout: Records.json points, semantic history, on-device timeline", () => {
  const rec = L.parseTakeoutLocation({
    locations: [
      { latitudeE7: 515007000, longitudeE7: -1246000, timestamp: "2026-10-01T08:00:00Z", accuracy: 10 },
      { latitudeE7: 515008000, longitudeE7: -1247000, timestamp: "2026-10-01T08:00:20Z" },
      { latitudeE7: 515009000, longitudeE7: -1248000, timestampMs: String(Date.parse("2026-10-01T08:02:00Z")) },
      { latitudeE7: 1 },
    ],
  });
  assert.equal(rec.items.length, 2);
  assert.equal(rec.items[0].lat, 51.5007);
  assert.equal(rec.errors.length, 1);

  const sem = L.parseTakeoutLocation({
    timelineObjects: [
      { placeVisit: { location: { name: "British Museum", address: "Great Russell St", latitudeE7: 515194000, longitudeE7: -1270000, placeId: "P1" }, duration: { startTimestamp: "2026-10-01T10:00:00Z", endTimestamp: "2026-10-01T12:00:00Z" } } },
      { activitySegment: { activityType: "IN_BUS", distance: 3200, duration: { startTimestamp: "2026-10-01T12:05:00Z", endTimestamp: "2026-10-01T12:30:00Z" } } },
    ],
  });
  assert.equal(sem.items[0].kind, "visit");
  assert.equal(sem.items[0].text, "Visited British Museum (Great Russell St)");
  assert.deepEqual(sem.items[0].entities, ["British Museum"]);
  assert.equal(sem.items[0].external_id, "P1@2026-10-01T10:00:00Z");
  assert.equal(sem.items[1].stream, "movement");
  assert.equal(sem.items[1].kind, "in_bus");

  assert.deepEqual(L.parseLatLng("51.5007°, -0.1246°"), [51.5007, -0.1246]);
  const dev = L.parseTakeoutLocation({
    semanticSegments: [
      { startTime: "2026-10-01T10:00:00.000+01:00", endTime: "2026-10-01T11:00:00.000+01:00", visit: { topCandidate: { placeId: "Q", semanticType: "HOME", placeLocation: { latLng: "51.5°, -0.1°" } } } },
      { startTime: "2026-10-01T11:00:00.000+01:00", endTime: "2026-10-01T11:20:00.000+01:00", activity: { distanceMeters: 900, topCandidate: { type: "WALKING" } } },
      { startTime: "2026-10-01T11:00:00.000+01:00", timelinePath: [{ point: "51.5°, -0.1°", time: "2026-10-01T11:00:00.000+01:00" }, { point: "51.51°, -0.11°", time: "2026-10-01T11:05:00.000+01:00" }] },
    ],
  });
  assert.deepEqual(dev.items.map((i) => `${i.stream}/${i.kind}`), ["location/visit", "movement/walking", "location/point", "location/point"]);
  assert.equal(dev.items[0].text, "Visited home");
  assert.ok(L.isTakeoutLocation({ semanticSegments: [] }));
  assert.ok(!L.isTakeoutLocation({ events: [] }));
});

test("stay detection", () => {
  assert.ok(Math.abs(L.haversineM([51.5, -0.1], [51.501, -0.1]) - 111.2) < 1);
  const pts = [];
  const t0 = Date.parse("2026-10-01T08:00:00Z");
  for (let i = 0; i < 20; i++) pts.push({ t: new Date(t0 + i * 60_000).toISOString(), lat: 51.5 + (i % 2) * 0.0002, lon: -0.1 });
  for (let i = 0; i < 5; i++) pts.push({ t: new Date(t0 + (20 + i) * 60_000).toISOString(), lat: 51.5 + 0.01 * (i + 1), lon: -0.1 });
  for (let i = 0; i < 3; i++) pts.push({ t: new Date(t0 + (25 + i) * 60_000).toISOString(), lat: 52, lon: 0 });
  const stays = L.detectStays(pts, { minMinutes: 10 });
  assert.equal(stays.length, 1);
  assert.equal(stays[0].minutes, 19);
  assert.equal(stays[0].points, 20);
  const ev = L.staysToEvents(stays, "gpx")[0];
  assert.equal(ev.kind, "stay");
  assert.equal(ev.ended_at, "2026-10-01T08:19:00.000Z");
});

test("takeout json via importPath with --stays", async () => {
  const p = join(tmp, "Records.json");
  const locations = [];
  const t0 = Date.parse("2026-10-02T08:00:00Z");
  for (let i = 0; i < 15; i++) locations.push({ latitudeE7: 515000000, longitudeE7: -1000000, timestamp: new Date(t0 + i * 120_000).toISOString() });
  writeFileSync(p, JSON.stringify({ locations }));
  const s = await importPath(store, p, DEFAULT_INGEST_OPTIONS, { stays: true });
  assert.equal(s.accepted, 16);
  const stay = store.query({ kind: "stay" }).events[0];
  assert.equal(stay.data.minutes, 28);
});
