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

/** Obsidian-Tasks style checkbox lines for extracted tasks. */
export function renderTaskCheckboxLines(tasks: string[], dates: string[]): string {
  if (tasks.length === 0) return "";
  const attachDate = tasks.length === 1 && dates.length === 1;
  return tasks
    .map((task) => {
      const dateSuffix = attachDate ? ` 📅 ${dates[0]}` : "";
      return `- [ ] ${task}${dateSuffix}`;
    })
    .join("\n");
}

function tasksInFrontmatter(render: DendriteConfig["tasks"]["render"]): boolean {
  return render === "frontmatter" || render === "both";
}

function tasksAsCheckboxes(render: DendriteConfig["tasks"]["render"]): boolean {
  return render === "checkbox" || render === "both";
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

  const taskRender = config.tasks.render;
  const created = !existsSync(absPath);
  let frontmatter: Record<string, unknown> = {};
  let body = "";

  if (created) {
    frontmatter = buildFrontmatter(dump, classification, target, links, splitGroup, taskRender);
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

    if (tasksAsCheckboxes(taskRender) && classification.extracted.tasks.length > 0) {
      const lines = renderTaskCheckboxLines(
        classification.extracted.tasks,
        classification.extracted.dates,
      );
      body = body.trimEnd() + "\n\n" + lines + "\n";
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
    if (tasksInFrontmatter(taskRender)) {
      frontmatter.tasks = mergeUnique(
        Array.isArray(frontmatter.tasks) ? frontmatter.tasks.map(String) : [],
        classification.extracted.tasks,
      );
    }
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
    body = existing.content.trimEnd() + "\n\n" + section;
    if (tasksAsCheckboxes(taskRender) && classification.extracted.tasks.length > 0) {
      const lines = renderTaskCheckboxLines(
        classification.extracted.tasks,
        classification.extracted.dates,
      );
      body += "\n" + lines + "\n";
    }
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
  taskRender: DendriteConfig["tasks"]["render"] = "frontmatter",
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
  if (tasksInFrontmatter(taskRender) && classification.extracted.tasks.length) {
    fm.tasks = classification.extracted.tasks;
  }
  if (classification.extracted.dates.length) fm.dates = classification.extracted.dates;
  if (classification.extracted.people.length) fm.people = classification.extracted.people;
  if (classification.extracted.resources.length) fm.resources = classification.extracted.resources;
  return fm;
}

function mergeUnique(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}
