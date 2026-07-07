import { ClassificationSchema, type Classification, type Dump } from "../types.js";
import type { CompartmentsFile } from "../types.js";
import type { Correction } from "../types.js";
import type { ChatProvider } from "../providers/llm.js";
import type { DendriteConfig } from "../config.js";
import { listCompartmentNames } from "../config.js";

const CLASSIFIER_SYSTEM = `You are Dendrite's classifier. Given raw text and available brain compartments, output a single JSON object with these fields:
- compartment: one of the provided compartment keys, or "inbox" if nothing fits
- durability: "durable" or "ephemeral"
  - durable = facts, knowledge, people, tasks, ideas worth finding again months later → topic-based notes (memories, learnings, projects, etc.)
  - ephemeral = today's mood, mundane events, stream-of-consciousness with no lasting value → journal ONLY
- confidence: 0.0-1.0 how sure you are
- entities: key nouns, tools, people, concepts (array of strings)
- note_action: "create_new" or "append_existing"
- target_note: slug filename without path when append_existing, else null
- links: suggested wikilink targets as slugs (no brackets), may be empty. Do NOT link daily journal date slugs (e.g. 07-07-2026).
- extracted: { tasks: [], dates: [], people: [], resources: [] }
- summary: one-line summary
- title: proposed note title
- tags: relevant tags array

Durability rules (critical):
- Personal facts ("parents live in X", preferences, relationships) → memories, durability=durable. NEVER journal.
- Learned concepts, techniques → learnings. Projects → projects. Tasks → tasks.
- journal is ONLY for ephemeral day logs when durability=ephemeral.
- When vault index lists an existing note on the same topic, prefer append_existing with that slug.

Be decisive but honest about confidence. Prefer append_existing when topic clearly matches prior content.
Never invent compartments not in the list. Use inbox when unsure.`;

export async function classifyDump(
  dump: Dump,
  compartments: CompartmentsFile,
  llm: ChatProvider,
  config: DendriteConfig,
  corrections: Correction[] = [],
  candidateNotes: string[] = [],
  vaultIndex?: string,
): Promise<Classification> {
  const names = listCompartmentNames(compartments);
  const compartmentDesc = names
    .map((n) => {
      const def = n === "inbox" ? compartments.inbox : compartments.compartments[n];
      const ex = def.examples?.length ? ` Examples: ${def.examples.join("; ")}` : "";
      return `- ${n}: ${def.description}.${ex}`;
    })
    .join("\n");

  const correctionBlock =
    corrections.length > 0
      ? "\n\nRecent user corrections (learn from these):\n" +
        corrections
          .map(
            (c) =>
              `"${c.text_excerpt}" was filed as ${c.predicted_compartment} but user wanted ${c.corrected_compartment}`,
          )
          .join("\n")
      : "";

  const candidateBlock =
    candidateNotes.length > 0
      ? "\n\nPossibly related existing notes:\n" + candidateNotes.map((n) => `- ${n}`).join("\n")
      : "";

  const indexBlock = vaultIndex ? `\n\nVault index (what already exists — use for append_existing):\n${vaultIndex}` : "";

  const userContent = `Compartments:\n${compartmentDesc}${correctionBlock}${candidateBlock}${indexBlock}\n\nDump text:\n${dump.text}`;

  const raw = await llm.complete({
    messages: [
      { role: "system", content: CLASSIFIER_SYSTEM },
      { role: "user", content: userContent },
    ],
    temperature: config.classification.temperature,
    jsonMode: true,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(raw));
  } catch {
    const repaired = await llm.complete({
      messages: [
        { role: "system", content: "Fix this into valid JSON matching the classification schema. JSON only." },
        { role: "user", content: raw },
      ],
      temperature: 0,
      jsonMode: true,
    });
    parsed = JSON.parse(stripFences(repaired));
  }

  const result = ClassificationSchema.parse(parsed);

  if (!names.includes(result.compartment) && result.compartment !== "inbox") {
    result.compartment = "inbox";
    result.confidence = Math.min(result.confidence, 0.4);
  }

  return result;
}

export async function disambiguateNote(
  dump: Dump,
  candidates: Array<{ path: string; title: string; snippet: string }>,
  llm: ChatProvider,
): Promise<string | null> {
  const raw = await llm.complete({
    messages: [
      {
        role: "system",
        content:
          'Pick the best matching note slug to append to, or null to create new. Reply JSON: {"target_note": "slug-or-null"}',
      },
      {
        role: "user",
        content: `Dump:\n${dump.text}\n\nCandidates:\n${candidates.map((c) => `- ${c.path} (${c.title}): ${c.snippet}`).join("\n")}`,
      },
    ],
    temperature: 0,
    jsonMode: true,
  });
  try {
    const parsed = JSON.parse(stripFences(raw)) as { target_note: string | null };
    return parsed.target_note;
  } catch {
    return null;
  }
}

function stripFences(text: string): string {
  let t = text.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }
  return t.trim();
}
