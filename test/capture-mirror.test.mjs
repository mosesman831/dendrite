import { test, after } from "node:test";
import assert from "node:assert/strict";
import { dist, makeWorkspace } from "./helpers.mjs";

const { loadConfig } = await dist("config.js");
const { DendriteIndex } = await dist("pipeline/index.js");
const { processDump } = await dist("pipeline/pipeline.js");

const ws = makeWorkspace();
const { config } = loadConfig(ws.configPath);
const index = new DendriteIndex(config.index.db_path);
after(() => { index.close(); ws.cleanup(); });
const llm = { primary: { baseURL: "http://127.0.0.1:9/v1", apiKey: "x", model: "m" } };
const ctx = { config, configDir: ws.dir, llm, index };
const dump = { id: "tg-77", source: "telegram-voice", receivedAt: "2026-10-04T06:00:00.000Z", text: "Remind me to call the plumber tomorrow" };

test("captures land in the event log even when the LLM is unreachable; retries are idempotent", async () => {
  await assert.rejects(processDump(ctx, { ...dump }));
  await assert.rejects(processDump(ctx, { ...dump }));
  const rows = index.events.db.prepare("SELECT stream, kind, source, external_id, text FROM events WHERE external_id = 'dump:tg-77'").all();
  assert.deepEqual(rows, [{ stream: "note", kind: "voice", source: "telegram-voice", external_id: "dump:tg-77", text: dump.text }]);
  const loops = index.events.db.prepare("SELECT text, due_date FROM open_loops").all();
  assert.deepEqual(loops, [{ text: "call the plumber tomorrow", due_date: "2026-10-05" }]);
});

test("dry runs and mirror_captures:false skip the event log", async () => {
  await assert.rejects(processDump({ ...ctx, dryRun: true }, { ...dump, id: "d2" }));
  await assert.rejects(processDump({ ...ctx, config: { ...config, events: { ...config.events, mirror_captures: false } } }, { ...dump, id: "d3" }));
  const n = index.events.db.prepare("SELECT COUNT(*) n FROM events WHERE external_id IN ('dump:d2','dump:d3')").get().n;
  assert.equal(n, 0);
});
