import { relative } from "node:path";
import { parseCaptureSections } from "../util/note-sections.js";

export type MergeInto = "A" | "B";

export interface MergeNoteInput {
  path: string;
  frontmatter: Record<string, unknown>;
  content: string;
}

export interface BacklinkRewrite {
  notePath: string;
  occurrences: number;
}

export interface MergePlan {
  survivorPath: string;
  absorbedPath: string;
  survivorSlug: string;
  absorbedSlug: string;
  mergedBody: string;
  mergedFrontmatter: Record<string, unknown>;
  survivorSectionCount: number;
  absorbedSectionCount: number;
  mergedSectionCount: number;
  backlinkRewrites: BacklinkRewrite[];
  archivePath: string;
}

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

const ARRAY_FM_KEYS = [
  "entities",
  "tags",
  "links",
  "tasks",
  "dates",
  "people",
  "resources",
] as const;

/** Basename slug used in wikilinks (no .md). */
export function noteSlugFromPath(relPath: string): string {
  const base = relPath.replace(/\\/g, "/").split("/").pop() ?? relPath;
  return base.replace(/\.md$/i, "");
}

/** Resolve vault-relative or absolute-under-vault path to a normalized relative path. */
export function resolveVaultRelativePath(vaultPath: string, input: string): string {
  const normalizedVault = vaultPath.replace(/\\/g, "/").replace(/\/$/, "");
  let p = input.replace(/\\/g, "/");
  if (p.startsWith(normalizedVault + "/")) {
    p = relative(normalizedVault, p);
  }
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function mergeUniqueArrays(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function earliestIso(a: unknown, b: unknown): string | undefined {
  const vals = [a, b].filter((v) => typeof v === "string" && v.length > 0) as string[];
  if (vals.length === 0) return undefined;
  return vals.sort((x, y) => new Date(x).getTime() - new Date(y).getTime())[0];
}

function latestIso(a: unknown, b: unknown): string | undefined {
  const vals = [a, b].filter((v) => typeof v === "string" && v.length > 0) as string[];
  if (vals.length === 0) return undefined;
  return vals.sort((x, y) => new Date(y).getTime() - new Date(x).getTime())[0];
}

function extractTitleLine(content: string): string | null {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? `# ${match[1]!.trim()}` : null;
}

function stripTitleLine(content: string): string {
  return content.replace(/^#\s+.+\n?/, "").trim();
}

/** Union frontmatter arrays; keep survivor title/compartment; earliest created, latest updated. */
export function mergeFrontmatter(
  survivor: Record<string, unknown>,
  absorbed: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...survivor };

  for (const key of ARRAY_FM_KEYS) {
    merged[key] = mergeUniqueArrays(asStringArray(survivor[key]), asStringArray(absorbed[key]));
  }

  const created = earliestIso(survivor.created, absorbed.created);
  const updated = latestIso(survivor.updated, absorbed.updated);
  if (created) merged.created = created;
  if (updated) merged.updated = updated;

  merged.title = survivor.title ?? absorbed.title;
  merged.compartment = survivor.compartment ?? absorbed.compartment;

  return merged;
}

/** Concatenate capture sections; dedupe identical `## timestamp · via source` headers. */
export function mergeNoteBodies(
  survivorContent: string,
  absorbedContent: string,
): {
  body: string;
  survivorSectionCount: number;
  absorbedSectionCount: number;
  mergedSectionCount: number;
} {
  const survivorSections = parseCaptureSections(survivorContent);
  const absorbedSections = parseCaptureSections(absorbedContent);
  const title = extractTitleLine(survivorContent) ?? extractTitleLine(absorbedContent);

  if (survivorSections.length > 0 || absorbedSections.length > 0) {
    const seen = new Set<string>();
    const mergedRaws: string[] = [];

    for (const section of survivorSections) {
      seen.add(section.header);
      mergedRaws.push(section.raw.trim());
    }
    for (const section of absorbedSections) {
      if (seen.has(section.header)) continue;
      seen.add(section.header);
      mergedRaws.push(section.raw.trim());
    }

    const bodyParts = title ? [title, ...mergedRaws] : mergedRaws;
    return {
      body: bodyParts.join("\n\n").trimEnd() + "\n",
      survivorSectionCount: survivorSections.length,
      absorbedSectionCount: absorbedSections.length,
      mergedSectionCount: mergedRaws.length,
    };
  }

  const survivorRest = stripTitleLine(survivorContent);
  const absorbedRest = stripTitleLine(absorbedContent);
  const blocks = [survivorRest, absorbedRest].filter(Boolean);
  const bodyParts = title ? [title, ...blocks] : blocks;

  return {
    body: (bodyParts.join("\n\n").trimEnd() + "\n") || "\n",
    survivorSectionCount: survivorRest ? 1 : 0,
    absorbedSectionCount: absorbedRest ? 1 : 0,
    mergedSectionCount: blocks.length,
  };
}

/** Replace absorbed-slug wikilinks with survivor-slug; returns rewrite count. */
export function rewriteWikilinks(
  text: string,
  absorbedSlug: string,
  survivorSlug: string,
): { text: string; count: number } {
  const absorbedLower = absorbedSlug.toLowerCase();
  let count = 0;
  const next = text.replace(WIKILINK_RE, (match, inner: string) => {
    const pipe = inner.indexOf("|");
    const hash = inner.indexOf("#");
    const cut = pipe >= 0 ? pipe : hash >= 0 ? hash : inner.length;
    const target = inner.slice(0, cut).trim();
    if (target.toLowerCase() !== absorbedLower) return match;
    count++;
    const suffix = inner.slice(cut);
    return `[[${survivorSlug}${suffix}]]`;
  });
  return { text: next, count };
}

export function findBacklinkRewrites(
  vaultNotePaths: string[],
  absorbedPath: string,
  absorbedSlug: string,
  survivorSlug: string,
  readContent: (relPath: string) => string,
): BacklinkRewrite[] {
  const out: BacklinkRewrite[] = [];
  for (const notePath of vaultNotePaths) {
    if (notePath === absorbedPath) continue;
    const raw = readContent(notePath);
    const { count } = rewriteWikilinks(raw, absorbedSlug, survivorSlug);
    if (count > 0) out.push({ notePath, occurrences: count });
  }
  return out;
}

export function archiveMergedFilename(absorbedSlug: string, now = new Date()): string {
  const ts = now.toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `merged-${absorbedSlug}-${ts}.md`;
}

export function planMerge(
  pathA: string,
  pathB: string,
  into: MergeInto,
  noteA: MergeNoteInput,
  noteB: MergeNoteInput,
  vaultNotePaths: string[],
  readContent: (relPath: string) => string,
  now = new Date(),
): MergePlan {
  const survivor = into === "A" ? noteA : noteB;
  const absorbed = into === "A" ? noteB : noteA;
  const survivorSlug = noteSlugFromPath(survivor.path);
  const absorbedSlug = noteSlugFromPath(absorbed.path);

  const { body, survivorSectionCount, absorbedSectionCount, mergedSectionCount } = mergeNoteBodies(
    survivor.content,
    absorbed.content,
  );

  const mergedFrontmatter = mergeFrontmatter(survivor.frontmatter, absorbed.frontmatter);
  const archivePath = `brain/_dendrite/repaired/${archiveMergedFilename(absorbedSlug, now)}`;

  return {
    survivorPath: survivor.path,
    absorbedPath: absorbed.path,
    survivorSlug,
    absorbedSlug,
    mergedBody: body,
    mergedFrontmatter,
    survivorSectionCount,
    absorbedSectionCount,
    mergedSectionCount,
    backlinkRewrites: findBacklinkRewrites(
      vaultNotePaths,
      absorbed.path,
      absorbedSlug,
      survivorSlug,
      readContent,
    ),
    archivePath,
  };
}
