import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { dist } from "./helpers.mjs";

const { EventStore } = await dist("events/store.js");
const { ingestEvents, DEFAULT_INGEST_OPTIONS } = await dist("events/ingest.js");
const { lastTime, renderLastTime } = await dist("events/last.js");

test("lastTime: most recent match, cadence, overdue hint, privacy", () => {
  const store = new EventStore(new Database(":memory:"));
  const ev = (text, d, privacy) => ({ stream: "note", kind: "m", text, privacy, occurred_at: `2026-${d}T10:00:00Z` });
  ingestEvents(store, [ev("Got a haircut", "06-01"), ev("haircut at the barber", "07-01"), ev("Haircut again", "07-31"), ev("secret haircut", "09-20", "secret")], DEFAULT_INGEST_OPTIONS);
  const r = lastTime(store, "haircut", { now: "2026-10-04T08:00:00Z" });
  assert.equal(r.last.text, "Haircut again");
  assert.deepEqual([r.days_ago, r.days_seen, r.typical_gap_days], [65, 3, 30]);
  const s = renderLastTime(r);
  assert.match(s, /65 days ago/);
  assert.match(s, /every ~30d/);
  assert.match(s, /twice the usual gap/);
  assert.match(renderLastTime(lastTime(store, "dentist")), /No record/);
});
