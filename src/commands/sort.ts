import { loadConfig } from "../config.js";
import {
  findSortCandidates,
  processVaultCandidates,
  finalizeVaultImport,
  createImportContext,
  type SortScope,
  type VaultImportResult,
} from "./vault-import.js";

export interface SortOptions {
  config?: string;
  dryRun?: boolean;
  keepSource?: boolean;
  scope?: SortScope;
}

export interface SortPreview {
  candidateCount: number;
  scopeLabel: string;
  candidates: string[];
  results: VaultImportResult[];
  filedCount: number;
  noteCount: number;
}

export async function previewSort(opts: SortOptions = {}): Promise<SortPreview> {
  const { config, configDir, llm } = loadConfig(opts.config);
  const scope = opts.scope ?? "all";
  const ctx = createImportContext(config, configDir, llm, true);
  const candidates = findSortCandidates(config.vault.path, scope);

  const scopeLabel =
    scope === "inbox" ? "inbox" : scope === "imports" ? "unfiled imports" : "inbox + unfiled imports";

  if (candidates.length === 0) {
    ctx.index.close();
    return {
      candidateCount: 0,
      scopeLabel,
      candidates: [],
      results: [],
      filedCount: 0,
      noteCount: 0,
    };
  }

  try {
    const results = await processVaultCandidates(candidates, config.vault.path, ctx, {
      dryRun: true,
      archive: false,
    });
    const filedCount = results.filter((r) => r.status === "filed").length;
    const noteCount = new Set(results.filter((r) => r.notePath).map((r) => r.notePath)).size;
    return { candidateCount: candidates.length, scopeLabel, candidates, results, filedCount, noteCount };
  } finally {
    ctx.index.close();
  }
}

export function formatSortPreviewTelegram(preview: SortPreview): string {
  if (preview.candidateCount === 0) {
    return "Nothing to sort — vault is dendrite-ready.";
  }
  const lines = [
    `*Sort preview* (${preview.scopeLabel})`,
    `${preview.candidateCount} source note(s) → ${preview.filedCount} segment(s) into ${preview.noteCount} note(s):`,
    "",
  ];
  for (const r of preview.results.filter((x) => x.status === "filed").slice(0, 12)) {
    lines.push(`• \`${r.notePath}\` ← ${r.path}`);
  }
  if (preview.filedCount > 12) lines.push(`… and ${preview.filedCount - 12} more`);
  return lines.join("\n");
}

export async function runSort(opts: SortOptions = {}): Promise<VaultImportResult[]> {
  const { config, configDir, llm } = loadConfig(opts.config);
  const scope = opts.scope ?? "all";
  const ctx = createImportContext(config, configDir, llm, opts.dryRun);
  const candidates = findSortCandidates(config.vault.path, scope);
  const results: VaultImportResult[] = [];

  if (candidates.length === 0) {
    console.log("Nothing to sort — vault is dendrite-ready.");
    ctx.index.close();
    return results;
  }

  const scopeLabel =
    scope === "inbox" ? "inbox" : scope === "imports" ? "unfiled imports" : "inbox + unfiled imports";
  console.log(`Sorting ${candidates.length} note(s) (${scopeLabel}) via LLM:\n`);

  try {
    const batch = await processVaultCandidates(candidates, config.vault.path, ctx, {
      dryRun: opts.dryRun,
      archive: !opts.keepSource,
    });
    results.push(...batch);
    await finalizeVaultImport(ctx, config, opts.dryRun);
  } finally {
    ctx.index.close();
  }

  const filed = results.filter((r) => r.status === "filed").length;
  const notes = new Set(results.filter((r) => r.notePath).map((r) => r.notePath)).size;
  console.log(`\nDone: ${filed} segment(s) filed into ${notes} note(s).`);
  if (opts.dryRun) console.log("(dry-run: nothing written)");
  return results;
}
