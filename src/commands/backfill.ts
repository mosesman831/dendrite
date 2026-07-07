import { loadConfig } from "../config.js";
import {
  createImportContext,
  finalizeVaultImport,
  findBackfillCandidates,
  processVaultCandidates,
  type VaultImportResult,
} from "./vault-import.js";

export type { VaultImportResult as BackfillResult } from "./vault-import.js";
export { findBackfillCandidates } from "./vault-import.js";

export interface BackfillOptions {
  config?: string;
  dryRun?: boolean;
  move?: boolean;
}

export async function runBackfill(opts: BackfillOptions): Promise<VaultImportResult[]> {
  const { config, configDir, llm } = loadConfig(opts.config);
  const ctx = createImportContext(config, configDir, llm, opts.dryRun);
  const candidates = findBackfillCandidates(config.vault.path);
  const results: VaultImportResult[] = [];

  if (candidates.length === 0) {
    console.log("No unprocessed notes found.");
    ctx.index.close();
    return results;
  }

  console.log(`Found ${candidates.length} note(s) to process:\n`);

  try {
    const batch = await processVaultCandidates(candidates, config.vault.path, ctx, {
      dryRun: opts.dryRun,
      archive: opts.move !== false,
    });
    results.push(...batch);
    await finalizeVaultImport(ctx, config, opts.dryRun);
  } finally {
    ctx.index.close();
  }

  const filed = results.filter((r) => r.status === "filed").length;
  console.log(`\nDone: ${filed} filed, ${results.length - filed} skipped/other.`);
  return results;
}
