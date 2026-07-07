import type { Classification } from "../types.js";
import type { DendriteIndex } from "./index.js";
import type { DendriteConfig } from "../config.js";
import type { LlmEndpoints } from "../config.js";
import { smartSearch } from "./search.js";
import { wikilink } from "../util/slug.js";

export async function crosslink(
  classification: Classification,
  index: DendriteIndex,
  config?: DendriteConfig,
  llm?: LlmEndpoints,
  limit = 3,
  scoreFloor = 0.3,
): Promise<string[]> {
  const query = [classification.title, ...classification.entities].join(" ");
  const hits =
    config && llm
      ? await smartSearch(index, query, config, llm, {
          limit: limit + classification.links.length + 5,
          excludeEphemeral: true,
        })
      : index.search(query, undefined, limit + classification.links.length + 5, {
          excludeEphemeral: true,
        });

  const links = new Set<string>();

  for (const slug of classification.links) {
    if (/^\d{2}-\d{2}-\d{4}$/.test(slug)) continue;
    links.add(wikilink(slug));
  }

  for (const hit of hits) {
    if (hit.score < scoreFloor) continue;
    const slug = hit.path.replace(/\.md$/, "").split("/").pop() ?? hit.path;
    links.add(wikilink(slug));
    if (links.size >= limit) break;
  }

  return [...links];
}
