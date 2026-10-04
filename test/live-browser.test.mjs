import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import Database from "better-sqlite3";
import { dist, makeWorkspace } from "./helpers.mjs";

const { EventStore } = await dist("events/store.js");
const { ingestEvents } = await dist("events/ingest.js");
const { readBrowserHistory, scrubUrl } = await dist("events/importers-browser.js");
const { importPath } = await dist("commands/import.js");
const { DEFAULT_INGEST_OPTIONS } = await dist("events/ingest.js");

const tmp = mkdtempSync(join(tmpdir(), "dendrite-br-"));

test("bus publishes only committed new events; bad listener isolated", () => {
  const db = new Database(":memory:");
  const s = new EventStore(db);
  const got = [];
  s.bus.subscribe(() => {
    throw new Error("bad");
  });
  const off = s.bus.subscribe((e) => got.push(e.text));
  const at = "2026-10-01T00:00:00Z";
  ingestEvents(s, [{ stream: "a", kind: "b", text: "one", occurred_at: at }, { stream: "a", kind: "b", text: "one", occurred_at: at }, { stream: "a", kind: "b" }]);
  assert.deepEqual(got, ["one"]);
  off();
  ingestEvents(s, [{ stream: "a", kind: "b", text: "two" }]);
  assert.deepEqual(got, ["one"]);
  db.close();
});

let ws, server, base, index;
before(async () => {
  ws = makeWorkspace();
  const { loadConfig } = await dist("config.js");
  const { DendriteIndex } = await dist("pipeline/index.js");
  const { mountEventsApi } = await dist("inputs/events-api.js");
  const { config } = loadConfig(ws.configPath);
  index = new DendriteIndex(config.index.db_path);
  const app = express();
  app.use(express.json());
  mountEventsApi(app, config, index);
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server?.closeAllConnections?.();
  server?.close();
  index?.close();
  ws?.cleanup();
  rmSync(tmp, { recursive: true, force: true });
});

async function readSse(res, n, timeoutMs = 3000) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const events = [];
  const deadline = Date.now() + timeoutMs;
  while (events.length < n && Date.now() < deadline) {
    const { value, done } = await Promise.race([reader.read(), new Promise((r) => setTimeout(() => r({ value: undefined, done: false }), 200))]);
    if (done) break;
    if (value) buf += dec.decode(value);
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (data) events.push(JSON.parse(data.slice(6)));
    }
  }
  await reader.cancel();
  return events;
}

test("SSE /v1/stream: replay via since, live push, filters, privacy", async () => {
  ingestEvents(index.events, [{ stream: "chat", kind: "m", text: "before connect", occurred_at: "2026-10-01T00:00:00Z" }]);
  const ac = new AbortController();
  const res = await fetch(`${base}/v1/stream?stream=chat,health&include_sensitive=0&since=2000-01-01`, { signal: ac.signal });
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  setTimeout(() => {
    ingestEvents(index.events, [
      { stream: "other", kind: "m", text: "filtered out" },
      { stream: "health", kind: "hr", text: "sensitive hidden" },
      { stream: "chat", kind: "m", text: "secret hidden", privacy: "secret" },
      { stream: "chat", kind: "m", text: "live one" },
    ]);
  }, 150);
  const evs = await readSse(res, 2);
  ac.abort();
  assert.deepEqual(evs.map((e) => e.text), ["before connect", "live one"]);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(index.events.bus.size, 0, "listener removed on disconnect");
});

function chromeDb(p) {
  const db = new Database(p);
  db.exec(`CREATE TABLE urls(id INTEGER PRIMARY KEY, url TEXT, title TEXT);
           CREATE TABLE visits(id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER, visit_duration INTEGER, transition INTEGER);`);
  db.prepare(`INSERT INTO urls VALUES (1,'https://www.example.com/a?q=dendrite&token=abc#x','Example A'),(2,'chrome://settings','Settings'),(3,'https://news.site/b',NULL)`).run();
  const us = (iso) => BigInt(Date.parse(iso)) * 1000n + 11644473600000000n;
  db.prepare(`INSERT INTO visits VALUES (10,1,?,5000000,0),(11,2,?,0,0),(12,3,?,0,0)`).run(us("2026-10-01T10:00:00Z"), us("2026-10-01T10:01:00Z"), us("2026-09-01T10:00:00Z"));
  db.close();
}

test("browser history: chrome, firefox, safari; scrub; since; idempotent import", async () => {
  assert.equal(scrubUrl("https://x.com/p?q=1&access_token=zz&API_KEY=k#frag"), "https://x.com/p?q=1");
  const c = join(tmp, "History");
  chromeDb(c);
  let r = readBrowserHistory(c);
  assert.equal(r.items.length, 2);
  const a = r.items.find((i) => i.external_id === "chrome:10");
  assert.equal(a.occurred_at, "2026-10-01T10:00:00.000Z");
  assert.equal(a.ended_at, "2026-10-01T10:00:05.000Z");
  assert.equal(a.data.url, "https://www.example.com/a?q=dendrite");
  assert.equal(a.text, "Example A — example.com");
  assert.deepEqual(a.entities, ["example.com"]);
  assert.equal(readBrowserHistory(c, { since: "2026-09-15" }).items.length, 1);

  const f = join(tmp, "places.sqlite");
  const fdb = new Database(f);
  fdb.exec(`CREATE TABLE moz_places(id INTEGER PRIMARY KEY, url TEXT, title TEXT); CREATE TABLE moz_historyvisits(id INTEGER PRIMARY KEY, place_id INTEGER, visit_date INTEGER, visit_type INTEGER);`);
  fdb.prepare(`INSERT INTO moz_places VALUES (1,'https://mozilla.org/','Mozilla')`).run();
  fdb.prepare(`INSERT INTO moz_historyvisits VALUES (5,1,?,1)`).run(BigInt(Date.parse("2026-10-02T09:00:00Z")) * 1000n);
  fdb.close();
  r = readBrowserHistory(f);
  assert.equal(r.items[0].source, "firefox");
  assert.equal(r.items[0].occurred_at, "2026-10-02T09:00:00.000Z");

  const sf = join(tmp, "History.db");
  const sdb = new Database(sf);
  sdb.exec(`CREATE TABLE history_items(id INTEGER PRIMARY KEY, url TEXT); CREATE TABLE history_visits(id INTEGER PRIMARY KEY, history_item INTEGER, visit_time REAL, title TEXT);`);
  sdb.prepare(`INSERT INTO history_items VALUES (1,'https://apple.com/')`).run();
  sdb.prepare(`INSERT INTO history_visits VALUES (7,1,?, 'Apple')`).run(Date.parse("2026-10-03T08:00:00Z") / 1000 - 978307200);
  sdb.close();
  r = readBrowserHistory(sf);
  assert.equal(r.items[0].source, "safari");
  assert.equal(r.items[0].occurred_at, "2026-10-03T08:00:00.000Z");

  const db = new Database(":memory:");
  const store = new EventStore(db);
  let s = await importPath(store, c, DEFAULT_INGEST_OPTIONS);
  assert.equal(s.format, "browser-history");
  assert.equal(s.accepted, 2);
  s = await importPath(store, c, DEFAULT_INGEST_OPTIONS);
  assert.equal(s.duplicates, 2);
  const bad = join(tmp, "bad.db");
  new Database(bad).exec("CREATE TABLE x(a)");
  await assert.rejects(() => importPath(store, bad, DEFAULT_INGEST_OPTIONS), /not a recognised/);
  db.close();
});
