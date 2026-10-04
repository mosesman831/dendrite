import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { dist } from "./helpers.mjs";

const { EventStore } = await dist("events/store.js");
const { ingestEvents, DEFAULT_INGEST_OPTIONS } = await dist("events/ingest.js");
const { habitStatus, renderHabits } = await dist("events/habits.js");
const { buildBriefing, renderBriefing } = await dist("events/briefing.js");

test("habits: streaks, overdue, never recorded; briefing lists due habits", () => {
  const store = new EventStore(new Database(":memory:"));
  const ev = (text, d) => ({ stream: "note", kind: "m", text, occurred_at: `2026-${d}T10:00:00Z` });
  ingestEvents(store, ["09-20", "09-23", "09-27", "10-01", "10-03"].map((d) => ev("went to the gym", d)), DEFAULT_INGEST_OPTIONS);
  ingestEvents(store, [ev("called mum", "09-01")], DEFAULT_INGEST_OPTIONS);
  const habits = [{ name: "gym", every_days: 4 }, { name: "Call mum", query: "mum", every_days: 7 }, { name: "meditate", every_days: 1 }];
  const [gym, mum, med] = habitStatus(store, habits, { now: "2026-10-04T08:00:00Z" });
  assert.deepEqual([gym.days_ago, gym.streak, gym.done_30d, gym.overdue], [1, 5, 5, false]);
  assert.deepEqual([mum.days_ago, mum.streak, mum.overdue], [33, 0, true]);
  assert.deepEqual([med.last, med.overdue], [null, true]);
  assert.match(renderHabits([gym, mum, med]), /streak 5/);

  const b = buildBriefing(store, "2026-10-04", { habits, now: "2026-10-04T08:00:00Z" });
  assert.deepEqual(b.habits_due.map((h) => h.name), ["Call mum", "meditate"]);
  assert.match(renderBriefing(b), /## Habits due\n- Call mum: 33d since last \(every 7d\)\n- meditate: never recorded/);
});
