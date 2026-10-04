import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { dist } from "./helpers.mjs";

const { rotateBackup, recordBackup } = await dist("events/backups.js");
const { EventStore } = await dist("events/store.js");
const { eventLogHealth } = await dist("events/health.js");

test("rotateBackup: consistent snapshots, keeps newest N, ignores foreign files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dendrite-bk-"));
  const db = new Database(join(dir, "live.db"));
  db.exec("CREATE TABLE t(x); INSERT INTO t VALUES (1),(2)");
  const out = join(dir, "backups");
  for (const d of ["2026-10-01T04:00:00Z", "2026-10-02T04:00:00Z", "2026-10-03T04:00:00Z"])
    await rotateBackup(db, out, 2, new Date(d));
  writeFileSync(join(out, "notes.txt"), "keep me");
  const r = await rotateBackup(db, out, 2, new Date("2026-10-04T04:00:00Z"));
  assert.deepEqual(r.removed, ["dendrite-20261002T040000Z.db"]);
  assert.deepEqual(readdirSync(out).sort(), ["dendrite-20261003T040000Z.db", "dendrite-20261004T040000Z.db", "notes.txt"]);
  const copy = new Database(r.path, { readonly: true });
  assert.equal(copy.prepare("SELECT count(*) n FROM t").get().n, 2);
  copy.close();
  db.close();
});

test("health warns on failed or overdue scheduled backups", () => {
  const store = new EventStore(new Database(":memory:"));
  const h = (now) => eventLogHealth(store, { apiKeys: 1, integrity: false, now, backupMaxAgeHours: 48 }).warnings.filter((w) => /backup/i.test(w));
  assert.deepEqual(h("2026-10-04T00:00:00Z"), []);
  recordBackup(store, undefined, "2026-10-01T04:00:00.000Z");
  assert.deepEqual(h("2026-10-02T04:00:00Z"), []);
  assert.deepEqual(h("2026-10-04T04:00:00Z"), ["Last backup is 72h old"]);
  recordBackup(store, "ENOSPC", "2026-10-02T04:00:00.000Z");
  assert.deepEqual(h("2026-10-02T05:00:00Z"), ["Last backup failed: ENOSPC"]);
  assert.equal(eventLogHealth(store, { apiKeys: 1, integrity: false }).backup.ok_at, "2026-10-01T04:00:00.000Z");
  recordBackup(store, undefined, "2026-10-03T04:00:00.000Z");
  assert.deepEqual(h("2026-10-03T05:00:00Z"), []);
});
