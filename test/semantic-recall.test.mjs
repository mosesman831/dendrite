import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { dist } from "./helpers.mjs";

const { EventStore } = await dist("events/store.js");
const { ingestEvents } = await dist("events/ingest.js");
const S = await dist("events/semantic.js");

// Tiny deterministic "embedding": concept buckets so synonyms land together.
const CONCEPTS = [["dog", "puppy", "canine", "vet"], ["coffee", "espresso", "latte", "cafe"], ["run", "jog", "marathon"]];
const vec = (t) => {
  const w = t.toLowerCase();
  return CONCEPTS.map((c) => c.filter((x) => w.includes(x)).length + 0.01);
};
const embed = async (texts) => texts.map(vec);
const at = (m) => `2026-10-01T${String(10 + m).padStart(2, "0")}:00:00Z`;

function seed() {
  const store = new EventStore(new Database(":memory:"));
  ingestEvents(store, [
    { stream: "chat", kind: "m", text: "Took the puppy to the vet", occurred_at: at(0) },
    { stream: "chat", kind: "m", text: "Great espresso at the new cafe", occurred_at: at(1) },
    { stream: "fitness", kind: "w", text: "Morning jog by the river", occurred_at: at(2) },
    { stream: "health", kind: "hr", text: "heart rate after the jog", occurred_at: at(3) },
    { stream: "chat", kind: "m", text: "classified canine stuff", occurred_at: at(4), privacy: "secret" },
  ]);
  return store;
}

test("embedPendingEvents: incremental, privacy-gated, orphan cleanup, model switch", async () => {
  const store = seed();
  let r = await S.embedPendingEvents(store, { model: "m1", embed, batch: 2 });
  assert.equal(r.embedded, 3, "normal only by default");
  assert.equal(r.remaining, 0);
  r = await S.embedPendingEvents(store, { model: "m1", embed });
  assert.equal(r.embedded, 0);
  r = await S.embedPendingEvents(store, { model: "m1", embed, includeSensitive: true });
  assert.equal(r.embedded, 1);
  assert.equal(store.embeddingCount(), 4);
  const victim = store.query({ stream: "fitness" }).events[0];
  store.delete(victim.id);
  r = await S.embedPendingEvents(store, { model: "m1", embed });
  assert.equal(r.orphans, 1);
  r = await S.embedPendingEvents(store, { model: "m2", embed });
  assert.equal(r.embedded, 2);
  assert.equal(store.embeddingCount("m1"), 1);
  const bad = await S.embedPendingEvents(seed(), { model: "m", embed: async () => { throw new Error("down"); } });
  assert.equal(bad.embedded, 0);
  assert.ok(bad.failed > 0);
});

test("recallHybrid finds synonyms FTS misses; degrades to FTS on provider error", async () => {
  const store = seed();
  await S.embedPendingEvents(store, { model: "m", embed, includeSensitive: true });
  const emb = { enabled: true, model: "m", apiKeyEnv: "X", hybrid_weight: 0.5 };
  const embedQueryFn = async (q) => vec(q);

  const fts = await S.recallHybrid(store, { q: "dog", contextMin: 0 }, emb, { semantic: false });
  assert.equal(fts.hits.length, 0);
  const sem = await S.recallHybrid(store, { q: "dog", contextMin: 0 }, emb, { embedQueryFn });
  assert.equal(sem.query.semantic, true);
  assert.deepEqual(sem.hits.map((h) => h.event.text), ["Took the puppy to the vet"], "secret excluded");

  const coffee = await S.recallHybrid(store, { q: "latte", contextMin: 0, stream: ["chat"] }, emb, { embedQueryFn });
  assert.equal(coffee.hits[0].event.text, "Great espresso at the new cafe");

  const jog = await S.recallHybrid(store, { q: "jog", contextMin: 0, maxPrivacy: "normal" }, emb, { embedQueryFn });
  assert.ok(jog.hits.every((h) => h.event.privacy === "normal"));
  assert.equal(jog.hits[0].event.text, "Morning jog by the river");

  const logs = [];
  const down = await S.recallHybrid(store, { q: "jog", contextMin: 0 }, emb, {
    embedQueryFn: async () => { throw new Error("boom"); },
    log: (m) => logs.push(m),
  });
  assert.equal(down.query.semantic, false);
  assert.ok(down.hits.length >= 1);
  assert.match(logs[0], /boom/);

  const none = await S.recallHybrid(store, { q: "dog", contextMin: 0 }, null);
  assert.equal(none.hits.length, 0);
});
