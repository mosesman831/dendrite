import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { staysFromItems, streamAppleHealth } from "../events/importers-life.js";
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
export async function importPath(
  store: EventStore,
  path: string,
  ingestOpts: IngestOptions,
  opts: {
    format?: string;
    stream?: string;
    kind?: string;
    source?: string;
    limit?: number;
    stays?: boolean;
    since?: string;
    types?: string[];
  } = {},
): Promise<ImportSummary> {
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
    const sniff = readHead(path);
    format = (opts.format as ImportFormat) ?? detectFormat(path, sniff);
    if (format === "apple-health") return importAppleHealth(store, path, ingestOpts, opts);
    const content = readFileSync(path, "utf8");
    if (!opts.format && detectFormat(path, content) !== format) format = detectFormat(path, content);
    if (!IMPORT_FORMATS.includes(format)) throw new Error(`unknown format ${format}; use ${IMPORT_FORMATS.join("|")}`);
    parsed = parseImport(format, content, opts);
    if (opts.stays && (format === "gpx" || format === "takeout-location" || format === "json")) {
      parsed.items.push(...staysFromItems(parsed.items, opts.source ?? format));
    }
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

function readHead(path: string, n = 4096): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(n);
    const len = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, len).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

async function importAppleHealth(
  store: EventStore,
  path: string,
  ingestOpts: IngestOptions,
  opts: { since?: string; types?: string[]; stream?: string; kind?: string; source?: string },
): Promise<ImportSummary> {
  const summary: ImportSummary = { file: path, format: "apple-health", parsed: 0, accepted: 0, duplicates: 0, rejected: 0, errors: [] };
  for await (const batch of streamAppleHealth(path, opts, ingestOpts.maxBatch)) {
    const r = ingestEvents(store, batch, ingestOpts);
    summary.errors.push(...r.rejected.slice(0, 100 - Math.min(100, summary.errors.length)).map((e) => ({ index: e.index + summary.parsed, error: e.error })));
    summary.parsed += batch.length;
    summary.accepted += r.accepted;
    summary.duplicates += r.duplicates;
    summary.rejected += r.rejected.length;
  }
  return summary;
}

export async function runImport(
  path: string,
  opts: {
    config?: string;
    format?: string;
    stream?: string;
    kind?: string;
    source?: string;
    limit?: string;
    json?: boolean;
    stays?: boolean;
    since?: string;
    types?: string;
  },
): Promise<void> {
  const { config } = loadConfig(opts.config);
  const index = new DendriteIndex(config.index.db_path);
  try {
    const s = await importPath(index.events, path, ingestOptionsFromConfig(config), {
      ...opts,
      limit: opts.limit ? Number(opts.limit) : undefined,
      types: opts.types?.split(","),
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
