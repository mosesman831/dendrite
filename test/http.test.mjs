import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { dist, makeWorkspace } from "./helpers.mjs";

const { loadConfig } = await dist("config.js");
const { DendriteIndex } = await dist("pipeline/index.js");
const { mountEventsApi } = await dist("inputs/events-api.js");

let ws, server, base, index;
const TOKEN = "test-token-123";

before(async () => {
  ws = makeWorkspace();
  process.env.DENDRITE_WEBHOOK_TOKEN = TOKEN;
  const { config } = loadConfig(ws.configPath);
  index = new DendriteIndex(config.index.db_path);
  const app = express();
  mountEventsApi(app, config, index);
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  index?.close();
  ws?.cleanup();
  delete process.env.DENDRITE_WEBHOOK_TOKEN;
});

const auth = { Authorization: `Bearer ${TOKEN}` };

test("rejects missing token", async () => {
  const r = await fetch(`${base}/v1/streams`);
  assert.equal(r.status, 401);
});

test("POST /v1/events single, array, and {events}", async () => {
  const post = (body) =>
    fetch(`${base}/v1/events`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(
      async (r) => ({ status: r.status, body: await r.json() }),
    );
  let r = await post({ stream: "location", kind: "visit", text: "Arrived at Kings Cross", lat: 51.53, lon: -0.12, occurred_at: "2026-10-03T08:00:00Z" });
  assert.equal(r.status, 200);
  assert.equal(r.body.accepted, 1);
  r = await post([
    { stream: "health", kind: "steps", data: { count: 9000 }, occurred_at: "2026-10-03T23:00:00Z" },
    { stream: "chat", kind: "message", text: "hi", occurred_at: "2026-10-03T09:00:00Z" },
  ]);
  assert.equal(r.body.accepted, 2);
  r = await post({ events: [{ stream: "chat", kind: "message", text: "hi", occurred_at: "2026-10-03T09:00:00Z" }] });
  assert.equal(r.body.duplicates, 1);
  r = await post({ nope: 1 });
  assert.equal(r.status, 400);
});

test("POST /v1/events/ndjson partial success", async () => {
  const body = [
    JSON.stringify({ stream: "git", kind: "commit", text: "fix bug", occurred_at: "2026-10-03T10:00:00Z" }),
    "garbage",
    JSON.stringify({ stream: "git" }),
  ].join("\n");
  const r = await fetch(`${base}/v1/events/ndjson`, { method: "POST", headers: { ...auth, "Content-Type": "application/x-ndjson" }, body });
  const j = await r.json();
  assert.equal(j.accepted, 1);
  assert.deepEqual(j.rejected.map((x) => x.index), [1, 2]);
});

test("GET /v1/events filters + pagination + streams + entities", async () => {
  let j = await fetch(`${base}/v1/events?stream=chat,git&limit=1`, { headers: auth }).then((r) => r.json());
  assert.equal(j.events.length, 1);
  assert.ok(j.next_cursor);
  const j2 = await fetch(`${base}/v1/events?stream=chat,git&limit=1&cursor=${j.next_cursor}`, { headers: auth }).then((r) => r.json());
  assert.notEqual(j2.events[0].id, j.events[0].id);
  j = await fetch(`${base}/v1/events?q=kings`, { headers: auth }).then((r) => r.json());
  assert.equal(j.events[0].lat, 51.53);
  const one = await fetch(`${base}/v1/events/${j.events[0].id}`, { headers: auth }).then((r) => r.json());
  assert.equal(one.kind, "visit");
  j = await fetch(`${base}/v1/events?from=bad`, { headers: auth });
  assert.equal(j.status, 400);
  const s = await fetch(`${base}/v1/streams`, { headers: auth }).then((r) => r.json());
  assert.equal(s.total, 4);
  const e = await fetch(`${base}/v1/entities`, { headers: auth }).then((r) => r.json());
  assert.ok(e.entities.some((x) => x.entity === "Kings Cross"));
});

test("POST /v1/receivers/:kind — query token, idempotent, protocol replies", async () => {
  const body = JSON.stringify({ _type: "location", lat: 1, lon: 2, tst: 1790000000, tid: "t" });
  const post = (path) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
  assert.equal((await post("/v1/receivers/owntracks")).status, 401);
  let r = await post(`/v1/receivers/owntracks?token=${TOKEN}`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), []);
  await post(`/v1/receivers/owntracks?token=${TOKEN}`);
  const j = await fetch(`${base}/v1/events?stream=location`, { headers: auth }).then((x) => x.json());
  assert.equal(j.events.filter((e) => e.source === "owntracks").length, 1);
  r = await fetch(`${base}/v1/receivers/overland`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ locations: [] }) });
  assert.deepEqual(await r.json(), { result: "ok" });
  assert.equal((await post(`/v1/receivers/nope?token=${TOKEN}`)).status, 404);
});
