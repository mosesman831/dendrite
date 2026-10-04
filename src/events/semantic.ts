import type { DendriteConfig, EmbeddingsConfig } from "../config.js";
import { resolveEmbeddingsConfig } from "../config.js";
import { embedQuery, embedTexts } from "../providers/embeddings.js";
import { recall, type RecallOptions, type RecallPack } from "./recall.js";
import type { EventStore } from "./store.js";

export type EmbedFn = (texts: string[]) => Promise<number[][]>;

export interface EmbedEventsResult {
  embedded: number;
  failed: number;
  remaining: number;
  orphans: number;
}

/** Embed events that have no vector for the current model. Safe to run repeatedly (cron). */
export async function embedPendingEvents(
  store: EventStore,
  o: { model: string; embed: EmbedFn; includeSensitive?: boolean; max?: number; batch?: number; log?: (m: string) => void },
): Promise<EmbedEventsResult> {
  const maxP = o.includeSensitive ? "sensitive" : "normal";
  const batch = o.batch ?? 64;
  const max = o.max ?? 5000;
  const orphans = store.pruneOrphanEmbeddings();
  let embedded = 0;
  let failed = 0;
  const skip = new Set<string>();
  while (embedded + failed < max) {
    const pending = store.pendingEmbeddings(o.model, maxP, batch + skip.size).filter((p) => !skip.has(p.id)).slice(0, batch);
    if (!pending.length) break;
    try {
      const vecs = await o.embed(pending.map((p) => p.text.slice(0, 4000)));
      store.db.transaction(() => {
        pending.forEach((p, i) => {
          const v = vecs[i];
          if (v?.length) {
            store.upsertEmbedding(p.id, v, o.model);
            embedded++;
          } else {
            skip.add(p.id);
            failed++;
          }
        });
      })();
    } catch (e) {
      o.log?.(`[embed-events] ${(e as Error).message}`);
      failed += pending.length;
      break;
    }
  }
  const remaining = store.pendingEmbeddings(o.model, maxP, 100_000).length - skip.size;
  return { embedded, failed, remaining: Math.max(0, remaining), orphans };
}

export function eventEmbeddingsConfig(config: DendriteConfig, llmBaseUrl: string): EmbeddingsConfig | null {
  const emb = resolveEmbeddingsConfig(config, llmBaseUrl);
  return emb.enabled && config.index.embeddings.events ? emb : null;
}

/**
 * recall() plus hybrid semantic matching when event embeddings are configured.
 * Any embedding failure degrades to plain FTS recall — recall never fails because a provider is down.
 */
export async function recallHybrid(
  store: EventStore,
  o: RecallOptions,
  emb: EmbeddingsConfig | null,
  opts: { semantic?: boolean; embedQueryFn?: (q: string) => Promise<number[]>; log?: (m: string) => void } = {},
): Promise<RecallPack> {
  if (emb && opts.semantic !== false && o.q && !o.at && store.embeddingCount(emb.model) > 0) {
    try {
      const vector = await (opts.embedQueryFn ?? ((q: string) => embedQuery(q, emb)))(o.q);
      return recall(store, { ...o, vector, semanticModel: emb.model, semanticWeight: o.semanticWeight ?? emb.hybrid_weight });
    } catch (e) {
      opts.log?.(`[recall] semantic disabled for this query: ${(e as Error).message}`);
    }
  }
  return recall(store, o);
}

export const providerEmbedFn = (emb: EmbeddingsConfig): EmbedFn => (texts) => embedTexts(texts, emb);
