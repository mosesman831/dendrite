import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { EventStore } from "./store.js";

const NAME = /^dendrite-\d{8}T\d{6}Z\.db$/;

/** Online SQLite backup into `dir`, keeping the newest `keep` snapshots. */
export async function rotateBackup(
  db: Database.Database,
  dir: string,
  keep: number,
  now = new Date(),
): Promise<{ path: string; removed: string[] }> {
  mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const path = join(dir, `dendrite-${stamp}.db`);
  await db.backup(path);
  const all = readdirSync(dir).filter((f) => NAME.test(f)).sort();
  const removed = all.slice(0, Math.max(0, all.length - Math.max(1, keep)));
  for (const f of removed) rmSync(join(dir, f), { force: true });
  return { path, removed };
}

export interface BackupStatus {
  attempt_at: string;
  ok_at: string | null;
  error: string | null;
}

/** Remember the outcome of a scheduled backup so health checks can flag a broken one. */
export function recordBackup(store: EventStore, error?: string, now = new Date().toISOString()): void {
  const prev = backupStatus(store);
  const s: BackupStatus = { attempt_at: now, ok_at: error ? (prev?.ok_at ?? null) : now, error: error ?? null };
  store.setCheckpoint("backup:last", JSON.stringify(s));
}

export function backupStatus(store: EventStore): BackupStatus | null {
  const v = store.getCheckpoint("backup:last");
  return v ? (JSON.parse(v) as BackupStatus) : null;
}
