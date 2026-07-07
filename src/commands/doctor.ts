import { existsSync, mkdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { loadConfig, resolveApiKey } from "../config.js";
import type { SttConfig } from "../providers/types.js";

const execFileAsync = promisify(execFile);
import { DendriteIndex } from "../pipeline/index.js";
import { testChatEndpoint } from "../providers/llm.js";

export async function runDoctor(opts: { config?: string; stats?: boolean }): Promise<void> {
  let ok = true;

  try {
    const { config, llm } = loadConfig(opts.config);
    console.log("Config: OK");
    console.log(`  Vault: ${config.vault.path}`);
    console.log(`  Index: ${config.index.db_path}`);

    if (!existsSync(config.vault.path)) {
      console.log("  Vault path missing — creating…");
      mkdirSync(config.vault.path, { recursive: true });
    }

    // LLM primary
    console.log(`\n  LLM primary: ${llm.primary.baseURL} / ${llm.primary.model}`);
    if (llm.primary.apiKeyEnv && llm.primary.apiKeyEnv !== "NONE") {
      try {
        resolveApiKey(llm.primary.apiKeyEnv);
        console.log(`    API key (${llm.primary.apiKeyEnv}): set`);
      } catch {
        console.log(`    API key (${llm.primary.apiKeyEnv}): MISSING`);
        ok = false;
      }
    } else {
      console.log("    API key: not required");
    }
    try {
      const reachable = await testChatEndpoint(llm.primary);
      console.log(`    Reachable: ${reachable ? "yes" : "no"}`);
    } catch (err) {
      console.log(`    Reachable: no (${err instanceof Error ? err.message : err})`);
      ok = false;
    }

    // LLM fallback
    if (llm.fallback) {
      console.log(`\n  LLM fallback: ${llm.fallback.baseURL} / ${llm.fallback.model}`);
      if (llm.fallback.apiKeyEnv && llm.fallback.apiKeyEnv !== "NONE") {
        try {
          resolveApiKey(llm.fallback.apiKeyEnv);
          console.log(`    API key (${llm.fallback.apiKeyEnv}): set`);
        } catch {
          console.log(`    API key (${llm.fallback.apiKeyEnv}): MISSING (fallback won't work)`);
        }
      }
    }

    // STT
    const stt = config.providers.stt as SttConfig;
    console.log(`\n  STT provider: ${stt.provider}`);
    if (stt.baseURL) console.log(`    baseURL: ${stt.baseURL}`);
    if (stt.model) console.log(`    model: ${stt.model}`);
    if (stt.language) console.log(`    language: ${stt.language}`);
    if (stt.apiKeyEnv && stt.apiKeyEnv !== "NONE") {
      try {
        resolveApiKey(stt.apiKeyEnv, false);
        console.log(`    API key (${stt.apiKeyEnv}): set`);
      } catch {
        console.log(`    API key (${stt.apiKeyEnv}): optional / not set`);
      }
    }
    if (stt.provider === "nvidia-riva-grpc") {
      if (!stt.function_id) {
        console.log("    function_id: MISSING");
        ok = false;
      } else {
        console.log(`    function_id: ${stt.function_id}`);
        console.log(`    server: ${stt.server ?? "grpc.nvcf.nvidia.com:443"}`);
      }
      const venvPython = join(process.cwd(), ".venv-stt", "bin", "python3");
      const checkPython = existsSync(venvPython) ? venvPython : "python3";
      try {
        await execFileAsync(checkPython, ["-c", "import riva.client"]);
        console.log(`    nvidia-riva-client: installed (${checkPython})`);
      } catch {
        console.log(
          "    nvidia-riva-client: MISSING — run: python3 -m venv .venv-stt && .venv-stt/bin/pip install -r requirements-stt.txt",
        );
        ok = false;
      }
    } else if (stt.provider === "nvidia-nim") {
      console.log("    API key: optional (required for remote NIM; omit for local container)");
    }

    const index = new DendriteIndex(config.index.db_path);
    const noteCount = (
      index.db.prepare(`SELECT COUNT(*) as c FROM notes`).get() as { c: number }
    ).c;
    const dumpCount = (
      index.db.prepare(`SELECT COUNT(*) as c FROM dumps`).get() as { c: number }
    ).c;
    console.log(`\n  Indexed notes: ${noteCount}`);
    console.log(`  Processed dumps: ${dumpCount}`);
    index.close();

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
      console.log("\nStats:");
      console.log(`  Corrections: ${corrections}`);
      console.log(`  Queue pending: ${pending}`);
      idx.close();
    }
  } catch (err) {
    console.error(`Config error: ${err instanceof Error ? err.message : err}`);
    ok = false;
  }

  console.log(ok ? "\nDoctor: all checks passed" : "\nDoctor: issues found");
  process.exit(ok ? 0 : 1);
}
