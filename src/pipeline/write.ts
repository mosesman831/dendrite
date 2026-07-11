import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import matter from "gray-matter";
import type { Classification, Dump, ResolvedTarget } from "../types.js";
import type { DendriteConfig } from "../config.js";
import { formatTimestamp, nowIso } from "../util/datetime.js";
import {
  loadCompartmentTemplate,
  renderFrontmatter,
  renderTemplateBody,
  type TemplateVars,
} from "./template.js";

export interface WriteResult {
  notePath: string;
  created: boolean;
  body: string;
}

export function writeNote(
  vaultPath: string,
  dump: Dump,
  classification: Classification,
  target: ResolvedTarget,
  links: string[],
  config: DendriteConfig,
  splitGroup?: string,
  configDir?: string,
): WriteResult {
  const absPath = join(vaultPath, target.notePath);
  mkdirSync(dirname(absPath), { recursive: true });

  const timestamp = formatTimestamp(dump.receivedAt, config.vault.timezone);
  const linkText =
    links.length > 0 ? ` Related: ${links.join(", ")}.` : "";
  const section = `## ${timestamp} · via ${dump.source}\n${dump.text}${linkText}\n`;

  const created = !existsSync(absPath);
  let frontmatter: Record<string, unknown> = {};
  let body = "";

  if (created) {
    frontmatter = buildFrontmatter(dump, classification, target, links, splitGroup);
    body = `# ${classification.title}\n\n${section}`;

    // Per-compartment template (optional). Dynamic core frontmatter always wins;
    // templates may add extra static fields and control body layout.
    const template = configDir
      ? loadCompartmentTemplate(config, configDir, target.compartment)
      : null;
    if (template) {
      const vars: TemplateVars = {
        title: classification.title,
        summary: classification.summary,
        source: dump.source,
        date: timestamp,
        compartment: target.compartment,
        entities: classification.entities.join(", "),
        tags: classification.tags.join(", "),
        links: links.join(", "),
        capture: section,
      };
      frontmatter = { ...renderFrontmatter(template.frontmatter, vars), ...frontmatter };
      body = renderTemplateBody(template, vars);
    }
  } else {
    const existing = matter(readFileSync(absPath, "utf8"));
    frontmatter = { ...existing.data };
    frontmatter.updated = nowIso();
    if (splitGroup) frontmatter.split_group = splitGroup;
    frontmatter.confidence = classification.confidence;
    frontmatter.entities = mergeUnique(
      Array.isArray(frontmatter.entities) ? frontmatter.entities.map(String) : [],
      classification.entities,
    );
    frontmatter.tags = mergeUnique(
      Array.isArray(frontmatter.tags) ? frontmatter.tags.map(String) : [],
      classification.tags,
    );
    frontmatter.links = mergeUnique(
      Array.isArray(frontmatter.links) ? frontmatter.links.map(String) : [],
      links,
    );
    if (config.tasks.render === "frontmatter") {
      frontmatter.tasks = mergeUnique(
        Array.isArray(frontmatter.tasks) ? frontmatter.tasks.map(String) : [],
        classification.extracted.tasks,
      );
      frontmatter.dates = mergeUnique(
        Array.isArray(frontmatter.dates) ? frontmatter.dates.map(String) : [],
        classification.extracted.dates,
      );
      frontmatter.people = mergeUnique(
        Array.isArray(frontmatter.people) ? frontmatter.people.map(String) : [],
        classification.extracted.people,
      );
      frontmatter.resources = mergeUnique(
        Array.isArray(frontmatter.resources) ? frontmatter.resources.map(String) : [],
        classification.extracted.resources,
      );
    }
    body = existing.content.trimEnd() + "\n\n" + section;
  }

  const file = matter.stringify(body, frontmatter);
  writeFileSync(absPath, file, "utf8");

  return { notePath: target.notePath, created, body: section };
}

export function addBacklink(
  vaultPath: string,
  targetNotePath: string,
  fromSlug: string,
  fromTitle: string,
): void {
  const absPath = join(vaultPath, targetNotePath);
  if (!existsSync(absPath)) return;
  const existing = matter(readFileSync(absPath, "utf8"));
  const backlinkLine = `- Linked from [[${fromSlug}]] (${fromTitle})`;
  if (existing.content.includes(backlinkLine)) return;
  const section = `\n\n### Backlinks\n${backlinkLine}\n`;
  const file = matter.stringify(existing.content.trimEnd() + section, existing.data);
  writeFileSync(absPath, file, "utf8");
}

function buildFrontmatter(
  dump: Dump,
  classification: Classification,
  target: ResolvedTarget,
  links: string[],
  splitGroup?: string,
): Record<string, unknown> {
  const now = nowIso();
  const fm: Record<string, unknown> = {
    compartment: target.compartment,
    title: classification.title,
    created: now,
    updated: now,
    source: dump.source,
    confidence: classification.confidence,
    entities: classification.entities,
    tags: classification.tags,
    links,
    dendrite_version: 1,
    summary: classification.summary,
  };
  if (splitGroup) fm.split_group = splitGroup;
  if (classification.extracted.tasks.length) fm.tasks = classification.extracted.tasks;
  if (classification.extracted.dates.length) fm.dates = classification.extracted.dates;
  if (classification.extracted.people.length) fm.people = classification.extracted.people;
  if (classification.extracted.resources.length) fm.resources = classification.extracted.resources;
  return fm;
}

function mergeUnique(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}
