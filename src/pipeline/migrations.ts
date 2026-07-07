import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import { FRONTMATTER_CONTRACT } from "../types.js";
import { nowIso } from "../util/datetime.js";
import { inferCompartmentFromPath } from "../util/vault-path.js";

export const CURRENT_DENDRITE_VERSION = FRONTMATTER_CONTRACT.version;

export interface MigrationChange {
  path: string;
  fromVersion: number;
  toVersion: number;
  changes: string[];
}

type NoteData = Record<string, unknown>;

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string" && v) return [v];
  return [];
}

/** v0 → v1: normalize frontmatter contract fields. */
function migrateV0toV1(
  rel: string,
  data: NoteData,
  content: string,
  mtime: string,
): { data: NoteData; changes: string[] } {
  const changes: string[] = [];
  const out: NoteData = { ...data };

  if (out.dendrite_version === undefined) {
    out.dendrite_version = 1;
    changes.push("set dendrite_version=1");
  }

  if (!out.compartment) {
    out.compartment = inferCompartmentFromPath(rel);
    changes.push(`infer compartment=${out.compartment}`);
  }

  if (!out.title) {
    const heading = content.match(/^#\s+(.+)$/m);
    const slug = rel.replace(/\.md$/i, "").split("/").pop() ?? "untitled";
    out.title = heading?.[1]?.trim() ?? slug.replace(/-/g, " ");
    changes.push("set title from heading or slug");
  }

  if (!out.created) {
    out.created = mtime;
    changes.push("set created from file mtime");
  }

  if (!out.updated) {
    out.updated = out.created ?? mtime;
    changes.push("set updated");
  }

  for (const key of ["entities", "tags", "links", "tasks", "dates", "people", "resources"] as const) {
    const normalized = asStringArray(out[key]);
    const before = JSON.stringify(out[key] ?? null);
    out[key] = normalized;
    if (before !== JSON.stringify(normalized)) changes.push(`normalize ${key}[]`);
  }

  if (out.confidence === undefined) {
    out.confidence = 0.5;
    changes.push("default confidence=0.5");
  }

  if (!out.summary && content.trim()) {
    const plain = content.replace(/^#.+$/m, "").replace(/^##.+$/gm, "").trim();
    out.summary = plain.slice(0, 300).replace(/\s+/g, " ");
    if (out.summary) changes.push("generate summary from body");
  }

  return { data: out, changes };
}

const MIGRATIONS: Array<{
  from: number;
  to: number;
  apply: (
    rel: string,
    data: NoteData,
    content: string,
    mtime: string,
  ) => { data: NoteData; changes: string[] };
}> = [{ from: 0, to: 1, apply: migrateV0toV1 }];

export function migrateNoteFile(
  vaultPath: string,
  rel: string,
  dryRun: boolean,
): MigrationChange | null {
  const abs = join(vaultPath, rel);
  const raw = readFileSync(abs, "utf8");
  const { data, content } = matter(raw);
  const mtime = statSync(abs).mtime.toISOString();

  let version = typeof data.dendrite_version === "number" ? data.dendrite_version : 0;
  if (version >= CURRENT_DENDRITE_VERSION) return null;

  let current = { ...data } as NoteData;
  let body = content;
  const allChanges: string[] = [];
  const fromVersion = version;

  while (version < CURRENT_DENDRITE_VERSION) {
    const step = MIGRATIONS.find((m) => m.from === version);
    if (!step) break;
    const result = step.apply(rel, current, body, mtime);
    current = result.data;
    allChanges.push(...result.changes);
    version = step.to;
    current.dendrite_version = version;
  }

  if (allChanges.length === 0) return null;

  if (!dryRun) {
    current.updated = nowIso();
    writeFileSync(abs, matter.stringify(body, current), "utf8");
  }

  return {
    path: rel,
    fromVersion,
    toVersion: version,
    changes: allChanges,
  };
}
