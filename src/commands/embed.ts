import { readFileSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import { loadConfig, resolveEmbeddingsConfig } from "../config.js";
import { DendriteIndex, isSystemNotePath } from "../pipeline/index.js";
import { embedTexts } from "../providers/embeddings.js";
import { walkVaultNotes } from "../util/vault-path.js";

export interface EmbedOptions {
  config?: string;
  force?: boolean;
}

export async function runEmbed(opts: EmbedOptions = {}): Promise<void> {
  const { config, llm } = loadConfig(opts.config);
  const embConfig = resolveEmbeddingsConfig(config, llm.primary.baseURL);

  if (!embConfig.enabled) {
    console.error("Embeddings disabled. Set index.embeddings.enabled: true in config.");
    process.exit(1);
  }

  const index = new DendriteIndex(config.index.db_path);
  const notes = walkVaultNotes(config.vault.path).filter((rel) => !isSystemNotePath(rel));
  const existing = new Set(opts.force ? [] : index.listEmbeddingPaths());

  const toEmbed: Array<{ path: string; text: string }> = [];
  for (const rel of notes) {
    if (existing.has(rel)) continue;
    const abs = join(config.vault.path, rel);
    const raw = readFileSync(abs, "utf8");
    const { data, content } = matter(raw);
    const title = String(data.title ?? rel);
    const summary = String(data.summary ?? "");
    const body = content.replace(/\s+/g, " ").slice(0, 500);
    toEmbed.push({ path: rel, text: `${title}\n${summary}\n${body}`.trim() });
  }

  if (toEmbed.length === 0) {
    console.log(`All ${notes.length} notes already embedded. Use --force to rebuild.`);
    index.close();
    return;
  }

  console.log(`Embedding ${toEmbed.length} note(s) with ${embConfig.model}…`);

  const batchSize = 32;
  let done = 0;

  try {
    for (let i = 0; i < toEmbed.length; i += batchSize) {
      const batch = toEmbed.slice(i, i + batchSize);
      const vectors = await embedTexts(
        batch.map((b) => b.text),
        embConfig,
      );
      for (let j = 0; j < batch.length; j++) {
        const item = batch[j]!;
        const vec = vectors[j];
        if (!vec) continue;
        index.upsertEmbedding(item.path, vec, embConfig.model);
        done++;
      }
      console.log(`  ${Math.min(i + batchSize, toEmbed.length)}/${toEmbed.length}`);
    }
    console.log(`\nDone: ${done} embedding(s) stored (${index.countEmbeddings()} total).`);
  } finally {
    index.close();
  }
}
