import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import matter from "gray-matter";
import { loadConfig, loadCompartments } from "../config.js";
import { DendriteIndex, isSystemNotePath } from "../pipeline/index.js";
import { migrateNoteFile } from "../pipeline/migrations.js";
import {
  isFlatBrainNotePath,
  isFolderBrainNotePath,
  walkVaultNotes,
} from "../util/vault-path.js";
import { writeVaultCatalog } from "../pipeline/catalog.js";

export interface MigrateOptions {
  config?: string;
  dryRun?: boolean;
  toFlat?: boolean;
  toFolders?: boolean;
}

export async function runMigrate(opts: MigrateOptions = {}): Promise<void> {
  if (opts.toFlat && opts.toFolders) {
    throw new Error("Cannot use --to-flat and --to-folders together");
  }

  if (opts.toFlat || opts.toFolders) {
    await runOrganizationMigrate(opts);
    return;
  }

  const { config } = loadConfig(opts.config);
  const notes = walkVaultNotes(config.vault.path, (rel) => rel.startsWith("brain/"));
  const index = new DendriteIndex(config.index.db_path);

  let migrated = 0;
  let skipped = 0;

  console.log(
    opts.dryRun
      ? `Dry-run: checking ${notes.length} brain note(s) for frontmatter migrations…\n`
      : `Migrating frontmatter for ${notes.length} brain note(s)…\n`,
  );

  try {
    for (const rel of notes) {
      const result = migrateNoteFile(config.vault.path, rel, !!opts.dryRun);
      if (!result) {
        skipped++;
        continue;
      }
      migrated++;
      console.log(
        `  ${opts.dryRun ? "would migrate" : "migrated"} ${rel} (v${result.fromVersion} → v${result.toVersion})`,
      );
      for (const c of result.changes) console.log(`    · ${c}`);
    }

    if (!opts.dryRun && migrated > 0) {
      index.reindexVault(config.vault.path);
      writeVaultCatalog(config.vault.path, index);
      console.log("\nReindexed vault and updated catalog.");
    }

    console.log(`\nDone: ${migrated} migrated, ${skipped} already current.`);
    if (opts.dryRun && migrated > 0) console.log("(dry-run: nothing written)");
  } finally {
    index.close();
  }
}

interface RelocatePlan {
  from: string;
  to: string;
  reason?: string;
}

async function runOrganizationMigrate(opts: MigrateOptions): Promise<void> {
  const { config, configDir } = loadConfig(opts.config);
  const compartments = loadCompartments(config, configDir);
  const vaultPath = config.vault.path;
  const mode = opts.toFlat ? "to-flat" : "to-folders";
  const appendOnlyFolders = new Set<string>();
  const validCompartments = new Set<string>(["inbox"]);
  for (const [name, def] of Object.entries(compartments.compartments)) {
    validCompartments.add(name);
    if (def.append_only) appendOnlyFolders.add(def.path);
  }
  appendOnlyFolders.add(compartments.inbox.path);

  const notes = walkVaultNotes(vaultPath, (rel) => rel.startsWith("brain/"));
  const plans: RelocatePlan[] = [];
  const reservedTargets = new Set<string>(notes);
  let skipped = 0;

  for (const rel of notes) {
    if (isSystemNotePath(rel)) continue;
    const plan = planOrganizationMove(
      rel,
      mode,
      appendOnlyFolders,
      validCompartments,
      vaultPath,
      reservedTargets,
    );
    if (!plan) {
      if (mode === "to-folders" && isFlatBrainNotePath(rel)) {
        skipped++;
        console.log(`  skip  ${rel} (missing or unknown compartment in frontmatter)`);
      }
      continue;
    }
    plans.push(plan);
    reservedTargets.delete(plan.from);
    reservedTargets.add(plan.to);
  }

  console.log(
    opts.dryRun
      ? `\nDry-run: ${plans.length} note(s) would be relocated (${mode})…\n`
      : `\nRelocating ${plans.length} note(s) (${mode})…\n`,
  );

  if (plans.length === 0) {
    console.log(`Nothing to relocate.${skipped ? ` (${skipped} skipped)` : ""}`);
    return;
  }

  const index = new DendriteIndex(config.index.db_path);
  let moved = 0;

  try {
    for (const plan of plans) {
      console.log(`  ${opts.dryRun ? "would move" : "move"} ${plan.from} → ${plan.to}`);
      if (plan.reason) console.log(`    · ${plan.reason}`);

      if (!opts.dryRun) {
        const src = join(vaultPath, plan.from);
        const dest = join(vaultPath, plan.to);
        const raw = readFileSync(src, "utf8");
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, raw, "utf8");
        archiveRelocatedSource(vaultPath, plan.from);
        moved++;
      }
    }

    if (!opts.dryRun && moved > 0) {
      index.reindexVault(vaultPath);
      writeVaultCatalog(vaultPath, index);
      console.log("\nReindexed vault and updated catalog.");
    }

    console.log(`\nDone: ${opts.dryRun ? plans.length : moved} relocated${skipped ? `, ${skipped} skipped` : ""}.`);
    if (opts.dryRun) console.log("(dry-run: nothing written)");
  } finally {
    index.close();
  }
}

function planOrganizationMove(
  rel: string,
  mode: "to-flat" | "to-folders",
  appendOnlyFolders: Set<string>,
  validCompartments: Set<string>,
  vaultPath: string,
  reservedTargets: Set<string>,
): RelocatePlan | null {
  const parts = rel.split("/");
  const slug = parts[parts.length - 1]!;

  if (mode === "to-flat") {
    if (!isFolderBrainNotePath(rel)) return null;
    const folder = `brain/${parts[1]}`;
    if (appendOnlyFolders.has(folder)) return null;

    let target = `brain/${slug}`;
    if (reservedTargets.has(target) && target !== rel) {
      target = `brain/${parts[1]}-${slug}`;
    }
    if (target === rel) return null;
    return { from: rel, to: target };
  }

  if (!isFlatBrainNotePath(rel)) return null;

  const abs = join(vaultPath, rel);
  const { data } = matter(readFileSync(abs, "utf8"));
  const compartment = String(data.compartment ?? "").trim();
  if (!compartment || !validCompartments.has(compartment)) return null;

  const compPath = compartment === "inbox" ? "brain/inbox" : `brain/${compartment}`;
  if (appendOnlyFolders.has(compPath) && compartment !== "inbox") return null;

  let target = `${compPath}/${slug}`;
  if (reservedTargets.has(target) && target !== rel) {
    target = `${compPath}/${compartment}-${slug}`;
  }
  if (target === rel) return null;
  return { from: rel, to: target, reason: `compartment=${compartment}` };
}

function archiveRelocatedSource(vaultPath: string, rel: string): void {
  const src = join(vaultPath, rel);
  const dest = join(vaultPath, "brain/_dendrite/imported", rel);
  mkdirSync(dirname(dest), { recursive: true });
  renameSync(src, dest);
}
