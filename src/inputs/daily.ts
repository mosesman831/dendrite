import { CronJob } from "cron";
import type { DendriteConfig } from "../config.js";
import type { PipelineContext } from "../pipeline/pipeline.js";
import { runPatternScan } from "../pattern/weekly.js";

export function scheduleDailyPrompt(
  config: DendriteConfig,
  ctx: PipelineContext,
  send: (chatId: number, text: string) => Promise<void>,
  chatIds: number[],
): CronJob | null {
  if (!config.inputs.daily_prompt.enabled) return null;

  return CronJob.from({
    cronTime: config.inputs.daily_prompt.cron,
    onTick: async () => {
      const since = new Date();
      since.setHours(0, 0, 0, 0);
      const count = ctx.index.countDumpsSince(since.toISOString());
      if (count >= config.inputs.daily_prompt.skip_if_dumps_gte) return;

      for (const chatId of chatIds) {
        await send(chatId, "What did you learn today?");
      }
    },
    start: true,
    timeZone: config.vault.timezone,
  });
}

export function scheduleReindex(
  config: DendriteConfig,
  ctx: PipelineContext,
): CronJob | null {
  if (config.index.sync_mode !== "scheduled") return null;

  return CronJob.from({
    cronTime: config.index.reindex_cron,
    onTick: () => {
      const n = ctx.index.reindexVault(config.vault.path);
      console.log(`Reindexed ${n} notes`);
    },
    start: true,
    timeZone: config.vault.timezone,
  });
}

export function schedulePatternEngine(
  config: DendriteConfig,
  ctx: PipelineContext,
  notify: (text: string) => Promise<void>,
): CronJob | null {
  return CronJob.from({
    cronTime: config.pattern_engine.cron,
    onTick: async () => {
      const report = runPatternScan(ctx, config);
      if (report) await notify(report);
    },
    start: true,
    timeZone: config.vault.timezone,
  });
}
