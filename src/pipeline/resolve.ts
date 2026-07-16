import { join } from "node:path";
import type { Classification, Dump, ResolvedTarget } from "../types.js";
import type { CompartmentsFile } from "../types.js";
import type { DendriteConfig } from "../config.js";
import { getCompartmentPath } from "../config.js";
import type { DendriteIndex } from "./index.js";
import { disambiguateNote } from "./classify.js";
import type { ChatProvider } from "../providers/llm.js";
import { slugify } from "../util/slug.js";
import { dailyNoteFilename } from "../util/datetime.js";
import { resolveBrainNotePath } from "../util/vault-path.js";

export async function resolveTarget(
  dump: Dump,
  classification: Classification,
  compartments: CompartmentsFile,
  config: DendriteConfig,
  index: DendriteIndex,
  vaultPath: string,
  llm: ChatProvider,
): Promise<ResolvedTarget> {
  let compartment = classification.compartment;

  // Durable facts must never land in ephemeral daily journal.
  if (compartment === "journal" && classification.durability === "durable") {
    if (classification.extracted.people.length > 0) {
      compartment = "memories";
    } else if (classification.extracted.tasks.length > 0) {
      compartment = "tasks";
    } else if (classification.extracted.resources.length > 0) {
      compartment = "reads";
    } else {
      compartment = "memories";
    }
    classification.compartment = compartment;
  }

  if (classification.confidence < config.classification.confidence.confirm_below) {
    compartment = "inbox";
  }

  if (dump.meta?.require_review) {
    compartment = "inbox";
  }

  const compDef = getCompartmentPath(compartments, compartment);
  if (!compDef) {
    compartment = "inbox";
  }
  const finalDef = getCompartmentPath(compartments, compartment)!;

  if (finalDef.append_only) {
    const fname = dailyNoteFilename(new Date(dump.receivedAt), config.vault.timezone);
    const notePath = join(finalDef.path, fname).replace(/\\/g, "/");
    return {
      compartment,
      notePath,
      slug: fname.replace(/\.md$/, ""),
      action: "append_existing",
    };
  }

  const searchQuery = [
    classification.title,
    ...classification.entities,
    dump.text?.slice(0, 200) ?? "",
  ].join(" ");

  const candidates = index.search(searchQuery, compartment === "inbox" ? undefined : compartment, 5);
  const strong = config.classification.strong_match_threshold;
  const weak = config.classification.weak_match_threshold;

  let slug: string | null = null;
  let action: "create_new" | "append_existing" = classification.note_action;

  if (classification.note_action === "create_new") {
    // Honor explicit create_new (e.g. laundry-list splits) — skip FTS append.
  } else if (
    classification.note_action === "append_existing" &&
    classification.target_note &&
    candidates.some((c) => c.path.includes(classification.target_note!))
  ) {
    slug = classification.target_note.replace(/\.md$/, "");
    action = "append_existing";
  } else if (candidates[0] && candidates[0].score >= strong) {
    slug = candidates[0].path.replace(/\.md$/, "").split("/").pop() ?? null;
    action = "append_existing";
  } else if (candidates[0] && candidates[0].score >= weak) {
    const picked = await disambiguateNote(dump, candidates, llm);
    if (picked) {
      slug = picked.replace(/\.md$/, "");
      action = "append_existing";
    }
  }

  if (!slug) {
    const baseSlug =
      finalDef.subdivide_by === "entity" && classification.entities[0]
        ? slugify(classification.entities[0])
        : slugify(classification.title);
    slug = baseSlug;
    action = "create_new";
  }

  const notePath = resolveBrainNotePath(
    config.organization,
    finalDef.path,
    slug,
    finalDef.append_only,
  );
  return { compartment, notePath, slug, action };
}
