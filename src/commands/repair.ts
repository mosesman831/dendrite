import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import matter from "gray-matter";
import { loadConfig } from "../config.js";
import { createPipelineContext, processDump } from "../pipeline/pipeline.js";
import { writeVaultCatalog } from "../pipeline/catalog.js";
import {
  findJunkDrawers,
  formatRepairPreview,
  type JunkDrawerCandidate,
  type RepairOptions,
} from "../pipeline/repair-detect.js";
import { parseCaptureSections } from "../util/note-sections.js";
import { hashId } from "../util/slug.js";
import type { Dump } from "../types.js";

export interface RepairResult {
  sourcePath: string;
  status: "repaired" | "skipped" | "error";
  segments?: number;
  targets?: string[];
  detail?: string;
}

export interface RunRepairOptions extends RepairOptions {
  config?: string;
  dryRun?: boolean;
}

export async function runRepair(opts: RunRepairOptions = {}): Promise<RepairResult[]> {
  const { config, configDir, llm } = loadConfig(opts.config);
  const detectOpts: RepairOptions = {
    minSections: opts.minSections ?? config.repair.min_sections,
    maxTitleRelevance: opts.maxTitleRelevance ?? config.repair.max_title_relevance,
    notePath: opts.notePath,
  };
  const ctx = createPipelineContext(config, configDir, llm, opts.dryRun);
  const candidates = findJunkDrawers(config.vault.path, detectOpts);
  const results: RepairResult[] = [];

  if (candidates.length === 0) {
    console.log("No junk-drawer notes detected.");
    ctx.index.close();
    return results;
  }

  console.log(formatRepairPreview(candidates));
  console.log("");

  try {
    for (const candidate of candidates) {
      const result = await repairOneNote(config.vault.path, candidate, ctx, !!opts.dryRun);
      results.push(result);
      if (result.status === "repaired") {
        console.log(
          `  ${opts.dryRun ? "would repair" : "repaired"} ${candidate.path} → ${result.segments} note(s)`,
        );
        for (const t of result.targets ?? []) console.log(`      → ${t}`);
      } else {
        console.log(`  ${result.status} ${candidate.path}${result.detail ? `: ${result.detail}` : ""}`);
      }
    }

    if (!opts.dryRun) {
      ctx.index.reindexVault(config.vault.path);
      writeVaultCatalog(config.vault.path, ctx.index);
      console.log("\nReindexed vault and updated catalog.");
    }
  } finally {
    ctx.index.close();
  }

  const repaired = results.filter((r) => r.status === "repaired").length;
  console.log(`\nDone: ${repaired} repaired, ${results.length - repaired} skipped/other.`);
  if (opts.dryRun && repaired > 0) console.log("(dry-run: nothing written)");
  return results;
}

async function repairOneNote(
  vaultPath: string,
  candidate: JunkDrawerCandidate,
  ctx: ReturnType<typeof createPipelineContext>,
  dryRun: boolean,
): Promise<RepairResult> {
  const abs = join(vaultPath, candidate.path);
  const raw = readFileSync(abs, "utf8");
  const { data, content } = matter(raw);
  const sections = parseCaptureSections(content);

  if (sections.length < 2) {
    return { sourcePath: candidate.path, status: "skipped", detail: "not enough sections" };
  }

  const targets: string[] = [];
  const repairGroup = `repair-${hashId(candidate.path)}`;

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i]!;
    if (!section.body.trim()) continue;

    const dump: Dump = {
      id: `${repairGroup}#${i}`,
      source: "cli",
      receivedAt: section.receivedAt ?? new Date().toISOString(),
      text: section.body,
      meta: { repair_source: candidate.path, repair_section: i },
    };

    try {
      const pipelineResults = await processDump(ctx, dump, { forceCreateNew: true });
      const active = pipelineResults.filter((r) => !r.duplicate);
      for (const r of active) targets.push(r.notePath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { sourcePath: candidate.path, status: "error", detail: msg };
    }
  }

  if (targets.length === 0) {
    return { sourcePath: candidate.path, status: "skipped", detail: "no segments filed" };
  }

  if (!dryRun) {
    archiveRepairedSource(vaultPath, candidate.path);
    const stubPath = join(vaultPath, candidate.path);
    const stubBody = [
      `# ${data.title ?? candidate.title} (repaired)`,
      "",
      `> This note was a junk drawer with ${sections.length} unrelated captures.`,
      `> Sections were split into ${targets.length} note(s) on ${new Date().toISOString().slice(0, 10)}.`,
      "",
      "## Filed to",
      ...targets.map((t) => `- [[${t.replace(/\.md$/, "").split("/").pop()}]]`),
    ].join("\n");
    const stubFm = {
      ...data,
      compartment: data.compartment ?? "memories",
      updated: new Date().toISOString(),
      repair_redirect: targets,
      dendrite_version: data.dendrite_version ?? 1,
    };
    writeFileSync(stubPath, matter.stringify(stubBody, stubFm), "utf8");
  }

  return {
    sourcePath: candidate.path,
    status: "repaired",
    segments: targets.length,
    targets,
  };
}

function archiveRepairedSource(vaultPath: string, rel: string): void {
  const src = join(vaultPath, rel);
  if (!existsSync(src)) return;
  const dest = join(vaultPath, "brain/_dendrite/repaired", rel);
  mkdirSync(dirname(dest), { recursive: true });
  const backup = readFileSync(src, "utf8");
  writeFileSync(dest, backup, "utf8");
}

export { findJunkDrawers, formatRepairPreview };
