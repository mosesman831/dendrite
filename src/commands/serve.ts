import { loadConfig, loadCompartments } from "../config.js";
import { createPipelineContext, drainQueue } from "../pipeline/pipeline.js";
import { createExpressApp, mountWebhookRoute } from "../inputs/webhook.js";
import { mountDashboard } from "../inputs/dashboard.js";
import { mountEventsApi } from "../inputs/events-api.js";
import { startDropFolder } from "../inputs/drop-folder.js";
import { resolveApiKeys } from "../inputs/http-security.js";
import { applyRetention } from "../events/retention.js";
import { writeDigest } from "./timeline.js";
import { createChatProvider } from "../providers/llm.js";
import { addDays, localDate } from "../events/time.js";
import { CronJob } from "cron";
import { compileTriggers, startTriggers } from "../events/triggers.js";
import { ingestOptionsFromConfig } from "../events/ingest.js";
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

  mountEventsApi(app, config, ctx.index);

  // Mount dashboard routes (always available)
  mountDashboard(app, ctx, compartments, config);

  // Start listening
  const port = config.inputs.webhook.enabled
    ? config.inputs.webhook.port
    : (config.dashboard?.port ?? 8788);
  app.listen(port, () => {
    console.log(`Dendrite HTTP listening on :${port}`);
    if (config.inputs.drop_folder.enabled) startDropFolder(config, ctx.index);
    if (!resolveApiKeys(config).length) {
      console.warn("  ⚠ No API keys or webhook token set — /v1 API is OPEN. Set DENDRITE_WEBHOOK_TOKEN or http.api_keys.");
    }
    const triggers = compileTriggers(config.triggers);
    if (triggers.length) {
      startTriggers(ctx.index.events, triggers, ingestOptionsFromConfig(config), { log: (m) => console.warn(m) });
      console.log(`  Triggers: ${triggers.map((t) => t.cfg.name).join(", ")}`);
    }
    if (config.digest.cron) {
      const chat = config.digest.narrate ? createChatProvider(llm) : undefined;
      new CronJob(
        config.digest.cron,
        async () => {
          try {
            const tz = config.vault.timezone;
            const y = addDays(localDate(new Date().toISOString(), tz), -1);
            await writeDigest(ctx.index, config, y, { narrate: config.digest.narrate, chat, log: (m) => console.log(`[digest] ${m}`) });
          } catch (e) {
            console.error(`[digest] ${(e as Error).message}`);
          }
        },
        null,
        true,
        config.vault.timezone,
      );
      console.log(`  Daily digest: ${config.digest.cron}${config.digest.narrate ? " (narrated)" : ""}`);
    }
    if (Object.keys(config.retention.streams).length) {
      new CronJob(config.retention.prune_cron, () => {
        try {
          for (const r of applyRetention(ctx.index.events, config.retention.streams)) {
            if (r.deleted) console.log(`[retention] ${r.stream}: pruned ${r.deleted} (keep ${r.keep})`);
          }
        } catch (e) {
          console.error(`[retention] ${(e as Error).message}`);
        }
      }, null, true, config.vault.timezone);
      console.log(`  Retention: ${Object.entries(config.retention.streams).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    }
    if (config.inputs.webhook.enabled) {
      console.log(`  Webhook: POST /ingest`);
    }
    console.log(`  Events:  POST /v1/events · GET /v1/events · GET /v1/streams`);
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
