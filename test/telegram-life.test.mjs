import { test, after } from "node:test";
import assert from "node:assert/strict";
import { dist, makeWorkspace } from "./helpers.mjs";

const { loadConfig } = await dist("config.js");
const { DendriteIndex } = await dist("pipeline/index.js");
const { lifeCommand, logTelegramMessage } = await dist("inputs/telegram-life.js");
const { listLoops } = await dist("events/loops.js");

const ws = makeWorkspace();
const { config } = loadConfig(ws.configPath);
const index = new DendriteIndex(config.index.db_path);
const store = index.events;
after(() => { index.close(); ws.cleanup(); });
const now = () => new Date("2026-10-04T08:00:00Z");
const run = (cmd, arg = "") => lifeCommand({ store, config, now }, cmd, arg);

test("telegram capture mirrors into the event log (idempotent) and spawns loops", async () => {
  const m = { text: "Remind me to book the dentist tomorrow", chatId: 7, messageId: 42, date: Date.parse("2026-10-04T07:00:00Z") / 1000 };
  assert.equal(logTelegramMessage(store, config, m), true);
  assert.equal(logTelegramMessage(store, config, m), false);
  const loops = listLoops(store, { status: "active" });
  assert.equal(loops.length, 1);
  assert.equal(loops[0].due_date, "2026-10-05");

  const list = await run("loops");
  assert.match(list, /book the dentist/);
  assert.match(await run("done", "zz"), /hex/);
  const id = loops[0].id.slice(0, 6);
  assert.match(await run("snooze", id), /Snoozed until 2026-10-05/);
  assert.match(await run("loops"), /No open loops/);
  assert.match(await run("done", id), /✓ Done: book the dentist/);
  assert.match(await run("done", id), /No active loop/);
});

test("/log, /today, /recall, /where, /brief", async () => {
  assert.equal(await run("log", "Coffee with Priya at Blue Bottle"), "Logged.");
  assert.match(await run("today"), /Coffee with Priya/);
  assert.match(await run("recall", "Priya"), /Coffee with Priya/);
  assert.match(await run("recall", "zebra-unicorn"), /Nothing found/);
  assert.match(await run("where"), /No location/);
  const { ingestEvents, DEFAULT_INGEST_OPTIONS } = await dist("events/ingest.js");
  ingestEvents(store, [{ stream: "location", kind: "point", lat: 51.5, lon: -0.12, occurred_at: "2026-10-04T07:30:00Z", data: { place: "Home" } }], DEFAULT_INGEST_OPTIONS);
  assert.match(await run("where"), /2026-10-04 07:30 .*\(51\.5000, -0\.1200\)/);
  assert.match(await run("brief"), /# Briefing — 2026-10-04/);
  assert.match(await run("today", "1999-01-01"), /Nothing recorded/);
  assert.match(await run("insights"), /# Insights — 2026-09-28 → 2026-10-04 \(7 days\)[\s\S]*Coffee|# Insights — 2026-09-28 → 2026-10-04 \(7 days\)/);
  assert.match(await run("insights", "30"), /\(30 days\)/);
  assert.match(await run("insights", "abc"), /Usage/);
});

test("/places and /sources", async () => {
  assert.match(await run("places"), /No places configured/);
  const s = await run("sources");
  assert.doesNotMatch(s, /No events received/);
  assert.match(s, /\d+ ev/);
});
