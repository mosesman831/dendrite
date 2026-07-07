import {
  ClassificationSchema,
  MultiClassificationSchema,
  type Classification,
  type Dump,
  type Segment,
} from "../types.js";
import type { CompartmentsFile } from "../types.js";
import type { Correction } from "../types.js";
import type { ChatProvider } from "../providers/llm.js";
import type { DendriteConfig } from "../config.js";
import { listCompartmentNames } from "../config.js";
import { classifyDump } from "./classify.js";

function buildMultiSystemPrompt(bias: "conservative" | "aggressive", maxSegments: number): string {
  const biasText =
    bias === "conservative"
      ? `  • conservative (default): when unsure whether two parts are related,
    KEEP THEM TOGETHER. Split only on a clear change of subject.`
      : `  • aggressive: separate each distinct knowledge/action item even if
    loosely related — but NEVER split a single coherent thought.`;

  return `You are Dendrite's ingestion classifier. You receive ONE raw capture (typed
text or a voice transcript) from a single user. In ONE pass you must:

  1. SEGMENT the capture into one or more independent items. An "item" is a
     self-contained thought that a person would file as its own note.
  2. CLASSIFY each item into exactly one compartment.

Return STRICT JSON only — no prose, no markdown, no code fences:
  { "segments": [ { <fields> }, ... ] }

======================================================================
WHEN TO SPLIT (and, more importantly, when NOT to)
======================================================================
Default to FEWER notes. Splitting a single coherent thought is a worse
error than keeping two loosely-related thoughts together.

Keep as ONE segment when:
  • Later sentences elaborate, justify, exemplify, or add detail to the
    same subject.
  • Parts are joined by cause/effect or "and so" logic
    ("the deploy failed so I need to fix the script" = ONE item).
  • It is a single list about one theme (a list of quotes = ONE item;
    a packing list = ONE item).
  • The parts share the same project/person and read as one update.

Split into SEPARATE segments when:
  • The parts are about genuinely different subjects a person would file
    in different places (a personal fact + an errand + a technical fact).
  • The subject changes with no logical link between parts.
  • Different compartments clearly apply AND the parts do not depend on
    each other.
  • A laundry list of unrelated personal facts chained with "and"
    ("my son goes to X and my daughter goes to Y and I like Z and I have A")
    — EACH distinct fact is its own segment, usually all memories but
    separate notes (schools, food prefs, devices, degrees, etc.).

BIAS = ${bias}
${biasText}

Never produce more than ${maxSegments} segments. If the capture holds
more distinct items than that, MERGE the least important / most similar
trailing items into the final segment. Never drop content.

======================================================================
TEXT HANDLING (critical — violations corrupt the vault)
======================================================================
  • Each segment's "text" MUST be copied VERBATIM from the input: exact
    words, no paraphrasing, no grammar fixes, no summarizing. (You may
    only repair obvious transcription artifacts, e.g. a clearly
    duplicated "the the".)
  • The segments TOGETHER must cover ALL meaningful content. Do not drop
    sentences. Pure filler ("um", "so yeah", "you know") may be omitted.
  • Segments MUST NOT overlap — each sentence belongs to exactly one.
  • Preserve the input's ORIGINAL ORDER.

======================================================================
PER-SEGMENT FIELDS (all required)
======================================================================
  text        : verbatim slice (see rules above).
  compartment : one of the provided compartment keys, or "inbox".
  durability  : "durable" | "ephemeral".
      durable   = facts, knowledge, people, tasks, ideas worth finding
                  again in months → topic notes (memories, learnings,
                  projects, tasks, ideas, reads, reflections).
      ephemeral = today's mood / mundane events / stream-of-thought with
                  no lasting value → journal ONLY.
  confidence  : 0.0–1.0 for THIS segment's compartment (independent of
                the others).
  note_action : "create_new" | "append_existing".
  target_note : slug (filename, no path/extension) when append_existing,
                else null.
  links       : related existing-note slugs (no brackets; never link
                daily date slugs like 07-07-2026); may be empty.
  entities    : key nouns/tools/people/concepts for THIS segment.
  extracted   : { "tasks": [], "dates": [], "people": [], "resources": [] }
                for THIS segment only.
  summary     : one concise line describing this segment.
  title       : proposed note title for this segment.
  tags        : relevant tags for this segment.

======================================================================
DURABILITY & ROUTING RULES (apply per segment)
======================================================================
  • Personal facts (relationships, where people live, preferences) →
    memories, durability=durable. NEVER journal.
  • Learned concepts/techniques → learnings. Ongoing work → projects.
    To-dos/follow-ups → tasks. Articles/books/links → reads.
    People/team dynamics/personal growth → reflections.
  • journal is ONLY for ephemeral day logs.
  • If the provided vault index already lists a note on the same topic,
    set note_action="append_existing" with that slug.

======================================================================
DECISIVENESS
======================================================================
  • Be decisive but honest about confidence.
  • A single coherent capture MUST yield exactly ONE segment — do not
    invent splits to appear thorough.
  • Never invent a compartment not in the provided list; use "inbox"
    when nothing fits.

Output ONLY the JSON object.`;
}

function buildUserContent(
  dump: Dump,
  compartments: CompartmentsFile,
  corrections: Correction[],
  candidateNotes: string[],
  vaultIndex?: string,
): string {
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

  const indexBlock = vaultIndex
    ? `\n\nVault index (what already exists — use for append_existing):\n${vaultIndex}`
    : "";

  return `Compartments:\n${compartmentDesc}${correctionBlock}${candidateBlock}${indexBlock}\n\nCapture:\n${dump.text}`;
}

function stripFences(text: string): string {
  let t = text.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }
  return t.trim();
}

/** Meaningful character count (letters/digits) for coverage checks. */
function meaningfulChars(s: string): number {
  return (s.match(/[\p{L}\p{N}]/gu) ?? []).length;
}

function segmentsOverlap(a: string, b: string): boolean {
  const na = a.trim().toLowerCase();
  const nb = b.trim().toLowerCase();
  if (!na || !nb) return false;
  if (na.includes(nb) || nb.includes(na)) return na.length > 20 && nb.length > 20;
  return false;
}

export function validateAndNormalizeSegments(
  segments: Segment[],
  originalText: string,
  config: DendriteConfig,
  compartmentNames: string[],
): Segment[] {
  const split = config.classification.split;
  let out = segments.filter((s) => s.text?.trim());

  if (out.length === 0) return out;

  // Cap: merge trailing into last
  if (out.length > split.max_segments) {
    const kept = out.slice(0, split.max_segments - 1);
    const merged = out.slice(split.max_segments - 1);
    const last: Segment = {
      ...merged[0]!,
      text: merged.map((m) => m.text.trim()).join(" "),
      summary: merged.map((m) => m.summary).join("; "),
      entities: [...new Set(merged.flatMap((m) => m.entities))],
      tags: [...new Set(merged.flatMap((m) => m.tags))],
      extracted: {
        tasks: [...new Set(merged.flatMap((m) => m.extracted.tasks))],
        dates: [...new Set(merged.flatMap((m) => m.extracted.dates))],
        people: [...new Set(merged.flatMap((m) => m.extracted.people))],
        resources: [...new Set(merged.flatMap((m) => m.extracted.resources))],
      },
    };
    out = [...kept, last];
  }

  // Overlap check
  for (let i = 0; i < out.length; i++) {
    for (let j = i + 1; j < out.length; j++) {
      if (segmentsOverlap(out[i]!.text, out[j]!.text)) {
        return []; // signal fallback
      }
    }
  }

  // Coverage check
  const combined = out.map((s) => s.text).join(" ");
  const orig = meaningfulChars(originalText);
  const cov = orig > 0 ? meaningfulChars(combined) / orig : 1;
  if (cov < split.min_coverage) {
    return [];
  }

  // Compartment validation + min confidence → inbox
  for (const seg of out) {
    if (!compartmentNames.includes(seg.compartment) && seg.compartment !== "inbox") {
      seg.compartment = "inbox";
      seg.confidence = Math.min(seg.confidence, 0.4);
    }
    if (seg.confidence < split.min_segment_confidence) {
      seg.compartment = "inbox";
    }
  }

  return out;
}

export function shouldShortCircuitMulti(text: string, config: DendriteConfig): boolean {
  const limit = config.classification.split.short_circuit_chars;
  if (limit <= 0) return false;
  const trimmed = text.trim();
  if (detectLaundryListClauses(trimmed)) return false;
  if (trimmed.length > limit) return false;
  const sentences = trimmed.split(/(?<=[.!?])\s+/).filter(Boolean);
  return sentences.length <= 1;
}

/**
 * Detect "laundry list" captures: unrelated facts chained with "and my…" / "and I…".
 * Returns verbatim clause slices or null.
 */
export function detectLaundryListClauses(text: string): string[] | null {
  const trimmed = text.trim();
  const parts = trimmed.split(/\s+and\s+(?=(?:my\s+\w+|I\s+(?:have|like|own|got|am|prefer)\b))/i);
  if (parts.length < 3) return null;
  const clauses = parts.map((p) => p.trim()).filter((p) => p.length > 8);
  return clauses.length >= 3 ? clauses : null;
}

async function classifyClausesAsSegments(
  dump: Dump,
  clauses: string[],
  compartments: CompartmentsFile,
  llm: ChatProvider,
  config: DendriteConfig,
  corrections: Correction[],
  candidateNotes: string[],
  vaultIndex: string | undefined,
  maxSegments: number,
): Promise<Segment[]> {
  let list = clauses;
  if (list.length > maxSegments) {
    const kept = list.slice(0, maxSegments - 1);
    const merged = list.slice(maxSegments - 1).join(" and ");
    list = [...kept, merged];
  }

  const segments: Segment[] = [];
  for (const clause of list) {
    const subDump = { ...dump, text: clause };
    const c = await classifyDump(
      subDump,
      compartments,
      llm,
      config,
      corrections,
      candidateNotes,
      vaultIndex,
    );
    segments.push({
      ...c,
      text: clause,
      note_action: "create_new",
      target_note: null,
    });
  }
  return segments;
}

export async function classifyDumpMulti(
  dump: Dump,
  compartments: CompartmentsFile,
  llm: ChatProvider,
  config: DendriteConfig,
  corrections: Correction[] = [],
  candidateNotes: string[] = [],
  vaultIndex?: string,
): Promise<Segment[]> {
  const names = listCompartmentNames(compartments);
  const split = config.classification.split;

  const laundry = detectLaundryListClauses(dump.text ?? "");
  if (laundry && laundry.length >= 2) {
    return classifyClausesAsSegments(
      dump,
      laundry,
      compartments,
      llm,
      config,
      corrections,
      candidateNotes,
      vaultIndex,
      split.max_segments,
    );
  }

  const userContent = buildUserContent(dump, compartments, corrections, candidateNotes, vaultIndex);
  const system = buildMultiSystemPrompt(split.bias, split.max_segments);

  const raw = await llm.complete({
    messages: [
      { role: "system", content: system },
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
        {
          role: "system",
          content:
            'Fix this into valid JSON: { "segments": [ { text, compartment, durability, confidence, note_action, target_note, links, extracted, summary, title, tags } ] }. JSON only.',
        },
        { role: "user", content: raw },
      ],
      temperature: 0,
      jsonMode: true,
    });
    parsed = JSON.parse(stripFences(repaired));
  }

  let multi = MultiClassificationSchema.parse(parsed);
  let normalized = validateAndNormalizeSegments(multi.segments, dump.text ?? "", config, names);

  if (normalized.length === 0) {
    const single = await classifyDump(
      dump,
      compartments,
      llm,
      config,
      corrections,
      candidateNotes,
      vaultIndex,
    );
    normalized = [{ ...single, text: dump.text!.trim() }];
  }

  return normalized;
}

export function segmentToClassification(seg: Segment): Classification {
  const { text: _t, ...rest } = seg;
  return ClassificationSchema.parse(rest);
}
