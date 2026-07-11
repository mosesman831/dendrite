import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { loadConfig, resolveApiKey } from "../config.js";
import type { SttConfig } from "../providers/types.js";

const execFileAsync = promisify(execFile);
import { DendriteIndex } from "../pipeline/index.js";
import { testChatEndpoint } from "../providers/llm.js";

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
    embedding_coverage: { embedded: number; total: number; pct: number };
    queue: { pending: number; processing: number; done: number; dead: number };
    dangling_links: number;
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
    embedding_coverage: { embedded: 0, total: 0, pct: 0 },
    queue: { pending: 0, processing: 0, done: 0, dead: 0 },
    dangling_links: 0,
  };

  try {
    const { config, llm } = loadConfig(opts.config);
    health.config = true;
    health.vault_path = config.vault.path;
    health.index_db_path = config.index.db_path;
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

    // NEW health metrics
    const total = index.listAllNotes().length;
    const embedded = index.countEmbeddings();
    const pct = total ? Math.round((embedded / total) * 100) : 0;
    health.embedding_coverage = { embedded, total, pct };

    health.queue = index.queueStatusCounts();
    health.dangling_links = countDanglingLinks(config.vault.path, index);

    index.close();

    line(`  Embedding coverage: ${embedded}/${total} (${pct}%)`);
    line(
      `  Queue: pending=${health.queue.pending} processing=${health.queue.processing} dead=${health.queue.dead}`,
    );
    line(`  Dangling links: ${health.dangling_links}`);

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
