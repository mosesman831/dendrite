import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { loadConfig, resolveApiKey } from "../config.js";
import type { SttConfig } from "../providers/types.js";

const execFileAsync = promisify(execFile);
import { DendriteIndex } from "../pipeline/index.js";
import { testChatEndpoint } from "../providers/llm.js";

const AVG_SEGMENTS_WARN_THRESHOLD = 4.0;
const EMBEDDING_COVERAGE_WARN_PCT = 50;
const INPUT_TOKENS_PER_DUMP = 800;
const OUTPUT_TOKENS_PER_DUMP = 200;

/** Rough USD per 1M tokens — heuristic only, not live pricing. */
const MODEL_PRICE_PER_1M: Record<string, { input: number; output: number }> = {
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10 },
  "meta/llama-3.1-8b-instruct": { input: 0.02, output: 0.02 },
  "llama-3.1-8b": { input: 0.02, output: 0.02 },
  "llama3.2": { input: 0, output: 0 },
};

function resolveModelPricing(model: string): { input: number; output: number } {
  const lower = model.toLowerCase();
  for (const [key, prices] of Object.entries(MODEL_PRICE_PER_1M)) {
    if (lower.includes(key.toLowerCase())) return prices;
  }
  return MODEL_PRICE_PER_1M["gpt-4o-mini"];
}

function estimateCostPerDump(model: string): number {
  const p = resolveModelPricing(model);
  const inputCost = (INPUT_TOKENS_PER_DUMP / 1_000_000) * p.input;
  const outputCost = (OUTPUT_TOKENS_PER_DUMP / 1_000_000) * p.output;
  return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000;
}

function sevenDaysAgoIso(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 7);
  return d.toISOString();
}

function countDanglingLinks(vaultPath: string, index: DendriteIndex): number {
  const notes = index.listAllNotes();
  const knownSlugs = new Set<string>();
  for (const note of notes) {
    const slug = note.path.replace(/\.md$/i, "").split("/").pop();
    if (slug) knownSlugs.add(slug.toLowerCase());
  }

  const wikilinkRe = /\[\[([^\]]+)\]\]/g;
  const journalRe = /^\d{2}-\d{2}-\d{4}$/;
  let dangling = 0;

  for (const note of notes) {
    const fullPath = join(vaultPath, note.path);
    if (!existsSync(fullPath)) continue;
    let text: string;
    try {
      text = readFileSync(fullPath, "utf8");
    } catch {
      continue;
    }
    let match: RegExpExecArray | null;
    while ((match = wikilinkRe.exec(text)) !== null) {
      const raw = match[1];
      const target = raw.split(/[|#]/)[0].trim().toLowerCase();
      if (!target) continue;
      if (journalRe.test(target)) continue;
      if (!knownSlugs.has(target)) dangling += 1;
    }
  }

  return dangling;
}

export async function runDoctor(opts: {
  config?: string;
  stats?: boolean;
  json?: boolean;
}): Promise<void> {
  const json = opts.json === true;
  const line = (s: string): void => {
    if (!json) console.log(s);
  };

  const health: {
    ok: boolean;
    config: boolean;
    vault_path: string | null;
    index_db_path: string | null;
    llm: {
      primary: {
        baseURL: string | null;
        model: string | null;
        apiKeyPresent: boolean;
        reachable: boolean;
      };
      fallback_present: boolean;
    };
    stt_provider: string | null;
    indexed_notes: number;
    processed_dumps: number;
    embeddings_enabled: boolean;
    embedding_coverage: { embedded: number; total: number; pct: number };
    segment_stats: {
      total_segment_rows: number;
      unique_parent_dumps: number;
      avg_segments_per_dump: number;
    };
    cost_estimate: {
      model: string;
      input_tokens_per_dump: number;
      output_tokens_per_dump: number;
      estimated_cost_usd_per_dump: number;
      parent_dumps_last_7d: number;
      estimated_cost_usd_last_7d: number;
      note: string;
    };
    queue: { pending: number; processing: number; done: number; dead: number };
    dangling_links: number;
    warnings: string[];
  } = {
    ok: true,
    config: false,
    vault_path: null,
    index_db_path: null,
    llm: {
      primary: { baseURL: null, model: null, apiKeyPresent: false, reachable: false },
      fallback_present: false,
    },
    stt_provider: null,
    indexed_notes: 0,
    processed_dumps: 0,
    embeddings_enabled: false,
    embedding_coverage: { embedded: 0, total: 0, pct: 0 },
    segment_stats: { total_segment_rows: 0, unique_parent_dumps: 0, avg_segments_per_dump: 0 },
    cost_estimate: {
      model: "",
      input_tokens_per_dump: INPUT_TOKENS_PER_DUMP,
      output_tokens_per_dump: OUTPUT_TOKENS_PER_DUMP,
      estimated_cost_usd_per_dump: 0,
      parent_dumps_last_7d: 0,
      estimated_cost_usd_last_7d: 0,
      note: "heuristic estimate — not from provider billing",
    },
    queue: { pending: 0, processing: 0, done: 0, dead: 0 },
    dangling_links: 0,
    warnings: [],
  };

  let primaryModel = "";

  try {
    const { config, llm } = loadConfig(opts.config);
    health.config = true;
    health.vault_path = config.vault.path;
    health.index_db_path = config.index.db_path;
    health.embeddings_enabled = config.index.embeddings?.enabled === true;
    primaryModel = llm.primary.model;
    line("Config: OK");
    line(`  Vault: ${config.vault.path}`);
    line(`  Index: ${config.index.db_path}`);

    if (!existsSync(config.vault.path)) {
      line("  Vault path missing — creating…");
      mkdirSync(config.vault.path, { recursive: true });
    }

    // LLM primary
    health.llm.primary.baseURL = llm.primary.baseURL;
    health.llm.primary.model = llm.primary.model;
    line(`\n  LLM primary: ${llm.primary.baseURL} / ${llm.primary.model}`);
    if (llm.primary.apiKeyEnv && llm.primary.apiKeyEnv !== "NONE") {
      try {
        resolveApiKey(llm.primary.apiKeyEnv);
        health.llm.primary.apiKeyPresent = true;
        line(`    API key (${llm.primary.apiKeyEnv}): set`);
      } catch {
        health.llm.primary.apiKeyPresent = false;
        line(`    API key (${llm.primary.apiKeyEnv}): MISSING`);
        health.ok = false;
      }
    } else {
      health.llm.primary.apiKeyPresent = true;
      line("    API key: not required");
    }
    try {
      const reachable = await testChatEndpoint(llm.primary);
      health.llm.primary.reachable = reachable;
      line(`    Reachable: ${reachable ? "yes" : "no"}`);
      if (!reachable) health.ok = false;
    } catch (err) {
      health.llm.primary.reachable = false;
      line(`    Reachable: no (${err instanceof Error ? err.message : err})`);
      health.ok = false;
    }

    // LLM fallback
    if (llm.fallback) {
      health.llm.fallback_present = true;
      line(`\n  LLM fallback: ${llm.fallback.baseURL} / ${llm.fallback.model}`);
      if (llm.fallback.apiKeyEnv && llm.fallback.apiKeyEnv !== "NONE") {
        try {
          resolveApiKey(llm.fallback.apiKeyEnv);
          line(`    API key (${llm.fallback.apiKeyEnv}): set`);
        } catch {
          line(`    API key (${llm.fallback.apiKeyEnv}): MISSING (fallback won't work)`);
        }
      }
    }

    // STT
    const stt = config.providers.stt as SttConfig;
    health.stt_provider = stt.provider;
    line(`\n  STT provider: ${stt.provider}`);
    if (stt.baseURL) line(`    baseURL: ${stt.baseURL}`);
    if (stt.model) line(`    model: ${stt.model}`);
    if (stt.language) line(`    language: ${stt.language}`);
    if (stt.apiKeyEnv && stt.apiKeyEnv !== "NONE") {
      try {
        resolveApiKey(stt.apiKeyEnv, false);
        line(`    API key (${stt.apiKeyEnv}): set`);
      } catch {
        line(`    API key (${stt.apiKeyEnv}): optional / not set`);
      }
    }
    if (stt.provider === "nvidia-riva-grpc") {
      if (!stt.function_id) {
        line("    function_id: MISSING");
        health.ok = false;
      } else {
        line(`    function_id: ${stt.function_id}`);
        line(`    server: ${stt.server ?? "grpc.nvcf.nvidia.com:443"}`);
      }
      const venvPython = join(process.cwd(), ".venv-stt", "bin", "python3");
      const checkPython = existsSync(venvPython) ? venvPython : "python3";
      try {
        await execFileAsync(checkPython, ["-c", "import riva.client"]);
        line(`    nvidia-riva-client: installed (${checkPython})`);
      } catch {
        line(
          "    nvidia-riva-client: MISSING — run: python3 -m venv .venv-stt && .venv-stt/bin/pip install -r requirements-stt.txt",
        );
        health.ok = false;
      }
    } else if (stt.provider === "nvidia-nim") {
      line("    API key: optional (required for remote NIM; omit for local container)");
    }

    const index = new DendriteIndex(config.index.db_path);
    const noteCount = (
      index.db.prepare(`SELECT COUNT(*) as c FROM notes`).get() as { c: number }
    ).c;
    const dumpCount = (
      index.db.prepare(`SELECT COUNT(*) as c FROM dumps`).get() as { c: number }
    ).c;
    health.indexed_notes = noteCount;
    health.processed_dumps = dumpCount;
    line(`\n  Indexed notes: ${noteCount}`);
    line(`  Processed dumps: ${dumpCount}`);

    const total = index.listAllNotes().length;
    const embedded = index.countEmbeddings();
    const pct = total ? Math.round((embedded / total) * 100) : 0;
    health.embedding_coverage = { embedded, total, pct };

    health.segment_stats = index.getDumpSegmentStats();
    const last7d = index.getDumpSegmentStats(sevenDaysAgoIso());
    const perDump = estimateCostPerDump(primaryModel);
    const last7dCost =
      Math.round(perDump * last7d.unique_parent_dumps * 1_000_000) / 1_000_000;
    health.cost_estimate = {
      model: primaryModel,
      input_tokens_per_dump: INPUT_TOKENS_PER_DUMP,
      output_tokens_per_dump: OUTPUT_TOKENS_PER_DUMP,
      estimated_cost_usd_per_dump: perDump,
      parent_dumps_last_7d: last7d.unique_parent_dumps,
      estimated_cost_usd_last_7d: last7dCost,
      note: "heuristic estimate — not from provider billing",
    };

    health.queue = index.queueStatusCounts();
    health.dangling_links = countDanglingLinks(config.vault.path, index);

    index.close();

    line(`  Embedding coverage: ${embedded}/${total} (${pct}%)`);
    line(
      `  Avg segments/dump: ${health.segment_stats.avg_segments_per_dump} (${health.segment_stats.total_segment_rows} rows / ${health.segment_stats.unique_parent_dumps} parents)`,
    );
    line(
      `  Cost estimate (${primaryModel}): ~$${perDump.toFixed(6)}/dump, ~$${last7dCost.toFixed(4)} last 7d (estimate)`,
    );
    line(
      `  Queue: pending=${health.queue.pending} processing=${health.queue.processing} dead=${health.queue.dead}`,
    );
    line(`  Dangling links: ${health.dangling_links}`);

    if (health.segment_stats.avg_segments_per_dump > AVG_SEGMENTS_WARN_THRESHOLD) {
      const msg = `Avg segments/dump ${health.segment_stats.avg_segments_per_dump} exceeds ${AVG_SEGMENTS_WARN_THRESHOLD} — possible over-splitting`;
      health.warnings.push(msg);
      health.ok = false;
    }
    if (health.embeddings_enabled && pct < EMBEDDING_COVERAGE_WARN_PCT) {
      const msg = `Embedding coverage ${pct}% below ${EMBEDDING_COVERAGE_WARN_PCT}% while embeddings are enabled`;
      health.warnings.push(msg);
      health.ok = false;
    }
    if (health.warnings.length > 0) {
      line("\n  Warnings:");
      for (const w of health.warnings) line(`    - ${w}`);
    }

    if (opts.stats) {
      const idx = new DendriteIndex(config.index.db_path);
      const corrections = (
        idx.db.prepare(`SELECT COUNT(*) as c FROM corrections`).get() as { c: number }
      ).c;
      const pending = (
        idx.db.prepare(`SELECT COUNT(*) as c FROM ingest_queue WHERE status = 'pending'`).get() as {
          c: number;
        }
      ).c;
      line("\nStats:");
      line(`  Corrections: ${corrections}`);
      line(`  Queue pending: ${pending}`);
      idx.close();
    }
  } catch (err) {
    if (!json) console.error(`Config error: ${err instanceof Error ? err.message : err}`);
    health.ok = false;
  }

  if (json) {
    console.log(JSON.stringify(health, null, 2));
  } else {
    console.log(health.ok ? "\nDoctor: all checks passed" : "\nDoctor: issues found");
  }
  process.exit(health.ok ? 0 : 1);
}
