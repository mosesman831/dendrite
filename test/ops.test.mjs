import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import express from "express";
import Database from "better-sqlite3";
import { dist, makeWorkspace, ROOT } from "./helpers.mjs";

const { parseDuration, applyRetention } = await dist("events/retention.js");
const { authorize, RateLimiter, resolveApiKeys, applyHttpHardening } = await dist("inputs/http-security.js");
const { EventStore } = await dist("events/store.js");
const { ingestEvents } = await dist("events/ingest.js");

test("parseDuration", () => {
  assert.equal(parseDuration("90d"), 90 * 86_400_000);
  assert.equal(parseDuration("1.5h"), 5_400_000);
  assert.equal(parseDuration("forever"), null);
  assert.throws(() => parseDuration("10 days"));
});

test("applyRetention per-stream + wildcard + dry-run", () => {
  const db = new Database(":memory:");
  const s = new EventStore(db);
  ingestEvents(s, [
    { stream: "browser", kind: "v", text: "old", occurred_at: "2026-01-01T00:00:00Z" },
    { stream: "browser", kind: "v", text: "new", occurred_at: "2026-09-30T00:00:00Z" },
    { stream: "note", kind: "e", text: "ancient", occurred_at: "2010-01-01T00:00:00Z" },
    { stream: "health", kind: "e", text: "keep", occurred_at: "2010-01-01T00:00:00Z" },
  ]);
  const now = new Date("2026-10-04T00:00:00Z");
  const policy = { browser: "90d", "*": "5y", health: "forever" };
  const dry = applyRetention(s, policy, { now, dryRun: true });
  assert.equal(dry.find((r) => r.stream === "browser").deleted, 1);
  assert.equal(s.count(), 4);
  applyRetention(s, policy, { now });
  assert.equal(s.count(), 2);
  assert.deepEqual(s.query().events.map((e) => e.text).sort(), ["keep", "new"]);
  db.close();
});

test("authorize scopes + open mode", () => {
  const keys = [
    { name: "ro", token: "r", scopes: ["read"] },
    { name: "adm", token: "a", scopes: ["admin"] },
  ];
  assert.equal(authorize([], undefined, "write").ok, true);
  assert.equal(authorize(keys, undefined, "read").status, 401);
  assert.equal(authorize(keys, "Bearer nope", "read").status, 401);
  assert.equal(authorize(keys, "Bearer r", "read").ok, true);
  assert.equal(authorize(keys, "Bearer r", "write").status, 403);
  assert.equal(authorize(keys, "bearer a", "write").ok, true);
  const cfg = { inputs: { webhook: { tokenEnv: "W" } }, http: { api_keys: [{ name: "x", tokenEnv: "X", scopes: ["read"] }, { name: "y", tokenEnv: "Y", scopes: ["read"] }] } };
  assert.deepEqual(resolveApiKeys(cfg, { W: "w", X: "x" }).map((k) => k.name), ["webhook", "x"]);
});

test("RateLimiter windows", () => {
  let t = 0;
  const rl = new RateLimiter(2, () => t);
  assert.ok(rl.check("a").ok);
  assert.ok(rl.check("a").ok);
  const third = rl.check("a");
  assert.equal(third.ok, false);
  assert.equal(third.retryAfter, 60);
  assert.ok(rl.check("b").ok);
  t = 60_000;
  assert.ok(rl.check("a").ok);
  assert.ok(new RateLimiter(0).check("x").ok);
});

let ws, server, base, index;
before(async () => {
  ws = makeWorkspace(`http:\n  rate_limit_per_min: 5\n  api_keys:\n    - name: reader\n      tokenEnv: OPS_TEST_READ\n      scopes: [read]\n`);
  process.env.OPS_TEST_READ = "rtok";
  const { loadConfig } = await dist("config.js");
  const { DendriteIndex } = await dist("pipeline/index.js");
  const { mountEventsApi } = await dist("inputs/events-api.js");
  const { config } = loadConfig(ws.configPath);
  index = new DendriteIndex(config.index.db_path);
  const app = express();
  applyHttpHardening(app, config);
  mountEventsApi(app, config, index);
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server?.close();
  index?.close();
  ws?.cleanup();
  delete process.env.OPS_TEST_READ;
});

test("HTTP: health, scopes, headers, rate limit", async () => {
  const h = await fetch(`${base}/healthz`);
  assert.equal(h.status, 200);
  assert.equal(h.headers.get("x-content-type-options"), "nosniff");
  assert.ok(h.headers.get("x-request-id"));
  assert.equal((await fetch(`${base}/readyz`)).status, 200);
  const auth = { Authorization: "Bearer rtok" };
  const st = await fetch(`${base}/v1/stats`, { headers: auth }).then((r) => r.json());
  assert.equal(st.auth, "keys");
  const hl = await fetch(`${base}/v1/health`, { headers: auth }).then((r) => r.json());
  assert.equal(hl.integrity, "skipped");
  assert.equal(hl.api_open, false);
  const w = await fetch(`${base}/v1/events`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: "{}" });
  assert.equal(w.status, 403);
  let last;
  for (let i = 0; i < 5; i++) last = await fetch(`${base}/v1/streams`, { headers: auth });
  assert.equal(last.status, 429);
  assert.ok(Number(last.headers.get("retry-after")) > 0);
  for (let i = 0; i < 6; i++) assert.equal((await fetch(`${base}/healthz`)).status, 200);
});

test("CLI export → import round-trip + backup", () => {
  const w = makeWorkspace();
  const cli = (...a) => execFileSync("node", [join(ROOT, "dist/cli.js"), ...a, "-c", w.configPath], { encoding: "utf8" });
  try {
    cli("record", "Met Ada Lovelace", "-s", "chat", "--at", "2026-10-01T10:00:00Z");
    cli("record", "-s", "health", "-k", "steps", "--data", '{"count":5}', "--at", "2026-10-02T10:00:00Z");
    const out = join(w.dir, "x.ndjson");
    cli("export", "-o", out);
    const lines = readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].content_hash, undefined);
    const w2 = makeWorkspace();
    try {
      const r = JSON.parse(execFileSync("node", [join(ROOT, "dist/cli.js"), "import", out, "--json", "-c", w2.configPath], { encoding: "utf8" }));
      assert.equal(r.accepted, 2);
    } finally {
      w2.cleanup();
    }
    const bak = join(w.dir, "bak", "b.db");
    cli("backup", bak);
    assert.ok(existsSync(bak));
    const bdb = new Database(bak, { readonly: true });
    assert.equal(bdb.prepare("SELECT COUNT(*) c FROM events").get().c, 2);
    bdb.close();
  } finally {
    w.cleanup();
  }
});
