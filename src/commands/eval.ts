import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../config.js";
import { createPipelineContext, processDump } from "../pipeline/pipeline.js";
import type { Dump } from "../types.js";

interface EvalCase {
  text: string;
  expected?: string;
  expected_min_segments?: number;
  note?: string;
}

interface CaseResult {
  text: string;
  expected?: string;
  expected_min_segments?: number;
  got?: string;
  segments: number;
  pass: boolean;
  error?: string;
}

export interface EvalOptions {
  config?: string;
  limit?: string;
  min?: string;
  json?: boolean;
  dataset?: string;
}

export async function runEval(opts: EvalOptions): Promise<void> {
  const datasetPath = opts.dataset
    ? resolve(opts.dataset)
    : resolve(process.cwd(), "eval/dataset.jsonl");

  if (!existsSync(datasetPath)) {
    console.error(`Dataset not found: ${datasetPath}`);
    process.exit(1);
  }

  const raw = readFileSync(datasetPath, "utf8");
  const cases: EvalCase[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line || line.startsWith("#")) continue;
    try {
      cases.push(JSON.parse(line) as EvalCase);
    } catch {
      console.warn(`Skipping unparseable line ${i + 1}: ${line.slice(0, 60)}`);
    }
  }

  const limit = opts.limit !== undefined ? parseInt(opts.limit, 10) : undefined;
  const selected =
    limit !== undefined && Number.isFinite(limit) && limit >= 0
      ? cases.slice(0, limit)
      : cases;

  const min = opts.min !== undefined ? parseFloat(opts.min) : undefined;

  const { config, configDir, llm } = loadConfig(opts.config);
  const ctx = createPipelineContext(config, configDir, llm, true);

  const results: CaseResult[] = [];
  const breakdown = new Map<string, { correct: number; total: number }>();

  try {
    for (let i = 0; i < selected.length; i++) {
      const c = selected[i]!;
      const dump: Dump = {
        id: `eval-${i}-${Date.now()}`,
        source: "cli",
        receivedAt: new Date().toISOString(),
        text: c.text,
      };

      let entry: CaseResult;
      try {
        const pipelineResults = await processDump(ctx, dump);
        const segments = pipelineResults.length;
        if (c.expected !== undefined) {
          const got = pipelineResults[0]?.compartment;
          const pass = pipelineResults.some((r) => r.compartment === c.expected);
          entry = { text: c.text, expected: c.expected, got, segments, pass };
        } else if (c.expected_min_segments !== undefined) {
          const pass = segments >= c.expected_min_segments;
          entry = {
            text: c.text,
            expected_min_segments: c.expected_min_segments,
            segments,
            pass,
          };
        } else {
          entry = { text: c.text, segments, pass: false, error: "case has no expectation" };
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        entry = {
          text: c.text,
          expected: c.expected,
          expected_min_segments: c.expected_min_segments,
          segments: 0,
          pass: false,
          error: message,
        };
      }

      if (entry.expected !== undefined) {
        const stat = breakdown.get(entry.expected) ?? { correct: 0, total: 0 };
        stat.total += 1;
        if (entry.pass) stat.correct += 1;
        breakdown.set(entry.expected, stat);
      }

      results.push(entry);
    }
  } finally {
    ctx.index.close();
  }

  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  const failed = total - passed;
  const accuracy = total > 0 ? passed / total : 0;

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          total,
          passed,
          failed,
          accuracy,
          min: min ?? null,
          cases: results.map((r) => {
            const out: CaseResult = {
              text: r.text,
              segments: r.segments,
              pass: r.pass,
            };
            if (r.expected !== undefined) out.expected = r.expected;
            if (r.expected_min_segments !== undefined)
              out.expected_min_segments = r.expected_min_segments;
            if (r.got !== undefined) out.got = r.got;
            if (r.error !== undefined) out.error = r.error;
            return out;
          }),
        },
        null,
        2,
      ),
    );
  } else {
    for (const r of results) {
      const snippet = r.text.length > 60 ? `${r.text.slice(0, 57)}…` : r.text;
      const label = r.expected ?? `>=${r.expected_min_segments} segments`;
      if (r.pass) {
        console.log(`✓ ${label}  ← "${snippet}"`);
      } else if (r.error) {
        console.log(`✗ ${label} (error: ${r.error})  ← "${snippet}"`);
      } else if (r.expected !== undefined) {
        console.log(`✗ ${label} (got ${r.got ?? "none"})  ← "${snippet}"`);
      } else {
        console.log(`✗ ${label} (got ${r.segments} segments)  ← "${snippet}"`);
      }
    }

    console.log("");
    console.log(`Total: ${total}  Passed: ${passed}  Failed: ${failed}`);

    if (breakdown.size > 0) {
      console.log("\nPer-compartment accuracy:");
      for (const [compartment, stat] of [...breakdown.entries()].sort()) {
        const pct = stat.total > 0 ? ((stat.correct / stat.total) * 100).toFixed(0) : "0";
        console.log(`  ${compartment}: ${stat.correct}/${stat.total} (${pct}%)`);
      }
    }

    console.log(`\nAccuracy: ${(accuracy * 100).toFixed(1)}%`);
    if (min !== undefined) {
      console.log(`Threshold: ${(min * 100).toFixed(1)}% → ${accuracy >= min ? "PASS" : "FAIL"}`);
    }
  }

  if (min !== undefined && Number.isFinite(min)) {
    process.exit(accuracy >= min ? 0 : 1);
  }
}
