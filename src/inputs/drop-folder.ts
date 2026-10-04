import { existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DendriteConfig } from "../config.js";
import type { DendriteIndex } from "../pipeline/index.js";
import { ingestOptionsFromConfig } from "../events/ingest.js";
import { importPath } from "../commands/import.js";

const SUPPORTED = /\.(json|ndjson|jsonl|ics|gpx|csv|xml)$/i;

/** One sweep: import every settled file in the drop folder, then move it to processed/ or failed/. */
export async function sweepDropFolder(
  dir: string,
  index: DendriteIndex,
  config: DendriteConfig,
  settleMs = 2000,
): Promise<number> {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const processed = join(dir, "processed");
  const failed = join(dir, "failed");
  let n = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (!st.isFile() || !SUPPORTED.test(name) || name.startsWith(".")) continue;
    if (Date.now() - st.mtimeMs < settleMs) continue;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    try {
      const s = await importPath(index.events, p, ingestOptionsFromConfig(config));
      mkdirSync(processed, { recursive: true });
      renameSync(p, join(processed, `${stamp}_${name}`));
      console.log(`[drop] ${name}: ${s.accepted} new, ${s.duplicates} dup, ${s.rejected} rejected`);
    } catch (e) {
      mkdirSync(failed, { recursive: true });
      renameSync(p, join(failed, `${stamp}_${name}`));
      writeFileSync(join(failed, `${stamp}_${name}.error.txt`), String((e as Error).message ?? e));
      console.error(`[drop] ${name} failed: ${(e as Error).message}`);
    }
    n++;
  }
  return n;
}

export function startDropFolder(config: DendriteConfig, index: DendriteIndex): () => void {
  const dir = config.inputs.drop_folder.path;
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      await sweepDropFolder(dir, index, config);
    } catch (e) {
      console.error(`[drop] sweep error: ${(e as Error).message}`);
    } finally {
      busy = false;
    }
  };
  void run();
  const t = setInterval(() => void run(), config.inputs.drop_folder.poll_seconds * 1000);
  t.unref();
  console.log(`  Drop folder: ${dir} (every ${config.inputs.drop_folder.poll_seconds}s)`);
  return () => clearInterval(t);
}
