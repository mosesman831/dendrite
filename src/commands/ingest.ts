import type { Dump } from "../types.js";
import { loadConfig } from "../config.js";
import { createPipelineContext, processDump } from "../pipeline/pipeline.js";
import { hashId } from "../util/slug.js";

export async function runIngest(
  text: string | undefined,
  opts: { config?: string; file?: string; dryRun?: boolean },
): Promise<void> {
  const { config, configDir, llm } = loadConfig(opts.config);
  const ctx = createPipelineContext(config, configDir, llm, opts.dryRun);

  const dump: Dump = {
    id: `cli-${hashId((text ?? opts.file ?? "") + Date.now())}`,
    source: "cli",
    receivedAt: new Date().toISOString(),
    text,
    audioPath: opts.file,
  };

  try {
    const results = await processDump(ctx, dump);
    console.log(JSON.stringify(results, null, 2));
    if (opts.dryRun) {
      console.log("\n(dry-run: nothing written)");
    }
  } finally {
    ctx.index.close();
  }
}
