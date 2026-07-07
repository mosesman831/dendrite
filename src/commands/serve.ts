import { loadConfig } from "../config.js";
import { createPipelineContext, drainQueue } from "../pipeline/pipeline.js";
import { startWebhook } from "../inputs/webhook.js";
import { startTelegramBot, runQueueWorker } from "../inputs/telegram.js";
import {
  scheduleDailyPrompt,
  scheduleReindex,
  schedulePatternEngine,
} from "../inputs/daily.js";

export async function runServe(opts: { config?: string }): Promise<void> {
  const { config, configDir, llm } = loadConfig(opts.config);
  const ctx = createPipelineContext(config, configDir, llm);

  await startWebhook(config, ctx);
  runQueueWorker(ctx);

  const chatIds = config.inputs.telegram.allowed_user_ids;

  if (config.inputs.daily_prompt.enabled && chatIds.length > 0) {
    scheduleDailyPrompt(config, ctx, async (chatId, text) => {
      const token = process.env[config.inputs.telegram.tokenEnv];
      if (!token) return;
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
    }, chatIds);
  }

  scheduleReindex(config, ctx);

  if (chatIds.length > 0) {
    schedulePatternEngine(config, ctx, async (text) => {
      const token = process.env[config.inputs.telegram.tokenEnv];
      if (!token) return;
      for (const chatId of chatIds) {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
        });
      }
    });
  }

  console.log("Dendrite serve started");

  if (config.inputs.telegram.enabled) {
    await startTelegramBot(opts.config, ctx);
  } else {
    setInterval(() => drainQueue(ctx).catch(() => {}), 5000);
    await new Promise(() => {});
  }
}
