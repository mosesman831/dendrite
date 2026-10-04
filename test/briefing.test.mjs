import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { dist } from "./helpers.mjs";

const { EventStore } = await dist("events/store.js");
const { ingestEvents, DEFAULT_INGEST_OPTIONS } = await dist("events/ingest.js");
const { buildBriefing, renderBriefing } = await dist("events/briefing.js");

test("briefing: agenda, loops by urgency, yesterday, on this day, privacy", () => {
  const store = new EventStore(new Database(":memory:"));
  const opts = { ...DEFAULT_INGEST_OPTIONS, loops: { exclude: [], autoResolve: true, timezone: "UTC" } };
  ingestEvents(store, [
    { stream: "calendar", kind: "meeting", text: "Standup with Priya", occurred_at: "2026-10-04T09:30:00Z" },
    { stream: "note", kind: "m", text: "I need to pay rent today", occurred_at: "2026-10-03T08:00:00Z" },
    { stream: "note", kind: "m", text: "Remind me to call mom tomorrow", occurred_at: "2026-10-03T08:05:00Z" },
    { stream: "note", kind: "m", text: "I'll send the deck on tuesday", occurred_at: "2026-10-03T08:10:00Z" },
    { stream: "note", kind: "m", text: "I should clean the garage", occurred_at: "2026-10-03T08:15:00Z" },
    { stream: "note", kind: "m", text: "I need to hide the secret thing today", privacy: "secret", occurred_at: "2026-10-03T08:20:00Z" },
    { stream: "journal", kind: "entry", text: "Hiked Snowdon with Priya", importance: 0.9, occurred_at: "2025-10-04T12:00:00Z" },
  ], opts);
  const b = buildBriefing(store, "2026-10-04", { timezone: "UTC" });
  assert.equal(b.agenda.length, 1);
  assert.match(b.agenda[0].summary, /Standup/);
  assert.match(b.loops.overdue[0].text, /pay rent/);
  assert.match(b.loops.today[0].text, /call mom/);
  assert.match(b.loops.soon[0].text, /send the deck/);
  assert.equal(b.loops.undated, 1);
  assert.equal(b.yesterday.total, 4);
  assert.equal(b.on_this_day.length, 1);
  assert.equal(b.on_this_day[0].years_ago, 1);
  assert.match(b.on_this_day[0].highlights[0].summary, /Snowdon/);
  const md = renderBriefing(b);
  for (const s of ["## Today", "**Overdue**", "**Due today**", "**Coming up**", "## Yesterday", "## On this day"]) assert.ok(md.includes(s), s);
  assert.ok(!md.includes("secret thing"));
});

test("briefing: empty store renders a calm, minimal brief", () => {
  const store = new EventStore(new Database(":memory:"));
  const md = renderBriefing(buildBriefing(store, "2028-02-29", {}));
  assert.match(md, /Nothing scheduled/);
  assert.ok(!md.includes("## Open loops"));
});
