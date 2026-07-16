import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import { loadConfig } from "../config.js";
import { writeVaultCatalog } from "../pipeline/catalog.js";
import { DendriteIndex } from "../pipeline/index.js";
import {
  planMerge,
  resolveVaultRelativePath,
  rewriteWikilinks,
  type MergeInto,
  type MergeNoteInput,
} from "../pipeline/merge-notes.js";
import { walkVaultNotes } from "../util/vault-path.js";

export interface RunMergeOptions {
  config?: string;
  pathA: string;
  pathB: string;
  into?: MergeInto;
  dryRun?: boolean;
}

export async function runMerge(opts: RunMergeOptions): Promise<void> {
  const { config } = loadConfig(opts.config);
  const vaultPath = config.vault.path;
  const into: MergeInto = opts.into === "B" ? "B" : "A";

  const relA = resolveVaultRelativePath(vaultPath, opts.pathA);
  const relB = resolveVaultRelativePath(vaultPath, opts.pathB);

  if (relA === relB) {
    console.error("Cannot merge a note with itself.");
    process.exit(1);
  }

  const absA = join(vaultPath, relA);
  const absB = join(vaultPath, relB);
  if (!existsSync(absA)) {
    console.error(`Note not found: ${relA}`);
    process.exit(1);
  }
  if (!existsSync(absB)) {
    console.error(`Note not found: ${relB}`);
    process.exit(1);
  }

  const readNote = (rel: string): MergeNoteInput => {
    const raw = readFileSync(join(vaultPath, rel), "utf8");
    const { data, content } = matter(raw);
    return { path: rel, frontmatter: data as Record<string, unknown>, content };
  };

  const noteA = readNote(relA);
  const noteB = readNote(relB);
  const vaultNotes = walkVaultNotes(vaultPath);
  const readContent = (rel: string) => readFileSync(join(vaultPath, rel), "utf8");

  const plan = planMerge(relA, relB, into, noteA, noteB, vaultNotes, readContent);
  const backlinkCount = plan.backlinkRewrites.reduce((n, r) => n + r.occurrences, 0);

  console.log(`Survivor: ${plan.survivorPath}`);
  console.log(`Absorbed: ${plan.absorbedPath}`);
  console.log(
    `Sections: ${plan.survivorSectionCount} (survivor) + ${plan.absorbedSectionCount} (absorbed) → ${plan.mergedSectionCount} merged`,
  );
  console.log(`Backlink rewrites: ${backlinkCount} in ${plan.backlinkRewrites.length} note(s)`);
  if (plan.backlinkRewrites.length > 0) {
    for (const r of plan.backlinkRewrites) {
      console.log(`  · ${r.notePath}: ${r.occurrences}`);
    }
  }
  console.log(`Archive: ${plan.archivePath}`);

  if (opts.dryRun) {
    console.log("\n(dry-run: nothing written)");
    return;
  }

  const index = new DendriteIndex(config.index.db_path);
  try {
    const survivorAbs = join(vaultPath, plan.survivorPath);
    writeFileSync(
      survivorAbs,
      matter.stringify(plan.mergedBody, plan.mergedFrontmatter),
      "utf8",
    );

    for (const rewrite of plan.backlinkRewrites) {
      const abs = join(vaultPath, rewrite.notePath);
      const raw = readFileSync(abs, "utf8");
      const { text } = rewriteWikilinks(raw, plan.absorbedSlug, plan.survivorSlug);
      if (text !== raw) writeFileSync(abs, text, "utf8");
    }

    const absorbedRaw = readFileSync(join(vaultPath, plan.absorbedPath), "utf8");
    const archiveAbs = join(vaultPath, plan.archivePath);
    mkdirSync(join(vaultPath, "brain/_dendrite/repaired"), { recursive: true });
    writeFileSync(archiveAbs, absorbedRaw, "utf8");
    unlinkSync(join(vaultPath, plan.absorbedPath));

    index.db.prepare(`DELETE FROM notes WHERE path = ?`).run(plan.absorbedPath);
    index.db.prepare(`DELETE FROM embeddings WHERE note_path = ?`).run(plan.absorbedPath);
    index.db
      .prepare(`UPDATE dumps SET note_path = ? WHERE note_path = ?`)
      .run(plan.survivorPath, plan.absorbedPath);
    index.indexFile(survivorAbs, vaultPath);

    const absorbedFm =
      plan.absorbedPath === relA ? noteA.frontmatter : noteB.frontmatter;
    const survivorFm =
      plan.survivorPath === relA ? noteA.frontmatter : noteB.frontmatter;
    const dumpId = String(absorbedFm.split_group ?? "") || null;
    index.addCorrection(
      dumpId,
      `merge ${plan.absorbedPath} → ${plan.survivorPath}`,
      String(absorbedFm.compartment ?? ""),
      String(survivorFm.compartment ?? ""),
    );

    writeVaultCatalog(vaultPath, index);
    console.log("\nMerged notes, rewrote backlinks, archived absorbed note, and updated index.");
  } finally {
    index.close();
  }
}
