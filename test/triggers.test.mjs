import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import Database from "better-sqlite3";
import { dist } from "./helpers.mjs";

const { EventStore } = await dist("events/store.js");
const { ingestEvents, DEFAULT_INGEST_OPTIONS } = await dist("events/ingest.js");
const T = await dist("events/triggers.js");

const cfg = (o) => ({ enabled: true, match: {}, include_sensitive: false, cooldown_sec: 0, ...o });
const tick = () => new Promise((r) => setTimeout(r, 30));

test("compile validates actions and regex", () => {
  assert.throws(() => T.compileTriggers([cfg({ name: "x" })]), /webhook or record/);
  assert.throws(() => T.compileTriggers([cfg({ name: "x", match: { text: "(" }, record: { stream: "a", kind: "b", text: "", tags: [] } })]), /bad text regex/);
  assert.equal(T.compileTriggers([cfg({ name: "x", enabled: false })]).length, 0);
});

test("match predicates, privacy and loop guard", () => {
  const [t] = T.compileTriggers([cfg({ name: "m", match: { stream: ["Chat"], entity: ["alice"], text: "urgent", min_importance: 0.1 }, record: { stream: "a", kind: "b", text: "", tags: [] } })]);
  const e = { stream: "chat", kind: "m", source: "x", entities: ["Alice"], importance: 0.5, privacy: "normal", text: "URGENT call" };
  assert.ok(T.matchTrigger(t, e));
  assert.ok(!T.matchTrigger(t, { ...e, text: "later" }));
  assert.ok(!T.matchTrigger(t, { ...e, entities: [] }));
  assert.ok(!T.matchTrigger(t, { ...e, privacy: "sensitive" }));
  assert.ok(!T.matchTrigger(t, { ...e, privacy: "secret" }));
  assert.ok(!T.matchTrigger(t, { ...e, source: "trigger:m" }));
  assert.equal(T.renderTemplate("{{kind}}: {{text}} [{{entities}}] {{nope}}", e), "m: URGENT call [Alice] ");
});

test("webhook: signed, retries 5xx, stops on 4xx", async () => {
  const calls = [];
  let statuses = [503, 500, 200];
  const fetchImpl = async (url, init) => {
    calls.push(init);
    return { ok: statuses[0] === 200, status: statuses.shift() };
  };
  const t = cfg({ name: "w", webhook: { url: "http://x/h", secret_env: "S", timeout_ms: 1000, retries: 3 } });
  const r = await T.deliverWebhook(t, { id: "e1" }, { fetchImpl, backoffMs: 1, env: { S: "shh" } });
  assert.deepEqual({ ok: r.ok, attempts: r.attempts }, { ok: true, attempts: 3 });
  const sig = "sha256=" + createHmac("sha256", "shh").update(calls[0].body).digest("hex");
  assert.equal(calls[0].headers["X-Dendrite-Signature"], sig);
  assert.equal(JSON.parse(calls[0].body).trigger, "w");
  statuses = [400, 200];
  calls.length = 0;
  const r2 = await T.deliverWebhook(t, { id: "e1" }, { fetchImpl, backoffMs: 1, env: {} });
  assert.equal(r2.attempts, 1);
  assert.equal(calls[0].headers["X-Dendrite-Signature"], undefined);
});

test("runner: record action derives event without loops; cooldown; webhook fired", async () => {
  const db = new Database(":memory:");
  const store = new EventStore(db);
  const sent = [];
  let clock = 1_000_000;
  const triggers = T.compileTriggers([
    cfg({ name: "todo", match: { text: "\\btodo\\b" }, record: { stream: "tasks", kind: "open_loop", text: "From {{stream}}: {{text}}", tags: ["auto"] } }),
    cfg({ name: "ping", match: { stream: ["chat"] }, cooldown_sec: 60, webhook: { url: "http://x", timeout_ms: 1000, retries: 0 } }),
  ]);
  const fires = [];
  const stop = T.startTriggers(store, triggers, DEFAULT_INGEST_OPTIONS, {
    fetchImpl: async (_u, init) => (sent.push(JSON.parse(init.body)), { ok: true, status: 200 }),
    onFire: (f) => fires.push(f),
    now: () => clock,
  });
  ingestEvents(store, [{ stream: "chat", kind: "m", text: "todo: buy milk", occurred_at: "2026-10-01T10:00:00Z" }]);
  ingestEvents(store, [{ stream: "chat", kind: "m", text: "hello", occurred_at: "2026-10-01T10:01:00Z" }]);
  clock += 61_000;
  ingestEvents(store, [{ stream: "chat", kind: "m", text: "again", occurred_at: "2026-10-01T10:02:00Z" }]);
  await tick();
  const derived = store.query({ stream: "tasks" }).events;
  assert.equal(derived.length, 1);
  assert.equal(derived[0].text, "From chat: todo: buy milk");
  assert.equal(derived[0].source, "trigger:todo");
  assert.deepEqual(derived[0].tags.includes("auto"), true);
  assert.deepEqual(sent.map((s) => s.event.text), ["todo: buy milk", "again"]);
  stop();
  assert.equal(store.bus.size, 0);
  db.close();
});
