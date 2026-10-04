import { test, after } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { dist } from "./helpers.mjs";

const { normalizeTime, dayRange, isoWeek, localDate, addDays } = await dist("events/time.js");
const { eventId, canonicalJson, contentHash } = await dist("events/ids.js");
const { extractEntities, redactText, compileRedactRules, scoreImportance } = await dist("events/enrich.js");
const { EventStore, toFtsQuery, encodeCursor, decodeCursor } = await dist("events/store.js");
const { prepareEvent, ingestEvents, parseNdjson, DEFAULT_INGEST_OPTIONS } = await dist("events/ingest.js");

const dbs = [];
const store = () => {
  const db = new Database(":memory:");
  dbs.push(db);
  return new EventStore(db);
};
after(() => dbs.forEach((d) => d.close()));

test("normalizeTime handles ISO, offsets, epoch s/ms, naive, date-only", () => {
  assert.equal(normalizeTime("2026-10-04T10:00:00+01:00"), "2026-10-04T09:00:00.000Z");
  assert.equal(normalizeTime(1791100800), "2026-10-04T08:00:00.000Z");
  assert.equal(normalizeTime(1791100800000), "2026-10-04T08:00:00.000Z");
  assert.equal(normalizeTime("1791100800"), "2026-10-04T08:00:00.000Z");
  assert.equal(normalizeTime("2026-10-04 08:30"), "2026-10-04T08:30:00.000Z");
  assert.equal(normalizeTime("2026-10-04"), "2026-10-04T00:00:00.000Z");
  assert.equal(normalizeTime("not a date"), null);
  assert.equal(normalizeTime(""), null);
  assert.equal(normalizeTime("1500-01-01"), null);
});

test("dayRange respects timezone (BST)", () => {
  const r = dayRange("2026-07-01", "Europe/London");
  assert.equal(r.from, "2026-06-30T23:00:00.000Z");
  assert.equal(r.to, "2026-07-01T23:00:00.000Z");
  assert.deepEqual(dayRange("2026-07-01"), { from: "2026-07-01T00:00:00.000Z", to: "2026-07-02T00:00:00.000Z" });
  assert.equal(localDate("2026-06-30T23:30:00Z", "Europe/London"), "2026-07-01");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(isoWeek("2026-10-04"), "2026-W40");
  assert.equal(isoWeek("2027-01-01"), "2026-W53");
});

test("eventId is time-sortable and unique", () => {
  const a = eventId(1000);
  const b = eventId(2000);
  assert.equal(a.length, 26);
  assert.ok(a < b);
  assert.notEqual(eventId(1000), eventId(1000));
});

test("canonicalJson + contentHash are key-order independent", () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] }), canonicalJson({ a: [2, { c: 2, d: 1 }], b: 1 }));
  const base = { stream: "s", kind: "k", occurred_at: "2026-01-01T00:00:00.000Z" };
  assert.equal(contentHash({ ...base, data: { x: 1, y: 2 } }), contentHash({ ...base, data: { y: 2, x: 1 } }));
  assert.notEqual(contentHash({ ...base, text: "a" }), contentHash({ ...base, text: "b" }));
});

test("extractEntities finds handles, tags, domains, proper nouns", () => {
  const { entities, tags } = extractEntities(
    "Met Sarah Connor at Riverside Academy with @jdoe about #rust-lang. See https://www.github.com/x. Then lunch.",
  );
  assert.ok(entities.includes("Sarah Connor"), entities.join("|"));
  assert.ok(entities.includes("Riverside Academy"));
  assert.ok(entities.includes("@jdoe"));
  assert.ok(entities.includes("github.com"));
  assert.ok(!entities.includes("Then"));
  assert.deepEqual(tags, ["rust-lang"]);
});

test("redaction: api keys, bearer, luhn-valid cards only", () => {
  const rules = compileRedactRules(["api_key", "bearer", "credit_card", "email"]);
  const r = redactText(
    "key sk-abcdefghijklmnopqrstuvwx card 4111 1111 1111 1111 not 1234 5678 9012 3456 mail a@b.co",
    rules,
  );
  assert.match(r.text, /\[REDACTED:api_key\]/);
  assert.match(r.text, /\[REDACTED:credit_card\]/);
  assert.match(r.text, /1234 5678 9012 3456/);
  assert.match(r.text, /\[REDACTED:email\]/);
  assert.equal(r.redactions, 3);
});

test("scoreImportance uses stream weights + salience + override", () => {
  assert.ok(scoreImportance({ stream: "note", text: "I decided to move to Berlin" }) > scoreImportance({ stream: "note", text: "lunch" }));
  assert.ok(scoreImportance({ stream: "browser", text: "x" }) < scoreImportance({ stream: "note", text: "x" }));
  assert.equal(scoreImportance({ stream: "browser", text: "x", importance: 0.9 }), 0.9);
});

test("prepareEvent validates and normalizes", () => {
  const e = prepareEvent({ stream: "Health", kind: "heart_rate", occurred_at: 1791100800, data: { bpm: 61 } });
  assert.equal(e.stream, "health");
  assert.equal(e.privacy, "sensitive");
  assert.equal(e.occurred_at, "2026-10-04T08:00:00.000Z");
  assert.throws(() => prepareEvent({ stream: "x", kind: "y" }), /text or data/);
  assert.equal(prepareEvent({ stream: "x", kind: "y", text: "t", lat: null, data: null, ended_at: null }).lat, null);
  assert.throws(() => prepareEvent({ stream: "bad stream", kind: "y", text: "t" }), /stream/);
  assert.throws(() => prepareEvent({ stream: "x", kind: "y", text: "t", occurred_at: "nope" }), /occurred_at/);
  assert.throws(
    () => prepareEvent({ stream: "x", kind: "y", text: "t", occurred_at: "2026-01-02", ended_at: "2026-01-01" }),
    /ended_at/,
  );
  assert.throws(() => prepareEvent({ stream: "x", kind: "y", text: "a".repeat(70000) }), /exceeds/);
});

test("ingestEvents dedupes by content hash and external id", () => {
  const s = store();
  const ev = { stream: "chat", kind: "message", occurred_at: "2026-10-01T10:00:00Z", text: "hello Alice Smith" };
  let r = ingestEvents(s, [ev, ev, { stream: "x" }]);
  assert.equal(r.accepted, 1);
  assert.equal(r.duplicates, 1);
  assert.equal(r.rejected.length, 1);
  assert.equal(r.rejected[0].index, 2);
  r = ingestEvents(s, [
    { ...ev, text: "v1", source: "phone", external_id: "m1" },
    { ...ev, text: "v2 edited", source: "phone", external_id: "m1" },
  ]);
  assert.equal(r.accepted, 1);
  assert.equal(r.duplicates, 1);
  assert.equal(s.count(), 2);
});

test("ingestEvents rejects oversize batches", () => {
  const r = ingestEvents(store(), new Array(5).fill({ stream: "a", kind: "b", text: "c" }), { ...DEFAULT_INGEST_OPTIONS, maxBatch: 2 });
  assert.equal(r.accepted, 0);
  assert.match(r.rejected[0].error, /max_batch/);
});

test("EventStore query: range, stream, entity, FTS, privacy, keyset pagination", () => {
  const s = store();
  const evs = [];
  for (let i = 0; i < 25; i++) {
    evs.push({
      stream: i % 2 ? "location" : "chat",
      kind: "k",
      occurred_at: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
      text: i === 7 ? "Dinner with Maria Lopez at Nobu" : `event number ${i}`,
    });
  }
  evs.push({ stream: "vault", kind: "pw", text: "secret thing", privacy: "secret", occurred_at: "2026-10-01T05:00:00Z" });
  ingestEvents(s, evs);
  assert.equal(s.count(), 26);
  assert.equal(s.query({ stream: "chat", limit: 100 }).events.length, 13);
  assert.equal(s.query({ from: "2026-10-01T00:10:00Z", to: "2026-10-01T00:20:00Z" }).events.length, 10);
  assert.equal(s.query({ entity: "maria lopez" }).events.length, 1);
  assert.equal(s.query({ q: "dinner nobu" }).events[0].text, "Dinner with Maria Lopez at Nobu");
  assert.equal(s.query({ q: "secret" }).events.length, 0);
  assert.equal(s.query({ q: "secret", maxPrivacy: "secret" }).events.length, 1);
  const seen = new Set();
  let cursor;
  let pages = 0;
  do {
    const p = s.query({ limit: 7, cursor });
    p.events.forEach((e) => seen.add(e.id));
    cursor = p.next_cursor ?? undefined;
    pages++;
  } while (cursor);
  assert.equal(seen.size, 25);
  assert.equal(pages, 4);
  const asc = [...s.iterate({}, 4)];
  assert.equal(asc.length, 25);
  assert.ok(asc[0].occurred_at <= asc[24].occurred_at);
  const streams = s.streams();
  assert.equal(streams.find((x) => x.stream === "chat").count, 13);
  assert.ok(s.topEntities().some((e) => e.entity === "Maria Lopez"));
});

test("EventStore prune, delete, checkpoints, rebuild", () => {
  const s = store();
  ingestEvents(s, [
    { stream: "browser", kind: "visit", text: "old", occurred_at: "2020-01-01T00:00:00Z" },
    { stream: "browser", kind: "visit", text: "new Paris trip", occurred_at: "2026-01-01T00:00:00Z" },
  ]);
  assert.equal(s.prune("browser", "2025-01-01T00:00:00Z", true), 1);
  assert.equal(s.count(), 2);
  assert.equal(s.prune("browser", "2025-01-01T00:00:00Z"), 1);
  assert.equal(s.count(), 1);
  s.rebuildFts();
  assert.equal(s.query({ q: "paris" }).events.length, 1);
  const id = s.query().events[0].id;
  assert.ok(s.delete(id));
  assert.equal(s.query({ q: "paris" }).events.length, 0);
  s.setCheckpoint("w", "1");
  s.setCheckpoint("w", "2");
  assert.equal(s.getCheckpoint("w"), "2");
  assert.equal(s.getCheckpoint("none"), null);
});

test("toFtsQuery escapes and cursor roundtrips", () => {
  assert.equal(toFtsQuery('he said "x" OR (y)'), '"he"* OR "said"*');
  assert.equal(toFtsQuery("!!"), null);
  assert.deepEqual(decodeCursor(encodeCursor("2026-01-01T00:00:00.000Z", "ABC")), { occurred_at: "2026-01-01T00:00:00.000Z", id: "ABC" });
  assert.equal(decodeCursor("garbage"), null);
});

test("parseNdjson reports bad lines", () => {
  const r = parseNdjson('{"a":1}\n\nnot json\n{"b":2}\n');
  assert.equal(r.items.length, 2);
  assert.deepEqual(r.errors, [{ index: 2, error: "invalid JSON" }]);
  assert.deepEqual(r.lineIndex, [0, 3]);
});

test("extractEntities ignores sentence-initial ordinary words but keeps names", () => {
  const e = (t) => extractEntities(t).entities;
  assert.deepEqual(e("Deep work block"), []);
  assert.deepEqual(e("Planning session with Ines"), ["Ines"]);
  assert.deepEqual(e("Working late. Really tired"), []);
  assert.deepEqual(e("Ines said the Team Rocket demo went well"), ["Ines", "Team Rocket"]);
  assert.deepEqual(e("Sterling Archer called"), ["Sterling Archer"]);
});
