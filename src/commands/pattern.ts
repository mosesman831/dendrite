import { loadConfig } from "../config.js";
import { createPipelineContext } from "../pipeline/pipeline.js";
import { runPatternScan as scanPatterns } from "../pattern/weekly.js";

export async function runPatternScan(opts: { config?: string }): Promise<void> {
  const { config, configDir, llm } = loadConfig(opts.config);
  const ctx = createPipelineContext(config, configDir, llm);
  const report = scanPatterns(ctx, config);
  if (report) {
    console.log(report);
  } else {
    console.log("[SILENT] Nothing to report.");
  }
  ctx.index.close();
}
