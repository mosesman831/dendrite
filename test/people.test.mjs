import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { dist } from "./helpers.mjs";

const { EventStore } = await dist("events/store.js");
const { ingestEvents, DEFAULT_INGEST_OPTIONS } = await dist("events/ingest.js");
const { listPeople, renderPeople } = await dist("events/people.js");
const { buildBriefing, renderBriefing } = await dist("events/briefing.js");

test("people: cadence, drifting, privacy", () => {
  const store = new EventStore(new Database(":memory:"));
  const at = (d) => `2026-${d}T12:00:00Z`;
  const evs = [];
  // Oscar: weekly through August, then silence
  for (const d of ["08-01", "08-08", "08-15", "08-22", "08-29"]) evs.push({ stream: "note", kind: "m", text: "Call with Oscar", entities: ["Oscar"], occurred_at: at(d) });
  // Priya: frequent recently
  for (const d of ["09-25", "09-28", "10-01", "10-03"]) evs.push({ stream: "note", kind: "m", text: "Met Priya", entities: ["Priya"], occurred_at: at(d) });
  // Secret
  for (const d of ["09-01", "09-02", "09-03"]) evs.push({ stream: "note", kind: "m", text: "x", entities: ["Bob"], occurred_at: at(d), privacy: "secret" });
  ingestEvents(store, evs, DEFAULT_INGEST_OPTIONS);
  const rows = listPeople(store, { now: "2026-10-04T12:00:00Z" });
  const by = Object.fromEntries(rows.map((r) => [r.entity, r]));
  assert.equal(by.Bob, undefined);
  assert.equal(by.Priya.recent, 4);
  assert.equal(by.Priya.drifting, false);
  assert.equal(by.Oscar.recent, 0);
  assert.equal(by.Oscar.typical_gap_days, 7);
  assert.equal(by.Oscar.days_since, 36);
  assert.equal(by.Oscar.drifting, true);
  assert.equal(rows[0].entity, "Priya");
  const md = renderPeople(rows);
  assert.match(md, /\*\*Priya\*\*: 4 recent/);
  assert.match(md, /\*\*Oscar\*\*: every ~7d, silent 36d \(since 2026-08-29\)/);
  assert.match(renderPeople([]), /No recurring/);
  const b = buildBriefing(store, "2026-10-04", { timezone: "UTC" });
  assert.deepEqual(b.reconnect, [{ entity: "Oscar", days_since: 36, typical_gap_days: 7 }]);
  assert.match(renderBriefing(b), /## Reconnect\n- Oscar: usually every ~7d, last mentioned 36d ago/);
  assert.deepEqual(buildBriefing(store, "2026-10-04", { reconnect: 0 }).reconnect, []);
});
