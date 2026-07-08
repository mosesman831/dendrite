import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, renameSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import matter from "gray-matter";
import type { DendriteConfig } from "../config.js";
import type { CompartmentsFile } from "../types.js";
import type { DendriteIndex } from "./index.js";
import { nowIso } from "../util/datetime.js";

export interface TriageResult {
  oldPath: string;
  newPath: string;
  compartment: string;
  action: "moved" | "noop" | "deleted";
  trashPath?: string;
}

function validatePath(path: string): void {
  if (!path.startsWith("brain/") || path.includes("..")) {
    throw new Error("Invalid note path");
  }
}

function resolveUniquePath(vaultPath: string, targetDir: string, filename: string): string {
  let rel = `${targetDir}/${filename}`;
  let abs = join(vaultPath, rel);
  let counter = 1;
  const base = filename.replace(/\.md$/i, "");
  while (existsSync(abs)) {
    rel = `${targetDir}/${base}-${counter}.md`;
    abs = join(vaultPath, rel);
    counter++;
  }
  return rel;
}

export function moveNoteToCompartment(
  vaultPath: string,
  index: DendriteIndex,
  notePath: string,
  targetCompartment: string,
  compartments: CompartmentsFile,
  _config: DendriteConfig,
): TriageResult {
  validatePath(notePath);

  const absPath = join(vaultPath, notePath);
  if (!existsSync(absPath)) {
    throw new Error(`Note not found: ${notePath}`);
  }

  const compDef = compartments.compartments[targetCompartment];
  if (!compDef) {
    throw new Error(`Unknown compartment: ${targetCompartment}`);
  }

  const raw = readFileSync(absPath, "utf8");
  const parsed = matter(raw);
  const data = parsed.data as Record<string, unknown>;
  const currentCompartment = String(data.compartment ?? "inbox");

  if (currentCompartment === targetCompartment && !notePath.includes("/inbox/")) {
    return { oldPath: notePath, newPath: notePath, compartment: targetCompartment, action: "noop" };
  }

  let targetDir = compDef.path;
  if (compDef.subdivide_by === "entity") {
    const entities = Array.isArray(data.entities) ? data.entities.map(String) : [];
    if (entities.length > 0) {
      targetDir = `${compDef.path}/${entities[0].toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
    }
  }

  const filename = basename(notePath);
  const newRel = resolveUniquePath(vaultPath, targetDir, filename);
  const newAbs = join(vaultPath, newRel);

  mkdirSync(dirname(newAbs), { recursive: true });

  const updatedData = {
    ...data,
    compartment: targetCompartment,
    updated: nowIso(),
  };
  writeFileSync(newAbs, matter.stringify(parsed.content, updatedData), "utf8");
  unlinkSync(absPath);

  // Update SQLite index
  const title = String(data.title ?? filename.replace(/\.md$/, ""));
  const entities = Array.isArray(data.entities) ? data.entities.map(String) : [];
  const tags = Array.isArray(data.tags) ? data.tags.map(String) : [];
  const summary = String(data.summary ?? parsed.content.slice(0, 300).replace(/\s+/g, " "));

  index.db.prepare("DELETE FROM notes WHERE path = ?").run(notePath);
  index.upsertNote({
    path: newRel,
    compartment: targetCompartment,
    title,
    entities,
    tags,
    summary,
    updated_at: nowIso(),
  });

  // Update dump records to point to new path
  index.db.prepare("UPDATE dumps SET note_path = ? WHERE note_path = ?").run(newRel, notePath);

  // Record correction
  const dumpRow = index.db
    .prepare("SELECT id FROM dumps WHERE note_path = ? ORDER BY created_at DESC LIMIT 1")
    .get(newRel) as { id: string } | undefined;
  if (dumpRow) {
    index.addCorrection(dumpRow.id, String(data.summary ?? title).slice(0, 500), currentCompartment, targetCompartment);
  }

  return { oldPath: notePath, newPath: newRel, compartment: targetCompartment, action: "moved" };
}

export function deleteNote(
  vaultPath: string,
  index: DendriteIndex,
  notePath: string,
): TriageResult {
  validatePath(notePath);

  const absPath = join(vaultPath, notePath);
  if (!existsSync(absPath)) {
    // Clean up SQLite even if file is gone
    index.db.prepare("DELETE FROM notes WHERE path = ?").run(notePath);
    index.db.prepare("DELETE FROM dumps WHERE note_path = ?").run(notePath);
    return { oldPath: notePath, newPath: notePath, compartment: "deleted", action: "deleted" };
  }

  // Read frontmatter for correction record
  const raw = readFileSync(absPath, "utf8");
  const parsed = matter(raw);
  const data = parsed.data as Record<string, unknown>;
  const oldCompartment = String(data.compartment ?? "inbox");
  const title = String(data.title ?? notePath);

  // Soft delete: move to trash
  const trashDir = "brain/_dendrite/trash";
  const trashAbs = join(vaultPath, trashDir);
  mkdirSync(trashAbs, { recursive: true });

  const filename = basename(notePath);
  let trashRel = `${trashDir}/${filename}`;
  let trashFile = join(vaultPath, trashRel);
  let counter = 1;
  const base = filename.replace(/\.md$/i, "");
  while (existsSync(trashFile)) {
    trashRel = `${trashDir}/${base}-${counter}.md`;
    trashFile = join(vaultPath, trashRel);
    counter++;
  }

  renameSync(absPath, trashFile);

  // Remove from SQLite
  index.db.prepare("DELETE FROM notes WHERE path = ?").run(notePath);
  index.db.prepare("DELETE FROM dumps WHERE note_path = ?").run(notePath);

  // Record correction
  const dumpRow = index.db
    .prepare("SELECT id FROM dumps WHERE note_path = ? ORDER BY created_at DESC LIMIT 1")
    .get(notePath) as { id: string } | undefined;
  if (dumpRow) {
    index.addCorrection(dumpRow.id, String(data.summary ?? title).slice(0, 500), oldCompartment, "deleted");
  }

  return { oldPath: notePath, newPath: trashRel, compartment: "deleted", action: "deleted", trashPath: trashRel };
}

export function approveNote(
  vaultPath: string,
  index: DendriteIndex,
  notePath: string,
  compartments: CompartmentsFile,
  config: DendriteConfig,
): TriageResult {
  validatePath(notePath);

  const absPath = join(vaultPath, notePath);
  if (!existsSync(absPath)) {
    throw new Error(`Note not found: ${notePath}`);
  }

  const raw = readFileSync(absPath, "utf8");
  const parsed = matter(raw);
  const data = parsed.data as Record<string, unknown>;
  const targetCompartment = String(data.compartment ?? "inbox");

  if (targetCompartment === "inbox") {
    throw new Error("No target compartment set in frontmatter. Use reclassify instead.");
  }

  return moveNoteToCompartment(vaultPath, index, notePath, targetCompartment, compartments, config);
}