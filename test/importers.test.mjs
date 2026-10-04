import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readdirSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { dist } from "./helpers.mjs";

const { parseIcs, parseGpx, parseCsv, parseCsvRows, parseGitLog, detectFormat, icsTime } = await dist("events/importers.js");
const { importPath } = await dist("commands/import.js");
const { EventStore } = await dist("events/store.js");
const { DEFAULT_INGEST_OPTIONS } = await dist("events/ingest.js");

const tmp = mkdtempSync(join(tmpdir(), "dendrite-imp-"));
const db = new Database(":memory:");
after(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});
const store = new EventStore(db);

const ICS = `BEGIN:VCALENDAR\r
BEGIN:VEVENT\r
UID:abc@x\r
DTSTART:20261005T090000Z\r
DTEND:20261005T100000Z\r
SUMMARY:Standup with Jane\\, Bob\r
LOCATION:Room 4\r
DESCRIPTION:line one\\nline\r
  two\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:allday\r
DTSTART;VALUE=DATE:20261006\r
SUMMARY:Holiday\r
END:VEVENT\r
BEGIN:VEVENT\r
SUMMARY:broken\r
END:VEVENT\r
END:VCALENDAR\r
`;

test("ics parsing: unfolding, escaping, all-day, errors", () => {
  assert.equal(icsTime("20261005T090000Z"), "2026-10-05T09:00:00.000Z");
  assert.equal(icsTime("20261006"), "2026-10-06T00:00:00.000Z");
  const r = parseIcs(ICS);
  assert.equal(r.items.length, 2);
  assert.equal(r.errors.length, 1);
  const [a, b] = r.items;
  assert.equal(a.stream, "calendar");
  assert.equal(a.external_id, "abc@x");
  assert.equal(a.data.summary, "Standup with Jane, Bob");
  assert.match(a.text, /line one\nline two/);
  assert.equal(a.ended_at, "2026-10-05T10:00:00.000Z");
  assert.equal(b.data.all_day, true);
});

test("gpx parsing with downsampling + waypoints", () => {
  const gpx = `<?xml version="1.0"?><gpx><wpt lat="51.5" lon="-0.1"><name>Home</name></wpt><trk><trkseg>
    <trkpt lat="51.50" lon="-0.10"><ele>10</ele><time>2026-10-03T08:00:00Z</time></trkpt>
    <trkpt lat="51.51" lon="-0.11"><time>2026-10-03T08:00:30Z</time></trkpt>
    <trkpt lat="51.52" lon="-0.12"><time>2026-10-03T08:01:05Z</time></trkpt>
    <trkpt lat="x" lon="-0.12"><time>2026-10-03T08:05:00Z</time></trkpt>
  </trkseg></trk></gpx>`;
  const r = parseGpx(gpx);
  assert.equal(r.items.length, 3);
  assert.equal(r.items[0].kind, "waypoint");
  assert.equal(r.items[0].text, "Home");
  assert.equal(r.items[1].data.ele, 10);
  assert.equal(r.errors.length, 1);
  assert.equal(parseGpx(gpx, { minIntervalSec: 1 }).items.length, 4);
});

test("csv parsing: quoting, numbers, reserved columns", () => {
  assert.deepEqual(parseCsvRows('a,"b ""q"", c"\r\n1,2\n'), [["a", 'b "q", c'], ["1", "2"]]);
  const r = parseCsv(
    "Date,Steps,Heart Rate,Note,id\n2026-10-01,9000,61,\"ran, fast\",r1\n2026-10-02,,,,\n2026-10-03,100,0x1F,,r3\n",
    { stream: "health", kind: "daily" },
  );
  assert.equal(r.items.length, 2);
  assert.deepEqual(r.items[0].data, { steps: 9000, heart_rate: 61 });
  assert.equal(r.items[0].text, "ran, fast");
  assert.equal(r.items[0].external_id, "r1");
  assert.equal(r.items[1].data.heart_rate, "0x1F");
  assert.equal(r.errors[0].error, "empty row");
  assert.match(parseCsv("a,b\n1,2").errors[0].error, /no time column/);
});

test("git log parsing", () => {
  const out = "\u001eabc\u001fAnn\u001fa@x\u001f2026-10-01T10:00:00+01:00\u001ffix: thing\u001fbody text\n\u001edef\u001fBo\u001fb@x\u001f2026-10-02T10:00:00Z\u001ffeat\u001f\n";
  const r = parseGitLog(out, "dendrite");
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0].external_id, "abc");
  assert.match(r.items[0].text, /^dendrite: fix: thing\n\nbody text$/);
});

test("detectFormat", () => {
  assert.equal(detectFormat("a.ics"), "ics");
  assert.equal(detectFormat("a.jsonl"), "ndjson");
  assert.equal(detectFormat("dump", "BEGIN:VCALENDAR\n"), "ics");
  assert.equal(detectFormat("dump", '{"a":1}\n{"b":2}'), "ndjson");
  assert.equal(detectFormat("dump", "[1]"), "json");
});

test("importPath end-to-end: files + git repo, idempotent", () => {
  const ics = join(tmp, "cal.ics");
  writeFileSync(ics, ICS);
  let s = importPath(store, ics, DEFAULT_INGEST_OPTIONS);
  assert.equal(s.format, "ics");
  assert.equal(s.accepted, 2);
  assert.equal(s.rejected, 1);
  s = importPath(store, ics, DEFAULT_INGEST_OPTIONS);
  assert.equal(s.accepted, 0);
  assert.equal(s.duplicates, 2);

  const repo = join(tmp, "repo");
  execFileSync("git", ["init", "-q", repo]);
  const g = (...a) => execFileSync("git", ["-C", repo, "-c", "user.name=T", "-c", "user.email=t@x", ...a]);
  g("commit", "-q", "--allow-empty", "-m", "first");
  g("commit", "-q", "--allow-empty", "-m", "second");
  s = importPath(store, repo, { ...DEFAULT_INGEST_OPTIONS, maxBatch: 1 });
  assert.equal(s.format, "git");
  assert.equal(s.accepted, 2);
  assert.equal(store.query({ stream: "git" }).events[0].text, "repo: second");
  assert.throws(() => importPath(store, tmp, DEFAULT_INGEST_OPTIONS), /not a git repository/);
});

test("drop folder sweep moves files", async () => {
  const { sweepDropFolder } = await dist("inputs/drop-folder.js");
  const drop = join(tmp, "drop");
  const fakeIndex = { events: store };
  const config = { events: { max_batch: 100, default_source: "drop", stream_weights: {} }, privacy: { redact_at_rest: true, rules: [], custom_rules: [], streams: {} } };
  sweepDropFolder(drop, fakeIndex, config);
  writeFileSync(join(drop, "a.ndjson"), '{"stream":"note","kind":"x","text":"dropped one"}\n');
  writeFileSync(join(drop, "bad.json"), "{nope");
  writeFileSync(join(drop, "fresh.json"), "[]");
  const old = new Date(Date.now() - 60_000);
  utimesSync(join(drop, "a.ndjson"), old, old);
  utimesSync(join(drop, "bad.json"), old, old);
  assert.equal(sweepDropFolder(drop, fakeIndex, config), 2);
  assert.ok(existsSync(join(drop, "fresh.json")));
  assert.equal(readdirSync(join(drop, "processed")).length, 1);
  assert.equal(readdirSync(join(drop, "failed")).length, 2);
  assert.equal(store.query({ q: "dropped" }).events.length, 1);
});
