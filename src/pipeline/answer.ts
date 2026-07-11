import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import type { DendriteConfig, LlmEndpoints } from "../config.js";
import type { DendriteIndex } from "./index.js";
import { createChatProvider } from "../providers/llm.js";
import { smartSearch } from "./search.js";
import { wikilink } from "../util/slug.js";

export interface AnswerSource {
  path: string;
  title: string;
  slug: string;
  score: number;
}

export interface AnswerResult {
  question: string;
  answer: string;
  sources: AnswerSource[];
  /** Number of notes whose content was placed in the LLM context window. */
  usedNotes: number;
  /** True when no note cleared the retrieval floor, so no LLM call was made. */
  refused: boolean;
}

const REFUSAL =
  "I don't have a note about that in the vault. Capture it first with `dendrite ingest`.";

const ANSWER_SYSTEM = `You are Dendrite's librarian. Answer the user's question using ONLY the notes provided as context.

Rules:
- Ground every claim in the provided notes. Do not use outside knowledge or guess.
- Cite the notes you used inline with their wikilink, e.g. [[note-slug]].
- If the notes do not contain the answer, reply exactly: "The vault does not contain an answer to that." Do not invent facts.
- Be concise. Prefer a direct answer over a summary of the notes.`;

function slugOf(path: string): string {
  return path.replace(/\.md$/i, "").split("/").pop() ?? path;
}

/** Read a note body (frontmatter stripped) from disk, best-effort. */
function readNoteBody(vaultPath: string, relPath: string): string {
  const abs = join(vaultPath, relPath);
  if (!existsSync(abs)) return "";
  try {
    const { content } = matter(readFileSync(abs, "utf8"));
    return content.trim();
  } catch {
    return "";
  }
}

/**
 * Retrieval-augmented question answering over the vault.
 *
 * Hybrid-search the index, pull the matching note bodies into a bounded context
 * window, and ask the LLM to answer with inline `[[wikilink]]` citations. This is
 * strictly read-only and refuses (without an LLM call) when nothing is retrieved.
 */
export async function answerQuestion(
  index: DendriteIndex,
  vaultPath: string,
  question: string,
  config: DendriteConfig,
  llm: LlmEndpoints,
  opts?: { compartment?: string; k?: number },
): Promise<AnswerResult> {
  const q = question.trim();
  if (!q) throw new Error("Empty question");

  const k = opts?.k ?? config.retrieval.k;
  const hits = (
    await smartSearch(index, q, config, llm, {
      compartment: opts?.compartment,
      limit: k,
      excludeEphemeral: false,
    })
  ).filter(
    // Answer from captured knowledge under brain/, not vault scaffolding
    // (e.g. a starter README) which pollutes context and derails small models.
    (h) => h.path.startsWith("brain/") && h.score >= config.retrieval.min_score,
  );

  const sources: AnswerSource[] = hits.map((h) => ({
    path: h.path,
    title: h.title,
    slug: slugOf(h.path),
    score: h.score,
  }));

  if (hits.length === 0) {
    return { question: q, answer: REFUSAL, sources: [], usedNotes: 0, refused: true };
  }

  // Build a bounded context window from note bodies.
  const budget = config.retrieval.max_context_chars;
  const blocks: string[] = [];
  let used = 0;
  let usedNotes = 0;
  for (const hit of hits) {
    if (used >= budget) break;
    const body = readNoteBody(vaultPath, hit.path) || hit.snippet;
    const remaining = budget - used;
    const excerpt = body.length > remaining ? body.slice(0, remaining) + "…" : body;
    blocks.push(
      `### ${wikilink(slugOf(hit.path))} — ${hit.title}\n(path: ${hit.path})\n${excerpt}`,
    );
    used += excerpt.length;
    usedNotes++;
  }

  const context = blocks.join("\n\n---\n\n");
  const userContent = `Question: ${q}\n\nNotes:\n${context}`;

  const chat = createChatProvider(llm);
  const answer = (
    await chat.complete({
      messages: [
        { role: "system", content: ANSWER_SYSTEM },
        { role: "user", content: userContent },
      ],
      temperature: 0,
    })
  ).trim();

  return { question: q, answer, sources, usedNotes, refused: false };
}
