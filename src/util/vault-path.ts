import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { isSystemNotePath } from "../pipeline/index.js";

export function inferCompartmentFromPath(relPath: string): string {
  const parts = relPath.split("/");
  if (parts[0] === "brain" && parts[1]) return parts[1];
  return "unknown";
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
