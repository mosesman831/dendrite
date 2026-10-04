import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { DendriteIndex } from "../pipeline/index.js";
import { ingestEvents, ingestOptionsFromConfig } from "../events/ingest.js";
import { detectFormat, IMPORT_FORMATS, parseImport, readGitLog, type ImportFormat } from "../events/importers.js";
import type { EventStore } from "../events/store.js";
import type { IngestOptions } from "../events/ingest.js";

export interface ImportSummary {
  file: string;
  format: ImportFormat;
  parsed: number;
  accepted: number;
  duplicates: number;
  rejected: number;
  errors: Array<{ index: number; error: string }>;
}

/** Parse + ingest a file (or git repo) in chunks. Shared by CLI and drop-folder watcher. */
export function importPath(
  store: EventStore,
  path: string,
  ingestOpts: IngestOptions,
  opts: { format?: string; stream?: string; kind?: string; source?: string; limit?: number } = {},
): ImportSummary {
  if (!existsSync(path)) throw new Error(`not found: ${path}`);
  const isDir = statSync(path).isDirectory();
  let format: ImportFormat;
  let parsed;
  if (isDir) {
    if (opts.format && opts.format !== "git") throw new Error("directories can only be imported with --format git");
    if (!existsSync(join(path, ".git"))) throw new Error(`${path} is not a git repository`);
    format = "git";
    parsed = readGitLog(path, opts);
  } else {
    const content = readFileSync(path, "utf8");
    format = (opts.format as ImportFormat) ?? detectFormat(path, content);
    if (!IMPORT_FORMATS.includes(format)) throw new Error(`unknown format ${format}; use ${IMPORT_FORMATS.join("|")}`);
    parsed = parseImport(format, content, opts);
  }
  const summary: ImportSummary = {
    file: path,
    format,
    parsed: parsed.items.length,
    accepted: 0,
    duplicates: 0,
    rejected: 0,
    errors: [...parsed.errors],
  };
  const chunk = ingestOpts.maxBatch;
  for (let i = 0; i < parsed.items.length; i += chunk) {
    const r = ingestEvents(store, parsed.items.slice(i, i + chunk), ingestOpts);
    summary.accepted += r.accepted;
    summary.duplicates += r.duplicates;
    summary.rejected += r.rejected.length;
    summary.errors.push(...r.rejected.map((e) => ({ index: e.index + i, error: e.error })));
  }
  summary.rejected += parsed.errors.length;
  return summary;
}

export async function runImport(
  path: string,
  opts: { config?: string; format?: string; stream?: string; kind?: string; source?: string; limit?: string; json?: boolean },
): Promise<void> {
  const { config } = loadConfig(opts.config);
  const index = new DendriteIndex(config.index.db_path);
  try {
    const s = importPath(index.events, path, ingestOptionsFromConfig(config), {
      ...opts,
      limit: opts.limit ? Number(opts.limit) : undefined,
    });
    if (opts.json) console.log(JSON.stringify(s, null, 2));
    else {
      console.log(
        `${s.file} [${s.format}]: ${s.parsed} parsed, ${s.accepted} new, ${s.duplicates} duplicate, ${s.rejected} rejected`,
      );
      for (const e of s.errors.slice(0, 10)) console.log(`  #${e.index}: ${e.error}`);
      if (s.errors.length > 10) console.log(`  … ${s.errors.length - 10} more`);
    }
    if (s.rejected && !s.accepted && !s.duplicates) process.exitCode = 1;
  } finally {
    index.close();
  }
}
