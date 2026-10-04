import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { dist } from "./helpers.mjs";

const { fromGitHub } = await dist("events/receivers.js");
const { EventStore } = await dist("events/store.js");
const { ingestEvents, DEFAULT_INGEST_OPTIONS } = await dist("events/ingest.js");

const repository = { full_name: "moses/dendrite" };

test("github push → one commit event each, idempotent", () => {
  const push = {
    ref: "refs/heads/main",
    repository,
    commits: [
      { id: "abc123", message: "feat: places\n\nbody", timestamp: "2026-10-04T03:00:00+01:00", url: "https://x/abc", author: { name: "Moses" } },
      { id: "def456", message: "fix: casing", timestamp: "2026-10-04T03:05:00Z" },
    ],
  };
  const ev = fromGitHub(push);
  assert.equal(ev.length, 2);
  assert.equal(ev[0].text, "moses/dendrite@main: feat: places");
  assert.equal(ev[0].occurred_at, "2026-10-04T02:00:00.000Z");
  assert.equal(ev[0].data.author, "Moses");
  const store = new EventStore(new Database(":memory:"));
  assert.equal(ingestEvents(store, ev, DEFAULT_INGEST_OPTIONS).accepted, 2);
  assert.equal(ingestEvents(store, fromGitHub(push), DEFAULT_INGEST_OPTIONS).accepted, 0);
  assert.deepEqual(fromGitHub({ ...push, deleted: true }), []);
});

test("github PR merged / issue opened / release; noise ignored", () => {
  const pr = fromGitHub({ action: "closed", repository, pull_request: { number: 33, title: "now snapshot", merged: true, merged_at: "2026-10-04T03:40:00Z", html_url: "u", user: { login: "devin" } } });
  assert.equal(pr[0].kind, "pr_merged");
  assert.equal(pr[0].text, "moses/dendrite PR #33 merged: now snapshot");
  assert.equal(fromGitHub({ action: "opened", repository, issue: { number: 7, title: "bug", created_at: "2026-10-01T00:00:00Z" } })[0].kind, "issue_opened");
  assert.equal(fromGitHub({ action: "published", repository, release: { tag_name: "v0.4.0", name: "Continuum", published_at: "2026-10-04T04:00:00Z" } })[0].text, "moses/dendrite release published: Continuum");
  assert.deepEqual(fromGitHub({ action: "labeled", repository, issue: { number: 7, title: "bug" } }), []);
  assert.deepEqual(fromGitHub({ zen: "Keep it logically awesome.", hook_id: 1 }), []);
});
