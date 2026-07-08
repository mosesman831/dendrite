import { loadConfig, loadCompartments } from "../config.js";
import { createPipelineContext, drainQueue } from "../pipeline/pipeline.js";
import { createExpressApp, mountWebhookRoute } from "../inputs/webhook.js";
import { mountDashboard } from "../inputs/dashboard.js";
import { startTelegramBot, runQueueWorker } from "../inputs/telegram.js";
import {
  scheduleDailyPrompt,
  scheduleReindex,
  schedulePatternEngine,
} from "../inputs/daily.js";

export async function runServe(opts: { config?: string }): Promise<void> {
  const { config, configDir, llm } = loadConfig(opts.config);
  const ctx = createPipelineContext(config, configDir, llm);
  const compartments = loadCompartments(config, configDir);

  // Always create Express app — webhook + dashboard share it
  const app = createExpressApp(config, ctx);

  // Mount webhook route if enabled
  if (config.inputs.webhook.enabled) {
    mountWebhookRoute(app, config, ctx);
    app.get("/health", (_req, res) => res.json({ ok: true }));
  }

  // Mount dashboard routes (always available)
  mountDashboard(app, ctx, compartments, config);

  // Start listening
  const port = config.inputs.webhook.enabled
    ? config.inputs.webhook.port
    : (config.dashboard?.port ?? 8788);
  app.listen(port, () => {
    console.log(`Dendrite HTTP listening on :${port}`);
    if (config.inputs.webhook.enabled) {
      console.log(`  Webhook: POST /ingest`);
    }
    console.log(`  Dashboard: http://localhost:${port}/dashboard`);
  });

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
