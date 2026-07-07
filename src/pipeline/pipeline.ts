import { unlinkSync } from "node:fs";
import type { Classification, Dump, PipelineResult, Segment } from "../types.js";
import type { DendriteConfig, LlmEndpoints } from "../config.js";
import { loadCompartments } from "../config.js";
import { createChatProvider } from "../providers/llm.js";
import { createTranscriber } from "../providers/transcribe.js";
import { DendriteIndex } from "./index.js";
import { classifyDump } from "./classify.js";
import {
  classifyDumpMulti,
  segmentToClassification,
  shouldShortCircuitMulti,
} from "./multi-classify.js";
import { resolveTarget } from "./resolve.js";
import { crosslink } from "./crosslink.js";
import { writeNote, addBacklink } from "./write.js";
import { writeVaultCatalog } from "./catalog.js";
import { parseWikilink, wikilink } from "../util/slug.js";

export interface PipelineContext {
  config: DendriteConfig;
  configDir: string;
  llm: LlmEndpoints;
  index: DendriteIndex;
  dryRun?: boolean;
}

export function createPipelineContext(
  config: DendriteConfig,
  configDir: string,
  llm: LlmEndpoints,
  dryRun = false,
): PipelineContext {
  const index = new DendriteIndex(config.index.db_path);
  return { config, configDir, llm, index, dryRun };
}

export async function processDump(
  ctx: PipelineContext,
  dump: Dump,
  opts?: { forceCreateNew?: boolean },
): Promise<PipelineResult[]> {
  const { config, configDir, index, dryRun } = ctx;
  const compartments = loadCompartments(config, configDir);
  const parentId = dump.id;

  if (index.isDumpFamilyProcessed(parentId)) {
    return index.getDumpFamily(parentId).map((row, i, arr) => ({
      dumpId: row.id,
      notePath: row.note_path,
      compartment: row.compartment,
      confidence: row.confidence,
      tier: confidenceTier(row.confidence, config),
      summary: "Already processed",
      links: [],
      created: false,
      duplicate: true,
      parentDumpId: parentId,
      segmentIndex: i,
      siblingCount: arr.length,
    }));
  }

  if (dump.audioPath && !dump.text) {
    const transcriber = createTranscriber(config);
    dump.text = await transcriber.transcribe(dump.audioPath);
    if (!config.voice.keep_audio) {
      try {
        unlinkSync(dump.audioPath);
      } catch {
        /* ignore */
      }
    }
  }

  if (!dump.text?.trim()) {
    throw new Error("Dump has no text content");
  }

  const transcript = dump.text.trim();
  const chat = createChatProvider(ctx.llm);
  const corrections = index.getRecentCorrections(5);
  const preSearch = index.search(dump.text.slice(0, 300), undefined, 8, { excludeEphemeral: true });
  const candidateNotes = preSearch.map((h) => `${h.path} — ${h.title}`);
  const vaultIndex = index.vaultIndexSummary(8);

  let segments: Segment[];

  const splitEnabled = config.classification.split.enabled;
  const shortCircuit = shouldShortCircuitMulti(dump.text, config);

  if (splitEnabled && !shortCircuit) {
    segments = await classifyDumpMulti(
      dump,
      compartments,
      chat,
      config,
      corrections,
      candidateNotes,
      vaultIndex,
    );
  } else if (splitEnabled && shortCircuit) {
    const single = await classifyDump(
      dump,
      compartments,
      chat,
      config,
      corrections,
      candidateNotes,
      vaultIndex,
    );
    segments = [{ ...single, text: dump.text.trim() }];
  } else {
    const single = await classifyDump(
      dump,
      compartments,
      chat,
      config,
      corrections,
      candidateNotes,
      vaultIndex,
    );
    segments = [{ ...single, text: dump.text.trim() }];
  }

  if (opts?.forceCreateNew) {
    for (const seg of segments) {
      seg.note_action = "create_new";
      seg.target_note = null;
    }
  }

  // Resolve all targets first (for sibling cross-linking)
  const resolved: Array<{
    segment: Segment;
    classification: Classification;
    target: Awaited<ReturnType<typeof resolveTarget>>;
    childDump: Dump;
  }> = [];

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    const classification = segmentToClassification(segment);
    const childDump: Dump = {
      ...dump,
      id: segments.length === 1 ? parentId : `${parentId}#${i}`,
      text: segment.text.trim(),
    };

    if (!opts?.forceCreateNew && classification.note_action !== "create_new") {
      const nearDup = index.findNearDuplicate(
        childDump.text!,
        classification.compartment,
        config.classification.strong_match_threshold,
      );
      if (nearDup) {
        classification.note_action = "append_existing";
        classification.target_note =
          nearDup.path.replace(/\.md$/, "").split("/").pop() ?? null;
      }
    }

    const target = await resolveTarget(
      childDump,
      classification,
      compartments,
      config,
      index,
      config.vault.path,
      chat,
    );

    resolved.push({ segment, classification, target, childDump });
  }

  const siblingSlugs = resolved.map((r) => r.target.slug);

  const results: PipelineResult[] = [];

  for (let i = 0; i < resolved.length; i++) {
    const { segment, classification, target, childDump } = resolved[i]!;
    const links = await crosslink(classification, index, config, ctx.llm);

    // Sibling cross-links
    for (let j = 0; j < siblingSlugs.length; j++) {
      if (j !== i && siblingSlugs[j]) {
        links.push(wikilink(siblingSlugs[j]!));
      }
    }
    const uniqueLinks = [...new Set(links)];

    const tier = confidenceTier(classification.confidence, config);

    if (dryRun) {
      results.push({
        dumpId: childDump.id,
        notePath: target.notePath,
        compartment: target.compartment,
        confidence: classification.confidence,
        tier,
        summary: classification.summary,
        transcript: i === 0 ? transcript : undefined,
        links: uniqueLinks,
        created: target.action === "create_new",
        parentDumpId: segments.length > 1 ? parentId : undefined,
        segmentIndex: segments.length > 1 ? i : undefined,
        siblingCount: segments.length > 1 ? segments.length : undefined,
      });
      continue;
    }

    const writeResult = writeNote(
      config.vault.path,
      childDump,
      classification,
      target,
      uniqueLinks,
      config,
      segments.length > 1 ? parentId : undefined,
    );

    index.upsertNote({
      path: target.notePath,
      compartment: target.compartment,
      title: classification.title,
      entities: classification.entities,
      tags: classification.tags,
      summary: classification.summary,
      updated_at: new Date().toISOString(),
    });

    index.recordDump(
      childDump.id,
      dump.source,
      dump.receivedAt,
      target.notePath,
      target.compartment,
      classification.confidence,
    );

    for (const link of uniqueLinks) {
      const slug = parseWikilink(link);
      const linkedPath = index.search(slug, undefined, 1)[0]?.path;
      if (linkedPath && linkedPath !== target.notePath) {
        addBacklink(config.vault.path, linkedPath, target.slug, classification.title);
      }
    }

    results.push({
      dumpId: childDump.id,
      notePath: writeResult.notePath,
      compartment: target.compartment,
      confidence: classification.confidence,
      tier,
      summary: classification.summary,
      transcript: i === 0 ? transcript : undefined,
      links: uniqueLinks,
      created: writeResult.created,
      parentDumpId: segments.length > 1 ? parentId : undefined,
      segmentIndex: segments.length > 1 ? i : undefined,
      siblingCount: segments.length > 1 ? segments.length : undefined,
    });
  }

  if (!dryRun) {
    writeVaultCatalog(config.vault.path, index);
  }

  return results;
}

export async function enqueueAndProcess(
  ctx: PipelineContext,
  dump: Dump,
): Promise<PipelineResult[]> {
  if (!ctx.config.queue.durable) {
    return processDump(ctx, dump);
  }
  ctx.index.enqueueDump(JSON.stringify(dump));
  return drainQueue(ctx, 1);
}

export async function drainQueue(
  ctx: PipelineContext,
  limit?: number,
): Promise<PipelineResult[]> {
  const max = limit ?? ctx.config.queue.max_concurrency;
  const items = ctx.index.claimPendingDumps(max, ctx.config.queue.max_retries);
  const results: PipelineResult[] = [];

  for (const item of items) {
    try {
      const dump = JSON.parse(item.dump_json) as Dump;
      const batch = await processDump(ctx, dump);
      ctx.index.completeQueueItem(item.id);
      results.push(...batch);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.index.failQueueItem(item.id, msg, ctx.config.queue.max_retries);
      throw err;
    }
  }
  return results;
}

function confidenceTier(
  confidence: number,
  config: DendriteConfig,
): "silent" | "confirm" | "inbox" {
  if (confidence < config.classification.confidence.confirm_below) return "inbox";
  if (confidence < config.classification.confidence.silent_above) return "confirm";
  return "silent";
}

export function formatPipelineReply(result: PipelineResult, config: DendriteConfig): string | null {
  if (result.duplicate) return null;
  if (config.replies.mode === "digest") return null;
  if (config.replies.mode === "always") {
    return `Filed under **${result.compartment}** → \`${result.notePath}\`\n${result.summary}`;
  }
  if (result.tier === "silent") return null;
  if (result.tier === "confirm") {
    return `Filed under **${result.compartment}** — move? Use /inbox to review.\n\`${result.notePath}\``;
  }
  return `Not sure where this goes — filed to Inbox.\n\`${result.notePath}\``;
}

export function aggregateTier(results: PipelineResult[]): "silent" | "confirm" | "inbox" {
  if (results.some((r) => r.tier === "inbox")) return "inbox";
  if (results.some((r) => r.tier === "confirm")) return "confirm";
  return "silent";
}
