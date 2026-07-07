import { loadConfig } from "../config.js";
import { DendriteIndex } from "../pipeline/index.js";
import { migrateNoteFile } from "../pipeline/migrations.js";
import { walkVaultNotes } from "../util/vault-path.js";
import { writeVaultCatalog } from "../pipeline/catalog.js";

export interface MigrateOptions {
  config?: string;
  dryRun?: boolean;
}

export async function runMigrate(opts: MigrateOptions = {}): Promise<void> {
  const { config } = loadConfig(opts.config);
  const notes = walkVaultNotes(config.vault.path, (rel) => rel.startsWith("brain/"));
  const index = new DendriteIndex(config.index.db_path);

  let migrated = 0;
  let skipped = 0;

  console.log(
    opts.dryRun
      ? `Dry-run: checking ${notes.length} brain note(s) for frontmatter migrations…\n`
      : `Migrating frontmatter for ${notes.length} brain note(s)…\n`,
  );

  try {
    for (const rel of notes) {
      const result = migrateNoteFile(config.vault.path, rel, !!opts.dryRun);
      if (!result) {
        skipped++;
        continue;
      }
      migrated++;
      console.log(
        `  ${opts.dryRun ? "would migrate" : "migrated"} ${rel} (v${result.fromVersion} → v${result.toVersion})`,
      );
      for (const c of result.changes) console.log(`    · ${c}`);
    }

    if (!opts.dryRun && migrated > 0) {
      index.reindexVault(config.vault.path);
      writeVaultCatalog(config.vault.path, index);
      console.log("\nReindexed vault and updated catalog.");
    }

    console.log(`\nDone: ${migrated} migrated, ${skipped} already current.`);
    if (opts.dryRun && migrated > 0) console.log("(dry-run: nothing written)");
  } finally {
    index.close();
  }
}
