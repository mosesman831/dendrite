import type { DendriteConfig } from "../config.js";
import { resolveEmbeddingsConfig } from "../config.js";
import type { LlmEndpoints } from "../config.js";
import type { DendriteIndex } from "./index.js";
import type { SearchHit } from "../types.js";
import { embedQuery } from "../providers/embeddings.js";

export async function smartSearch(
  index: DendriteIndex,
  query: string,
  config: DendriteConfig,
  llm: LlmEndpoints,
  opts?: {
    compartment?: string;
    limit?: number;
    excludeEphemeral?: boolean;
  },
): Promise<SearchHit[]> {
  const emb = resolveEmbeddingsConfig(config, llm.primary.baseURL);
  if (!emb.enabled || index.countEmbeddings() === 0) {
    return index.search(query, opts?.compartment, opts?.limit ?? 5, {
      excludeEphemeral: opts?.excludeEphemeral,
    });
  }

  try {
    const queryVector = await embedQuery(query, emb);
    return index.search(query, opts?.compartment, opts?.limit ?? 5, {
      excludeEphemeral: opts?.excludeEphemeral,
      queryVector,
      hybridWeight: emb.hybrid_weight,
    });
  } catch {
    return index.search(query, opts?.compartment, opts?.limit ?? 5, {
      excludeEphemeral: opts?.excludeEphemeral,
    });
  }
}
