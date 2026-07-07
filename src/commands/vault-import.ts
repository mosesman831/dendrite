import { existsSync, mkdirSync, readFileSync, renameSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import matter from "gray-matter";
import { isSystemNotePath } from "../pipeline/index.js";
import { createPipelineContext, processDump } from "../pipeline/pipeline.js";
import { writeVaultCatalog } from "../pipeline/catalog.js";
import { hashId } from "../util/slug.js";
import type { Dump } from "../types.js";
import type { DendriteConfig } from "../config.js";
import type { LlmEndpoints } from "../config.js";
import type { PipelineContext } from "../pipeline/pipeline.js";

export interface VaultImportResult {
  path: string;
  status: "filed" | "skipped" | "duplicate" | "error";
  notePath?: string;
  compartment?: string;
  detail?: string;
}

/** Notes Dendrite has not filed — outside brain/ or missing dendrite frontmatter. */
export function findBackfillCandidates(vaultPath: string): string[] {
  const out: string[] = [];

  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.endsWith(".md")) {
        const rel = relative(vaultPath, full).replace(/\\/g, "/");
        if (isSystemNotePath(rel)) continue;
        if (shouldBackfill(vaultPath, rel)) out.push(rel);
      }
    }
  };

  walk(vaultPath);
  return out.sort();
}

/** Inbox notes awaiting review — re-classify into proper compartments. */
export function findInboxCandidates(vaultPath: string): string[] {
  const inboxDir = join(vaultPath, "brain/inbox");
  const out: string[] = [];

  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.endsWith(".md")) {
        const rel = relative(vaultPath, full).replace(/\\/g, "/");
        if (!isSystemNotePath(rel)) out.push(rel);
      }
    }
  };

  walk(inboxDir);
  return out.sort();
}

export type SortScope = "all" | "inbox" | "imports";

export function findSortCandidates(vaultPath: string, scope: SortScope = "all"): string[] {
  const out: string[] = [];
  if (scope === "all" || scope === "inbox") {
    out.push(...findInboxCandidates(vaultPath));
  }
  if (scope === "all" || scope === "imports") {
    out.push(...findBackfillCandidates(vaultPath));
  }
  return [...new Set(out)].sort();
}

function shouldBackfill(vaultPath: string, rel: string): boolean {
  const raw = readFileSync(join(vaultPath, rel), "utf8");
  const { data } = matter(raw);

  if (data.dendrite_version) return false;

  if (rel.startsWith("brain/") && data.compartment) return false;

  if (rel.startsWith("brain/scratch/")) return true;
  if (!rel.startsWith("brain/")) return true;

  return false;
}

export interface ProcessVaultOptions {
  dryRun?: boolean;
  archive?: boolean;
  label?: string;
}

export async function processVaultCandidates(
  candidates: string[],
  vaultPath: string,
  ctx: PipelineContext,
  opts: ProcessVaultOptions = {},
): Promise<VaultImportResult[]> {
  const results: VaultImportResult[] = [];
  const archive = opts.archive !== false;

  for (const rel of candidates) {
    const abs = join(vaultPath, rel);
    const raw = readFileSync(abs, "utf8");
    const { content } = matter(raw);
    const text = content.trim() || raw.trim();

    if (!text) {
      results.push({ path: rel, status: "skipped", detail: "empty" });
      console.log(`  skip  ${rel} (empty)`);
      continue;
    }

    const dump: Dump = {
      id: `sort-${hashId(rel)}`,
      source: "cli",
      receivedAt: statSync(abs).mtime.toISOString(),
      text: `# ${basenameTitle(rel)}\n\n${text}`,
      meta: { sort_source: rel },
    };

    try {
      const pipelineResults = await processDump(ctx, dump, { forceCreateNew: true });

      if (pipelineResults.every((r) => r.duplicate)) {
        results.push({
          path: rel,
          status: "duplicate",
          notePath: pipelineResults[0]?.notePath,
        });
        console.log(`  dup   ${rel} → already filed`);
        continue;
      }

      const active = pipelineResults.filter((r) => !r.duplicate);
      for (const result of active) {
        results.push({
          path: rel,
          status: "filed",
          notePath: result.notePath,
          compartment: result.compartment,
        });
      }
      console.log(
        `  filed ${rel} → ${active.length} note(s): ${active.map((r) => r.notePath).join(", ")}`,
      );

      if (!opts.dryRun && archive && active.length > 0) {
        archiveSource(vaultPath, rel);
        console.log(`        archived original → brain/_dendrite/imported/${rel}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ path: rel, status: "error", detail: msg });
      console.log(`  error ${rel}: ${msg}`);
    }
  }

  return results;
}

export async function finalizeVaultImport(
  ctx: PipelineContext,
  config: DendriteConfig,
  dryRun?: boolean,
): Promise<void> {
  if (!dryRun) {
    ctx.index.reindexVault(config.vault.path);
    writeVaultCatalog(config.vault.path, ctx.index);
    console.log("\nReindexed vault and updated catalog.");
  }
}

export function createImportContext(
  config: DendriteConfig,
  configDir: string,
  llm: LlmEndpoints,
  dryRun?: boolean,
): PipelineContext {
  return createPipelineContext(config, configDir, llm, dryRun);
}

function basenameTitle(rel: string): string {
  return rel
    .replace(/\.md$/i, "")
    .split("/")
    .pop()!
    .replace(/-/g, " ");
}

function archiveSource(vaultPath: string, rel: string): void {
  const src = join(vaultPath, rel);
  const dest = join(vaultPath, "brain/_dendrite/imported", rel);
  mkdirSync(dirname(dest), { recursive: true });
  renameSync(src, dest);
}
