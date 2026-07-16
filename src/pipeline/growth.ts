import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import matter from "gray-matter";
import type { DendriteConfig } from "../config.js";
import {
  SUMMARY_AUTO_HEADING,
  countCaptureSections,
  estimateTokens,
  hasSummaryAutoBlock,
  parseCaptureSections,
  type ParsedCaptureSection,
} from "../util/note-sections.js";
import { nowIso } from "../util/datetime.js";
import { wikilink } from "../util/slug.js";

export const DEFAULT_KEEP_RECENT = 5;
const BULLET_TRUNCATE = 120;

export interface GrowthOptions {
  keepRecent?: number;
  /** When true, skip writing files (for dry-run parity). */
  dryRun?: boolean;
}

export interface GrowthResult {
  applied: boolean;
  policy?: "summarize" | "split";
  detail?: string;
  contNotePath?: string;
}

/** Check whether a note body exceeds configured growth caps. */
export function noteExceedsGrowthCap(
  content: string,
  config: DendriteConfig,
): { exceeds: boolean; sections: number; tokens: number } {
  const sections = countCaptureSections(content);
  const tokens = estimateTokens(content);
  const exceeds =
    sections > config.growth.max_sections || tokens > config.growth.max_tokens;
  return { exceeds, sections, tokens };
}

function archiveNote(vaultPath: string, relPath: string, slug: string): string {
  const src = join(vaultPath, relPath);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const archiveName = `${slug}-${ts}.md`;
  const dest = join(vaultPath, "brain/_dendrite/repaired", archiveName);
  mkdirSync(dirname(dest), { recursive: true });
  const backup = readFileSync(src, "utf8");
  writeFileSync(dest, backup, "utf8");
  return archiveName;
}

function firstLineSummary(body: string): string {
  const line = body.split(/\r?\n/).find((l) => l.trim())?.trim() ?? "";
  if (line.length <= BULLET_TRUNCATE) return line;
  return line.slice(0, BULLET_TRUNCATE - 1) + "…";
}

function buildSummaryBlock(sections: ParsedCaptureSection[]): string {
  const bullets = sections.map((s) => `- ${firstLineSummary(s.body)}`);
  return [SUMMARY_AUTO_HEADING, ...bullets, ""].join("\n");
}

function stripSummaryBlock(content: string): string {
  const idx = content.indexOf(SUMMARY_AUTO_HEADING);
  if (idx < 0) return content;
  const after = content.slice(idx);
  const nextH2 = after.search(/\n## /);
  const end = nextH2 >= 0 ? idx + nextH2 : content.length;
  return (content.slice(0, idx) + content.slice(end)).trimEnd();
}

function splitTitleAndBody(content: string): { titleLine: string; rest: string } {
  const lines = content.split(/\r?\n/);
  const titleIdx = lines.findIndex((l) => l.startsWith("# "));
  if (titleIdx < 0) return { titleLine: "", rest: content.trim() };
  const titleLine = lines[titleIdx]!;
  const rest = lines.slice(titleIdx + 1).join("\n").trimStart();
  return { titleLine, rest };
}

function mergeUniqueLinks(existing: unknown, added: string[]): string[] {
  const base = Array.isArray(existing) ? existing.map(String) : [];
  return [...new Set([...base, ...added])];
}

function contNotePath(
  notePath: string,
  slug: string,
  config: DendriteConfig,
): string {
  const contSlug = `${slug}-cont`;
  if (config.organization === "flat") {
    return join("brain", `${contSlug}.md`).replace(/\\/g, "/");
  }
  const dir = dirname(notePath);
  return join(dir, `${contSlug}.md`).replace(/\\/g, "/");
}

function applySummarize(
  vaultPath: string,
  relPath: string,
  raw: string,
  config: DendriteConfig,
  opts: GrowthOptions,
): GrowthResult {
  const { data, content } = matter(raw);
  const { exceeds } = noteExceedsGrowthCap(content, config);
  if (!exceeds) return { applied: false };

  const keepRecent = opts.keepRecent ?? DEFAULT_KEEP_RECENT;
  const captures = parseCaptureSections(content);
  if (captures.length <= keepRecent) {
    return { applied: false, detail: "not enough sections to summarize" };
  }

  const toCollapse = captures.slice(0, captures.length - keepRecent);
  const toKeep = captures.slice(captures.length - keepRecent);
  const slug = basename(relPath, ".md");

  if (!opts.dryRun) archiveNote(vaultPath, relPath, slug);

  const { titleLine } = splitTitleAndBody(stripSummaryBlock(content));
  const summaryBlock = buildSummaryBlock(toCollapse);
  const keptRaw = toKeep.map((s) => s.raw.trim()).join("\n\n");
  const bodyParts = [titleLine, "", summaryBlock, keptRaw].filter((p) => p !== "");
  const newBody = bodyParts.join("\n\n").trimEnd() + "\n";

  const frontmatter = { ...data, updated: nowIso() };

  if (!opts.dryRun) {
    writeFileSync(join(vaultPath, relPath), matter.stringify(newBody, frontmatter), "utf8");
  }

  return {
    applied: true,
    policy: "summarize",
    detail: `collapsed ${toCollapse.length} section(s), kept ${toKeep.length}`,
  };
}

function applySplit(
  vaultPath: string,
  relPath: string,
  raw: string,
  config: DendriteConfig,
  opts: GrowthOptions,
): GrowthResult {
  const { data, content } = matter(raw);
  const { exceeds, sections, tokens } = noteExceedsGrowthCap(content, config);
  if (!exceeds) return { applied: false };

  const captures = parseCaptureSections(content);
  if (captures.length <= 1) {
    return { applied: false, detail: "not enough sections to split" };
  }

  let overflow = Math.max(0, captures.length - config.growth.max_sections);
  while (overflow < captures.length - 1) {
    const remain = captures.slice(overflow);
    const remainBody = remain.map((s) => s.raw).join("\n\n");
    const underSections = remain.length <= config.growth.max_sections;
    const underTokens = estimateTokens(remainBody) <= config.growth.max_tokens;
    if (underSections && underTokens) break;
    overflow++;
  }
  if (overflow <= 0) return { applied: false, detail: "no overflow sections" };

  const toMove = captures.slice(0, overflow);
  const toKeep = captures.slice(overflow);
  const slug = basename(relPath, ".md");
  const contPath = contNotePath(relPath, slug, config);
  const contSlug = `${slug}-cont`;
  const parentLink = wikilink(slug);
  const contLink = wikilink(contSlug);

  if (!opts.dryRun) archiveNote(vaultPath, relPath, slug);

  const { titleLine } = splitTitleAndBody(stripSummaryBlock(content));
  const keptRaw = toKeep.map((s) => s.raw.trim()).join("\n\n");
  const relatedLine = ` Related: ${contLink}.`;
  const lastKept = toKeep[toKeep.length - 1];
  let parentBody: string;
  if (lastKept) {
    const patchedLast = lastKept.raw.trimEnd() + relatedLine + "\n";
    const otherKept = toKeep.slice(0, -1).map((s) => s.raw.trim());
    parentBody = [titleLine, "", ...otherKept, patchedLast].filter(Boolean).join("\n\n").trimEnd() + "\n";
  } else {
    parentBody = [titleLine, "", keptRaw + relatedLine].filter(Boolean).join("\n\n").trimEnd() + "\n";
  }

  const splitGroup =
    typeof data.split_group === "string" ? data.split_group : `growth-${slug}`;
  const parentFm = {
    ...data,
    updated: nowIso(),
    split_group: splitGroup,
    links: mergeUniqueLinks(data.links, [contLink]),
  };

  const movedRaw = toMove.map((s) => s.raw.trim()).join("\n\n");
  const contTitle = titleLine.replace(/^# /, "# ") + " (continued)";
  const contBody = [
    contTitle || `# ${data.title ?? contSlug} (continued)`,
    "",
    movedRaw.trimEnd() + ` Related: ${parentLink}.`,
    "",
  ].join("\n");

  const contFm: Record<string, unknown> = {
    compartment: data.compartment,
    title: `${String(data.title ?? contSlug)} (continued)`,
    created: nowIso(),
    updated: nowIso(),
    source: data.source ?? "growth-split",
    split_group: splitGroup,
    links: [parentLink],
    dendrite_version: data.dendrite_version ?? 1,
  };

  if (!opts.dryRun) {
    writeFileSync(join(vaultPath, relPath), matter.stringify(parentBody, parentFm), "utf8");
    const contAbs = join(vaultPath, contPath);
    mkdirSync(dirname(contAbs), { recursive: true });
    if (existsSync(contAbs)) {
      const existing = matter(readFileSync(contAbs, "utf8"));
      const mergedBody = existing.content.trimEnd() + "\n\n" + movedRaw + "\n";
      const mergedFm = {
        ...existing.data,
        updated: nowIso(),
        split_group: splitGroup,
        links: mergeUniqueLinks(existing.data.links, [parentLink]),
      };
      writeFileSync(contAbs, matter.stringify(mergedBody, mergedFm), "utf8");
    } else {
      writeFileSync(contAbs, matter.stringify(contBody, contFm), "utf8");
    }
  }

  return {
    applied: true,
    policy: "split",
    detail: `moved ${toMove.length} section(s) to ${contPath}`,
    contNotePath: contPath,
  };
}

/**
 * Apply growth cap policy to a note after write/append.
 * Never throws — logs warnings and returns on failure.
 */
export function applyGrowthCap(
  vaultPath: string,
  notePath: string,
  config: DendriteConfig,
  opts: GrowthOptions = {},
): GrowthResult {
  if (config.growth.policy === "off") return { applied: false };

  const absPath = join(vaultPath, notePath);
  if (!existsSync(absPath)) return { applied: false, detail: "note missing" };

  try {
    const raw = readFileSync(absPath, "utf8");
    const { content } = matter(raw);
    const cap = noteExceedsGrowthCap(content, config);

    if (!cap.exceeds) return { applied: false };

    if (config.growth.policy === "summarize") {
      if (hasSummaryAutoBlock(content)) {
        const underCaps =
          cap.sections <= config.growth.max_sections &&
          cap.tokens <= config.growth.max_tokens;
        if (underCaps) return { applied: false, detail: "summary present and under caps" };
      }
      return applySummarize(vaultPath, notePath, raw, config, opts);
    }

    if (config.growth.policy === "split") {
      return applySplit(vaultPath, notePath, raw, config, opts);
    }

    return { applied: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`growth cap skipped for ${notePath}: ${msg}`);
    return { applied: false, detail: msg };
  }
}
