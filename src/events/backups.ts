import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";

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
