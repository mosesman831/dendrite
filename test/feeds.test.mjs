import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { dist } from "./helpers.mjs";

const { EventStore } = await dist("events/store.js");
const { DEFAULT_INGEST_OPTIONS } = await dist("events/ingest.js");
const { parseFeed, syncFeed } = await dist("events/feeds.js");
const { sourceHealth } = await dist("events/sources.js");

const RSS = `<?xml version="1.0"?><rss><channel><title>Letterboxd</title>
<item><title>Dune: Part Two, 2024 - &#9733;&#9733;&#9733;&#9733;</title><link>https://letterboxd.com/x/film/dune-2/</link>
<guid isPermaLink="false">letterboxd-review-1</guid><pubDate>Sat, 03 Oct 2026 20:00:00 +0000</pubDate>
<description><![CDATA[<p>Watched with <b>Ines</b> &amp; loved it.</p>]]></description></item>
<item><title>No date item</title><link>https://example.com/a</link></item>
</channel></rss>`;

const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>yt:video:abc</id><title>Talk on memory</title>
<link rel="alternate" href="https://youtube.com/watch?v=abc"/><published>2026-10-02T08:00:00Z</published><summary>Agents &lt;3 logs</summary></entry></feed>`;

test("parseFeed: RSS + Atom, CDATA/entities/html stripped", () => {
  const r = parseFeed(RSS);
  assert.equal(r.length, 2);
  assert.equal(r[0].title, "Dune: Part Two, 2024 - ★★★★");
  assert.equal(r[0].summary, "Watched with Ines & loved it.");
  assert.equal(r[0].id, "letterboxd-review-1");
  assert.equal(r[0].at, "2026-10-03T20:00:00.000Z");
  assert.equal(r[1].at, null);
  const a = parseFeed(ATOM);
  assert.deepEqual(a[0], { id: "yt:video:abc", title: "Talk on memory", link: "https://youtube.com/watch?v=abc", at: "2026-10-02T08:00:00.000Z", summary: "Agents <3 logs" });
});

test("syncFeed: idempotent, namespaced, privacy, no url leak", async () => {
  const store = new EventStore(new Database(":memory:"));
  const sub = { name: "lb", url_env: "LB_RSS", stream: "media", privacy: "sensitive" };
  const env = { LB_RSS: "https://secret.example/rss?k=abc" };
  const now = () => "2026-10-04T00:00:00.000Z";
  const r1 = await syncFeed(store, sub, DEFAULT_INGEST_OPTIONS, async () => RSS, env, now);
  assert.equal(r1.ok, true);
  assert.equal(r1.accepted, 2);
  const r2 = await syncFeed(store, sub, DEFAULT_INGEST_OPTIONS, async () => RSS, env, () => "2026-10-05T00:00:00.000Z");
  assert.equal(r2.accepted, 0);
  const evs = store.query({ stream: "media", maxPrivacy: "secret" }).events;
  assert.equal(evs.length, 2);
  assert.ok(evs.every((e) => e.source === "feed:lb" && e.privacy === "sensitive"));
  assert.ok(evs.some((e) => e.entities.includes("Ines")));
  const bad = await syncFeed(store, sub, DEFAULT_INGEST_OPTIONS, async () => { throw new Error("fetch https://secret.example/rss?k=abc failed"); }, env);
  assert.equal(bad.ok, false);
  assert.ok(!bad.error.includes("secret.example"));
  assert.equal((await syncFeed(store, sub, DEFAULT_INGEST_OPTIONS, async () => RSS, {})).error, "LB_RSS not set");
});

test("source health tracks subscription sync status, not just new items", async () => {
  const store = new EventStore(new Database(":memory:"));
  const sub = { name: "yt", url: "https://x.example/feed", interval_min: 60 };
  await syncFeed(store, sub, DEFAULT_INGEST_OPTIONS, async () => ATOM, {}, () => "2026-10-01T00:00:00.000Z");
  await syncFeed(store, sub, DEFAULT_INGEST_OPTIONS, async () => ATOM, {}, () => "2026-10-04T00:00:00.000Z");
  let row = sourceHealth(store, { now: "2026-10-04T01:00:00.000Z", windowDays: 3650 }).find((r) => r.source === "feed:yt");
  assert.equal(row.continuous, true);
  assert.equal(row.stale, false);
  await syncFeed(store, sub, DEFAULT_INGEST_OPTIONS, async () => { throw new Error("HTTP 410"); }, {}, () => "2026-10-04T12:00:00.000Z");
  row = sourceHealth(store, { now: "2026-10-04T12:00:00.000Z", windowDays: 3650 }).find((r) => r.source === "feed:yt");
  assert.equal(row.error, "HTTP 410");
  assert.equal(row.stale, true);
  await syncFeed(store, { name: "nourl" }, DEFAULT_INGEST_OPTIONS, async () => ATOM, {});
  assert.equal(sourceHealth(store).find((r) => r.source === "feed:nourl").stale, true);
});
