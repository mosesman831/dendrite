import { readFileSync, existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import matter from "gray-matter";
import type { DendriteConfig } from "../config.js";

/** Variables exposed to compartment templates. */
export interface TemplateVars {
  title: string;
  summary: string;
  source: string;
  date: string;
  compartment: string;
  entities: string;
  tags: string;
  links: string;
  /** The rendered timestamped capture section for this first write. */
  capture: string;
}

export interface LoadedTemplate {
  /** Extra static frontmatter fields declared in the template (may contain vars). */
  frontmatter: Record<string, unknown>;
  /** Template body with `{{var}}` placeholders. */
  body: string;
  /** Whether the body references `{{capture}}`. */
  hasCapture: boolean;
}

const CAPTURE_RE = /\{\{\s*capture\s*\}\}/;
const VAR_RE = /\{\{\s*([\w.]+)\s*\}\}/g;

export function resolveTemplateDir(config: DendriteConfig, configDir: string): string {
  const dir = config.templates.dir;
  return isAbsolute(dir) ? dir : resolve(configDir, dir);
}

/**
 * Load a compartment template if templates are enabled and a
 * `<dir>/<compartment>.md` file exists. Returns null otherwise so callers fall
 * back to the built-in default note layout.
 */
export function loadCompartmentTemplate(
  config: DendriteConfig,
  configDir: string,
  compartment: string,
): LoadedTemplate | null {
  if (!config.templates.enabled) return null;
  const file = join(resolveTemplateDir(config, configDir), `${compartment}.md`);
  if (!existsSync(file)) return null;
  try {
    const parsed = matter(readFileSync(file, "utf8"));
    return {
      frontmatter: (parsed.data ?? {}) as Record<string, unknown>,
      body: parsed.content,
      hasCapture: CAPTURE_RE.test(parsed.content),
    };
  } catch {
    return null;
  }
}

/** Replace `{{var}}` placeholders in a string. Unknown vars render as empty. */
export function renderVars(input: string, vars: TemplateVars): string {
  return input.replace(VAR_RE, (_m, key: string) => {
    const value = (vars as unknown as Record<string, unknown>)[key];
    return value === undefined || value === null ? "" : String(value);
  });
}

/** Deep-render string values inside template frontmatter. */
export function renderFrontmatter(
  fm: Record<string, unknown>,
  vars: TemplateVars,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fm)) {
    if (typeof value === "string") out[key] = renderVars(value, vars);
    else if (Array.isArray(value)) {
      out[key] = value.map((v) => (typeof v === "string" ? renderVars(v, vars) : v));
    } else out[key] = value;
  }
  return out;
}

/**
 * Render a template into a note body. If the template references `{{capture}}`
 * the capture section is inlined there; otherwise it is appended after the body.
 */
export function renderTemplateBody(tpl: LoadedTemplate, vars: TemplateVars): string {
  const rendered = renderVars(tpl.body, vars);
  if (tpl.hasCapture) return rendered;
  return `${rendered.trimEnd()}\n\n${vars.capture}`;
}
