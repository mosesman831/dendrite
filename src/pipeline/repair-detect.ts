import matter from "gray-matter";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isSystemNotePath } from "./index.js";
import { parseCaptureSections } from "../util/note-sections.js";
import { walkVaultNotes } from "../util/vault-path.js";

export interface JunkDrawerCandidate {
  path: string;
  title: string;
  sectionCount: number;
  titleRelevance: number;
  reason: string;
}

export interface RepairOptions {
  minSections?: number;
  maxTitleRelevance?: number;
  notePath?: string;
}

function titleRelevanceScore(title: string, sectionBodies: string[]): number {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3);
  if (words.length === 0) return 1;

  let hits = 0;
  for (const body of sectionBodies) {
    const lower = body.toLowerCase();
    if (words.some((w) => lower.includes(w))) hits++;
  }
  return hits / sectionBodies.length;
}

export function findJunkDrawers(
  vaultPath: string,
  opts: RepairOptions = {},
): JunkDrawerCandidate[] {
  const minSections = opts.minSections ?? 3;
  const maxTitleRelevance = opts.maxTitleRelevance ?? 0.34;
  const candidates: JunkDrawerCandidate[] = [];

  const paths = opts.notePath
    ? [opts.notePath]
    : walkVaultNotes(vaultPath, (rel) => {
        if (!rel.startsWith("brain/")) return false;
        if (rel.includes("/journal/")) return false;
        if (rel.includes("/inbox/")) return false;
        return true;
      });

  for (const rel of paths) {
    if (isSystemNotePath(rel)) continue;
    const abs = join(vaultPath, rel);
    const raw = readFileSync(abs, "utf8");
    const { data, content } = matter(raw);

    const sections = parseCaptureSections(content);
    if (sections.length < minSections) continue;

    const title = String(data.title ?? rel.split("/").pop()?.replace(/\.md$/, "") ?? "");
    const bodies = sections.map((s) => s.body);
    const relevance = titleRelevanceScore(title, bodies);

    if (relevance > maxTitleRelevance) continue;

    candidates.push({
      path: rel,
      title,
      sectionCount: sections.length,
      titleRelevance: Math.round(relevance * 100) / 100,
      reason: `${sections.length} capture sections, title matches ${Math.round(relevance * 100)}%`,
    });
  }

  return candidates.sort((a, b) => b.sectionCount - a.sectionCount);
}

export function formatRepairPreview(candidates: JunkDrawerCandidate[]): string {
  if (candidates.length === 0) return "No junk-drawer notes detected.";
  const lines = [`Found ${candidates.length} note(s) to repair:`];
  for (const c of candidates) {
    lines.push(`• \`${c.path}\` — ${c.reason}`);
  }
  return lines.join("\n");
}
