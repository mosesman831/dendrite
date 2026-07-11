import { loadConfig } from "../config.js";
import { DendriteIndex } from "../pipeline/index.js";
import { answerQuestion } from "../pipeline/answer.js";

export async function runAsk(
  question: string | undefined,
  opts: { config?: string; compartment?: string; k?: string; json?: boolean },
): Promise<void> {
  const q = (question ?? "").trim();
  if (!q) {
    console.error('Usage: dendrite ask "your question"');
    process.exit(1);
  }

  const { config, llm } = loadConfig(opts.config);
  const index = new DendriteIndex(config.index.db_path);

  try {
    const result = await answerQuestion(index, config.vault.path, q, config, llm, {
      compartment: opts.compartment,
      k: opts.k ? Number(opts.k) : undefined,
    });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(`\n${result.answer}\n`);
    if (result.sources.length > 0) {
      console.log("Sources:");
      for (const s of result.sources) {
        console.log(`  - [[${s.slug}]] — ${s.title}  (${s.path}, score ${s.score.toFixed(3)})`);
      }
      console.log(`\n(${result.usedNotes} note${result.usedNotes === 1 ? "" : "s"} used as context)`);
    }
  } finally {
    index.close();
  }
}
