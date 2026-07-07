import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import matter from "gray-matter";
import type { DendriteConfig } from "../config.js";
import type { DendriteIndex } from "./index.js";
import { formatTimestamp, nowIso } from "../util/datetime.js";
import { writeVaultCatalog } from "./catalog.js";

export interface UndoResult {
  dumpId: string;
  notePath: string;
  action: "section_removed" | "moved_to_inbox" | "file_deleted" | "skipped";
  detail?: string;
}

export interface UndoCaptureResult {
  parentId: string;
  results: UndoResult[];
}

function parentDumpId(id: string): string {
  const hash = id.indexOf("#");
  return hash >= 0 ? id.slice(0, hash) : id;
}

/** Undo all segments from one capture (parent dump id). */
export function undoCapture(
  vaultPath: string,
  index: DendriteIndex,
  parentId: string,
  config: DendriteConfig,
): UndoCaptureResult {
  const family = index.getDumpFamily(parentId);
  if (family.length === 0) {
    throw new Error(`No capture found for id: ${parentId}`);
  }

  const results: UndoResult[] = [];
  for (const row of family) {
    results.push(undoOneDump(vaultPath, index, row, config));
    index.deleteDump(row.id);
  }

  writeVaultCatalog(vaultPath, index);
  return { parentId, results };
}

function undoOneDump(
  vaultPath: string,
  index: DendriteIndex,
  row: {
    id: string;
    note_path: string;
    compartment: string;
    source: string;
    received_at: string;
  },
  config: DendriteConfig,
): UndoResult {
  const absPath = join(vaultPath, row.note_path);
  if (!existsSync(absPath)) {
    return { dumpId: row.id, notePath: row.note_path, action: "skipped", detail: "file missing" };
  }

  const sectionHeader = `## ${formatTimestamp(row.received_at, config.vault.timezone)} · via ${row.source}`;

  const raw = readFileSync(absPath, "utf8");
  const parsed = matter(raw);
  const content = parsed.content;

  const sections = splitSections(content);
  const matchIdx = sections.findIndex((s) => s.trimStart().startsWith(sectionHeader));

  if (matchIdx < 0) {
    return {
      dumpId: row.id,
      notePath: row.note_path,
      action: "skipped",
      detail: "section not found in note",
    };
  }

  const remaining = sections.filter((_, i) => i !== matchIdx);
  const hasOtherSections = remaining.some((s) => s.trimStart().startsWith("## "));

  if (!hasOtherSections) {
    const inboxPath = moveToInbox(vaultPath, row.note_path, parsed.data);
    index.db.prepare(`DELETE FROM notes WHERE path = ?`).run(row.note_path);
    index.upsertNote({
      path: inboxPath,
      compartment: "inbox",
      title: String(parsed.data.title ?? "Undone capture"),
      entities: [],
      tags: Array.isArray(parsed.data.tags) ? parsed.data.tags.map(String) : [],
      summary: String(parsed.data.summary ?? "Moved to inbox by undo"),
      updated_at: nowIso(),
    });
    return { dumpId: row.id, notePath: inboxPath, action: "moved_to_inbox" };
  }

  const newContent = remaining.join("\n\n").trimEnd() + "\n";
  const data = parsed.data as Record<string, unknown>;
  const updated: Record<string, unknown> = {
    ...data,
    updated: nowIso(),
    compartment: data.compartment ?? row.compartment,
  };
  writeFileSync(absPath, matter.stringify(newContent, updated), "utf8");

  index.upsertNote({
    path: row.note_path,
    compartment: String(updated.compartment ?? row.compartment),
    title: String(data.title ?? row.note_path),
    entities: Array.isArray(data.entities) ? data.entities.map(String) : [],
    tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
    summary: String(data.summary ?? ""),
    updated_at: nowIso(),
  });

  return { dumpId: row.id, notePath: row.note_path, action: "section_removed" };
}

function splitSections(content: string): string[] {
  const parts = content.split(/\n(?=## )/);
  if (parts.length === 1) return [content];
  return parts;
}

function moveToInbox(
  vaultPath: string,
  notePath: string,
  data: Record<string, unknown>,
): string {
  const abs = join(vaultPath, notePath);
  const base = notePath.replace(/\.md$/i, "").split("/").pop() ?? "undone";
  const inboxRel = `brain/inbox/undone-${base}.md`;
  const inboxAbs = join(vaultPath, inboxRel);
  mkdirSync(dirname(inboxAbs), { recursive: true });

  const fm = {
    ...data,
    compartment: "inbox",
    updated: nowIso(),
    undone: true,
  };
  const body = matter.read(abs).content;
  writeFileSync(inboxAbs, matter.stringify(body, fm), "utf8");
  unlinkSync(abs);
  return inboxRel;
}

export function resolveUndoTarget(
  index: DendriteIndex,
  opts: { last?: boolean; id?: string; note?: string },
): string {
  if (opts.id) return parentDumpId(opts.id);

  if (opts.note) {
    const row = index.db
      .prepare(`SELECT id FROM dumps WHERE note_path = ? ORDER BY created_at DESC LIMIT 1`)
      .get(opts.note) as { id: string } | undefined;
    if (!row) throw new Error(`No dump found for note: ${opts.note}`);
    return parentDumpId(row.id);
  }

  if (opts.last) {
    const parent = index.getLastCaptureParentId();
    if (!parent) throw new Error("No captures to undo");
    return parent;
  }

  throw new Error("Specify --last, --id <dumpId>, or --note <path>");
}
