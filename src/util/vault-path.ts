import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { isSystemNotePath } from "../pipeline/index.js";
import type { DendriteConfig } from "../config.js";

export function inferCompartmentFromPath(relPath: string): string {
  const parts = relPath.split("/");
  if (parts[0] === "brain" && parts[1]) return parts[1];
  return "unknown";
}

/** True when note lives directly under brain/ (flat layout), not in a subfolder. */
export function isFlatBrainNotePath(relPath: string): boolean {
  const parts = relPath.split("/");
  return parts[0] === "brain" && parts.length === 2 && parts[1].endsWith(".md");
}

/** True when note is in a compartment subfolder (brain/<compartment>/…). */
export function isFolderBrainNotePath(relPath: string): boolean {
  const parts = relPath.split("/");
  return parts[0] === "brain" && parts.length >= 3 && parts[parts.length - 1].endsWith(".md");
}

/**
 * Resolve vault-relative path for a new or existing note slug.
 * append_only compartments (e.g. journal) always use their folder even in flat mode.
 */
export function resolveBrainNotePath(
  organization: DendriteConfig["organization"],
  compartmentPath: string,
  slug: string,
  appendOnly?: boolean,
): string {
  const fname = slug.endsWith(".md") ? slug : `${slug}.md`;
  // Daily journal notes stay compartment-scoped so append_only routing keeps working.
  if (appendOnly) {
    return join(compartmentPath, fname).replace(/\\/g, "/");
  }
  if (organization === "flat") {
    return join("brain", fname).replace(/\\/g, "/");
  }
  return join(compartmentPath, fname).replace(/\\/g, "/");
}

/** Walk vault for markdown notes, optionally filtered. */
export function walkVaultNotes(
  vaultPath: string,
  filter?: (rel: string) => boolean,
): string[] {
  const out: string[] = [];

  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.endsWith(".md")) {
        const rel = relative(vaultPath, full).replace(/\\/g, "/");
        if (isSystemNotePath(rel)) continue;
        if (!filter || filter(rel)) out.push(rel);
      }
    }
  };

  walk(vaultPath);
  return out.sort();
}
