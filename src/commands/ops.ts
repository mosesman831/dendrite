import { createWriteStream, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { once } from "node:events";
import { loadConfig } from "../config.js";
import { DendriteIndex } from "../pipeline/index.js";
import { applyRetention } from "../events/retention.js";
import { normalizeTime } from "../events/time.js";
import type { PrivacyLevel } from "../events/types.js";

export async function runPrune(opts: { config?: string; dryRun?: boolean; json?: boolean }): Promise<void> {
  const { config } = loadConfig(opts.config);
  const index = new DendriteIndex(config.index.db_path);
  try {
    const results = applyRetention(index.events, config.retention.streams, { dryRun: opts.dryRun });
    if (opts.json) console.log(JSON.stringify(results, null, 2));
    else if (!results.length) console.log("No retention policy matched (set retention.streams in config).");
    else
      for (const r of results)
        console.log(`${opts.dryRun ? "[dry-run] " : ""}${r.stream}: keep ${r.keep} → ${r.deleted} event(s) before ${r.before}`);
  } finally {
    index.close();
  }
}

export async function runExport(opts: {
  config?: string;
  out?: string;
  from?: string;
  to?: string;
  stream?: string;
  includeSecret?: boolean;
}): Promise<void> {
  const { config } = loadConfig(opts.config);
  const index = new DendriteIndex(config.index.db_path);
  const from = opts.from ? normalizeTime(opts.from) : undefined;
  const to = opts.to ? normalizeTime(opts.to) : undefined;
  if (from === null || to === null) throw new Error("--from/--to: unparseable timestamp");
  const out = opts.out && opts.out !== "-" ? createWriteStream(opts.out) : process.stdout;
  let n = 0;
  try {
    const maxPrivacy: PrivacyLevel = opts.includeSecret ? "secret" : "sensitive";
    for (const e of index.events.iterate({ from, to, stream: opts.stream?.split(","), maxPrivacy })) {
      const { distilled_at: _d, note_path: _p, received_at: _r, content_hash: _h, ...portable } = e;
      if (!out.write(`${JSON.stringify(portable)}\n`)) await once(out, "drain");
      n++;
    }
  } finally {
    index.close();
    if (out !== process.stdout) {
      (out as ReturnType<typeof createWriteStream>).end();
      await once(out, "finish");
    }
  }
  if (out !== process.stdout) console.error(`Exported ${n} events → ${opts.out}`);
}

export async function runBackup(dest: string, opts: { config?: string }): Promise<void> {
  const { config } = loadConfig(opts.config);
  const target = resolve(dest);
  if (existsSync(target) && statSync(target).isDirectory()) throw new Error("backup destination must be a file path");
  mkdirSync(dirname(target), { recursive: true });
  const index = new DendriteIndex(config.index.db_path);
  try {
    await index.db.backup(target);
    console.log(`Backup written: ${target} (${(statSync(target).size / 1024).toFixed(1)} KiB)`);
  } finally {
    index.close();
  }
}
