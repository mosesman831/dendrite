import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { dist } from "./helpers.mjs";

const { EventStore } = await dist("events/store.js");
const { ingestEvents, DEFAULT_INGEST_OPTIONS } = await dist("events/ingest.js");
const { sourceHealth, renderSources } = await dist("events/sources.js");

test("source health: continuous feeds go stale; one-shot imports and derived never do", () => {
  const store = new EventStore(new Database(":memory:"));
  const at = (iso) => ({ ...DEFAULT_INGEST_OPTIONS, now: () => new Date(iso) });
  for (let d = 1; d <= 5; d++)
    for (let h = 0; h < 24; h += 2) {
      const t = `2026-10-0${d}T${String(h).padStart(2, "0")}:00:00Z`;
      ingestEvents(store, [{ stream: "location", kind: "point", source: "owntracks", data: { h }, occurred_at: t }], at(t));
    }
  ingestEvents(store, Array.from({ length: 50 }, (_, i) => ({ stream: "calendar", kind: "e", source: "ics", text: `ev ${i}`, occurred_at: `2025-01-01T00:${String(i).padStart(2, "0")}:00Z` })), at("2026-10-02T12:00:00Z"));
  ingestEvents(store, [{ stream: "location", kind: "stay", source: "derived:stays", data: { m: 1 } }], at("2026-10-03T00:00:00Z"));

  const fresh = sourceHealth(store, { now: "2026-10-05T23:00:00Z" });
  const ot = fresh.find((r) => r.source === "owntracks");
  assert.deepEqual([ot.events, ot.days_active, ot.continuous, ot.stale, ot.p90_gap_hours], [60, 5, true, false, 2]);
  assert.equal(fresh.find((r) => r.source === "ics").continuous, false);
  assert.equal(fresh.some((r) => r.source.startsWith("derived:")), false);

  const later = sourceHealth(store, { now: "2026-10-06T12:00:00Z" });
  assert.equal(later[0].source, "owntracks");
  assert.equal(later[0].stale, true);
  assert.match(renderSources(later), /STALE/);
});
