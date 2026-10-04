import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { dist } from "./helpers.mjs";

const { EventStore } = await dist("events/store.js");
const { DEFAULT_INGEST_OPTIONS } = await dist("events/ingest.js");
const { syncCalendar, calendarUrl } = await dist("events/calendars.js");

const ICS = `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a1\r\nDTSTART:20261005T090000Z\r\nDTEND:20261005T100000Z\r\nSUMMARY:Standup\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:a2\r\nDTSTART;VALUE=DATE:20261006\r\nSUMMARY:Holiday\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;

test("calendar sync: env URL, idempotent, source + privacy, namespaced UIDs", async () => {
  const store = new EventStore(new Database(":memory:"));
  const seen = [];
  const fetchText = async (u) => (seen.push(u), ICS);
  const cal = { name: "work", url_env: "CAL_WORK", privacy: "sensitive" };
  const env = { CAL_WORK: "webcal://cal.example/secret.ics" };
  const r1 = await syncCalendar(store, cal, DEFAULT_INGEST_OPTIONS, fetchText, env);
  assert.deepEqual([r1.ok, r1.events, r1.accepted], [true, 2, 2]);
  assert.equal(seen[0], "https://cal.example/secret.ics");
  const r2 = await syncCalendar(store, cal, DEFAULT_INGEST_OPTIONS, fetchText, env);
  assert.deepEqual([r2.accepted, r2.duplicates], [0, 2]);
  const ev = store.query({ stream: "calendar", maxPrivacy: "sensitive", order: "asc" }).events;
  assert.equal(ev[0].source, "ics:work");
  assert.equal(ev[0].privacy, "sensitive");
  assert.equal(ev[0].external_id, "work:a1");
  assert.equal(store.query({ stream: "calendar", maxPrivacy: "normal" }).events.length, 0);
});

test("calendar sync: edited VEVENT is updated in place (same id, re-searchable)", async () => {
  const store = new EventStore(new Database(":memory:"));
  const cal = { name: "work", url: "https://c/x.ics" };
  await syncCalendar(store, cal, DEFAULT_INGEST_OPTIONS, async () => ICS);
  const before = store.query({ stream: "calendar", order: "asc" }).events[0];
  const moved = ICS.replace("20261005T090000Z", "20261005T140000Z").replace("SUMMARY:Standup", "SUMMARY:Retro with Ines");
  const r = await syncCalendar(store, cal, DEFAULT_INGEST_OPTIONS, async () => moved);
  assert.deepEqual([r.accepted, r.updated, r.duplicates], [0, 1, 1]);
  const after = store.get(before.id);
  assert.equal(after.occurred_at, "2026-10-05T14:00:00.000Z");
  assert.match(after.text, /Retro/);
  assert.equal(after.distilled_at, null);
  assert.equal(store.query({ stream: "calendar" }).events.length, 2);
  assert.equal(store.query({ q: "retro" }).events[0]?.id, before.id);
  assert.equal(store.query({ q: "standup" }).events.length, 0);
});

test("calendar sync: missing env and fetch errors never leak the URL", async () => {
  const store = new EventStore(new Database(":memory:"));
  const r = await syncCalendar(store, { name: "x", url_env: "NOPE" }, DEFAULT_INGEST_OPTIONS, async () => ICS, {});
  assert.deepEqual([r.ok, r.error], [false, "NOPE not set"]);
  const bad = await syncCalendar(store, { name: "x", url: "https://h/s3cret.ics" }, DEFAULT_INGEST_OPTIONS, async (u) => { throw new Error(`fetch failed for ${u}`); });
  assert.equal(bad.ok, false);
  assert.doesNotMatch(bad.error, /s3cret/);
  assert.equal(calendarUrl({ name: "y" }), null);
});
