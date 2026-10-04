import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { dist } from "./helpers.mjs";

const { EventStore } = await dist("events/store.js");
const { ingestEvents, DEFAULT_INGEST_OPTIONS } = await dist("events/ingest.js");
const L = await dist("events/loops.js");

const opts = { ...DEFAULT_INGEST_OPTIONS, loops: { exclude: ["browser"], autoResolve: true, timezone: "UTC" } };

test("parseDue: relative phrases against base date (2026-10-01 is a Thursday)", () => {
  const b = "2026-10-01";
  assert.equal(L.parseDue("call mum tomorrow", b), "2026-10-02");
  assert.equal(L.parseDue("send it tonight", b), "2026-10-01");
  assert.equal(L.parseDue("by friday", b), "2026-10-02");
  assert.equal(L.parseDue("on thursday", b), "2026-10-08");
  assert.equal(L.parseDue("in 3 days", b), "2026-10-04");
  assert.equal(L.parseDue("next week", b), "2026-10-08");
  assert.equal(L.parseDue("before 2026-12-24", b), "2026-12-24");
  assert.equal(L.parseDue("someday", b), null);
});

test("extractLoops: checkboxes, markers, phrases; skips non-commitments; dedupes overlap", () => {
  const got = L.extractLoops(
    "- [ ] book dentist\n- [x] done thing\nTODO: renew passport by friday. I'll be late. Remind me to email Sam tomorrow! Need to email Sam tomorrow",
    "2026-10-01",
  );
  assert.deepEqual(
    got.map((x) => [x.text, x.due]),
    [["book dentist", null], ["renew passport by friday", "2026-10-02"], ["email Sam tomorrow", "2026-10-02"]],
  );
  assert.deepEqual(L.extractLoops("I will see you there", "2026-10-01"), []);
  assert.deepEqual(L.extractLoops(null, "2026-10-01"), []);
});

test("ingest tracks loops; privacy/stream gates; auto-resolve; manual status; listing order", () => {
  const store = new EventStore(new Database(":memory:"));
  ingestEvents(store, [
    { stream: "chat", kind: "m", text: "I need to renew the car insurance by friday", occurred_at: "2026-10-01T09:00:00Z" },
    { stream: "note", kind: "n", text: "todo: water the plants", occurred_at: "2026-10-01T10:00:00Z" },
    { stream: "browser", kind: "visit", text: "todo: ignored page title", occurred_at: "2026-10-01T10:00:00Z" },
    { stream: "chat", kind: "m", text: "remind me to hide the gift", privacy: "secret", occurred_at: "2026-10-01T11:00:00Z" },
    { stream: "health", kind: "m", text: "I must take meds tonight", occurred_at: "2026-10-01T12:00:00Z" },
  ], opts);
  let all = L.listLoops(store, { now: "2026-10-01T13:00:00Z" });
  assert.deepEqual(all.map((l) => l.text), ["take meds tonight", "renew the car insurance by friday", "water the plants"]);
  assert.equal(all[0].privacy, "sensitive");
  assert.equal(L.listLoops(store, { maxPrivacy: "normal" }).length, 2);

  // dedupe: re-ingesting same event doesn't duplicate loops
  ingestEvents(store, [{ stream: "note", kind: "n", text: "todo: water the plants", occurred_at: "2026-10-01T10:00:00Z" }], opts);
  assert.equal(L.listLoops(store, { status: "all" }).length, 3);

  ingestEvents(store, [{ stream: "chat", kind: "m", text: "Finally renewed... done with car insurance renewal", occurred_at: "2026-10-02T09:00:00Z" }], opts);
  ingestEvents(store, [{ stream: "chat", kind: "m", text: "done with the plants? no, the garden", occurred_at: "2026-10-02T09:00:00Z" }], opts);
  all = L.listLoops(store, { status: "all" });
  const ins = all.find((l) => l.text.includes("insurance"));
  assert.equal(ins.status, "done");
  assert.ok(ins.resolved_by);
  assert.equal(all.find((l) => l.text.includes("plants")).status, "open", "1-token overlap is not enough");

  const plants = all.find((l) => l.text.includes("plants"));
  assert.throws(() => L.setLoopStatus(store, plants.id, "snoozed"), /until/);
  L.setLoopStatus(store, plants.id, "snoozed", "2026-10-05T00:00:00Z");
  assert.ok(!L.listLoops(store, { now: "2026-10-03T00:00:00Z" }).some((l) => l.id === plants.id));
  assert.ok(L.listLoops(store, { now: "2026-10-06T00:00:00Z" }).some((l) => l.id === plants.id));
  assert.equal(L.setLoopStatus(store, plants.id, "dropped").status, "dropped");
  assert.equal(L.setLoopStatus(store, "nope", "done"), null);

  const md = L.renderLoops(L.listLoops(store, { status: "all" }), "2026-10-03");
  assert.match(md, /- \[ \] take meds tonight \(due 2026-10-01, \*\*overdue\*\*\)/);
  assert.match(md, /- \[x\] renew the car insurance/);
  assert.match(md, /- \[-\] water the plants/);
});

test("loops disabled when ingest options lack loops", () => {
  const store = new EventStore(new Database(":memory:"));
  ingestEvents(store, [{ stream: "chat", kind: "m", text: "todo: thing" }]);
  assert.equal(L.listLoops(store, { status: "all" }).length, 0);
});

test("loop text keeps dotted tokens (versions, domains)", async () => {
  const { extractLoops } = await dist("events/loops.js");
  const l = extractLoops("TODO: write up the v0.5 plan. Then rest", "2026-10-04");
  assert.equal(l[0].text, "write up the v0.5 plan");
  const m = extractLoops("I need to renew example.com before it lapses!", "2026-10-04");
  assert.equal(m[0].text, "renew example.com before it lapses");
});
