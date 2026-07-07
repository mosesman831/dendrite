import { loadConfig } from "../config.js";
import { DendriteIndex } from "../pipeline/index.js";
import { writeVaultCatalog } from "../pipeline/catalog.js";

export async function runReindex(opts: { config?: string }): Promise<void> {
  const { config } = loadConfig(opts.config);
  const index = new DendriteIndex(config.index.db_path);
  const count = index.reindexVault(config.vault.path);
  const catalog = writeVaultCatalog(config.vault.path, index);
  console.log(`Reindexed ${count} notes from ${config.vault.path}`);
  console.log(`Catalog written to ${catalog}`);
  index.close();
}
