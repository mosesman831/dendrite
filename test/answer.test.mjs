import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { dist } from "./helpers.mjs";

const { EventStore } = await dist("events/store.js");
const { ingestEvents } = await dist("events/ingest.js");
const { eventContext } = await dist("pipeline/answer.js");

test("eventContext: question words → relevant normal-privacy events as citeable blocks", () => {
  const store = new EventStore(new Database(":memory:"));
  ingestEvents(store, [
    { stream: "chat", kind: "message", text: "Ines said the budget is capped at 40k", occurred_at: "2026-10-01T10:00:00Z" },
    { stream: "chat", kind: "message", text: "Ines budget secret detail", privacy: "secret", occurred_at: "2026-10-01T11:00:00Z" },
    { stream: "health", kind: "note", text: "Slept 7h", occurred_at: "2026-10-01T12:00:00Z" },
  ]);
  const r = eventContext(store, "What did Ines say about the budget?");
  assert.equal(r.events.length, 1);
  assert.match(r.events[0].summary, /40k/);
  assert.match(r.blocks[0], /^\[event:[0-9A-Z]{26}\] 2026-10-01 10:00 \(chat\) /);
  assert.deepEqual(eventContext(store, "what did I do?"), { events: [], blocks: [] });
});
