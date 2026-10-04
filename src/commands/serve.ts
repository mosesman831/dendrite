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
import { embedPendingEvents, eventEmbeddingsConfig, providerEmbedFn } from "../events/semantic.js";
import { ingestOptionsFromConfig } from "../events/ingest.js";
import { briefOptionsFromConfig, buildBriefing, renderBriefing } from "../events/briefing.js";
import { computeInsights, renderInsights } from "../events/insights.js";
import { deriveLiveStays } from "../events/stays.js";
import { syncCalendar } from "../events/calendars.js";
import { dueFollowups, dueNudges, renderFollowup, renderPrep } from "../events/prep.js";
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

  const eventEmb = eventEmbeddingsConfig(config, llm.primary.baseURL);
  mountEventsApi(app, config, ctx.index, eventEmb);

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
    if (eventEmb && config.index.embeddings.events_cron) {
      let running = false;
      new CronJob(config.index.embeddings.events_cron, async () => {
        if (running) return;
        running = true;
        try {
          const r = await embedPendingEvents(ctx.index.events, {
            model: eventEmb.model,
            embed: providerEmbedFn(eventEmb),
            includeSensitive: config.index.embeddings.events_include_sensitive,
            max: 2000,
            log: (m) => console.warn(m),
          });
          if (r.embedded) console.log(`[embed-events] +${r.embedded} (${r.remaining} remaining)`);
        } finally {
          running = false;
        }
      }, null, true, config.vault.timezone);
      console.log(`  Event embeddings: ${eventEmb.model} (${config.index.embeddings.events_cron})`);
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

  const deliver = async (label: string, text: string) => {
    const token = process.env[config.inputs.telegram.tokenEnv];
    if (!token || !chatIds.length) {
      console.log(`[${label}]\n${text}`);
      return;
    }
    for (const chatId of chatIds)
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000) }),
      });
  };
  const schedule = (label: string, cron: string, render: (today: string) => string) =>
    new CronJob(
      cron,
      async () => {
        try {
          await deliver(label, render(localDate(new Date().toISOString(), config.vault.timezone)));
        } catch (e) {
          console.error(`[${label}] ${(e as Error).message}`);
        }
      },
      null,
      true,
      config.vault.timezone,
    );

  if (config.brief.cron) {
    schedule("brief", config.brief.cron, (today) => renderBriefing(buildBriefing(ctx.index.events, today, briefOptionsFromConfig(config))));
    console.log(`  Morning briefing: ${config.brief.cron}`);
  }
  if (config.insights?.cron) {
    schedule("insights", config.insights.cron, (today) =>
      renderInsights(
        computeInsights(ctx.index.events, {
          to: today,
          days: config.insights.days,
          timezone: config.vault.timezone,
          maxPrivacy: config.insights.include_sensitive ? "sensitive" : "normal",
        }),
      ),
    );
    console.log(`  Weekly review: ${config.insights.cron}`);
  }
  if (config.prep?.nudge_minutes) {
    const sent = new Set<string>();
    const minutes = config.prep.nudge_minutes;
    const tick = () => {
      try {
        for (const p of dueNudges(ctx.index.events, {
          minutes,
          sent,
          aliases: config.aliases,
          maxPrivacy: config.prep.include_sensitive ? "sensitive" : "normal",
        }))
          void deliver("prep", renderPrep(p, config.vault.timezone)).catch((e) => console.error(`[prep] ${(e as Error).message}`));
      } catch (e) {
        console.error(`[prep] ${(e as Error).message}`);
      }
    };
    tick();
    setInterval(tick, 60_000).unref();
    console.log(`  Meeting prep: ${minutes} min before each calendar entry`);
  }
  if (config.prep?.followup) {
    const sent = new Set<string>();
    const tick = () => {
      try {
        for (const f of dueFollowups(ctx.index.events, { minutes: 30, sent, maxPrivacy: config.prep.include_sensitive ? "sensitive" : "normal" }))
          void deliver("followup", renderFollowup(f)).catch((e) => console.error(`[followup] ${(e as Error).message}`));
      } catch (e) {
        console.error(`[followup] ${(e as Error).message}`);
      }
    };
    setInterval(tick, 60_000).unref();
    console.log("  Meeting follow-ups: on");
  }
  if (config.events.enabled && config.stays?.live) {
    const s = config.stays;
    const tick = () => {
      try {
        const r = deriveLiveStays(
          ctx.index.events,
          { from: new Date(Date.now() - s.lookback_hours * 3_600_000).toISOString(), places: config.places, radiusM: s.radius_m, minMinutes: s.min_minutes },
          ingestOptionsFromConfig(config),
        );
        if (r.created) console.log(`[stays] +${r.created}`);
      } catch (e) {
        console.error(`[stays] ${(e as Error).message}`);
      }
    };
    setInterval(tick, s.interval_min * 60_000).unref();
    console.log(`  Live stays: every ${s.interval_min} min`);
  }

  if (config.events.enabled) {
    for (const c of config.calendars ?? []) {
      const tick = () =>
        syncCalendar(ctx.index.events, c, ingestOptionsFromConfig(config))
          .then((r) => (r.ok ? (r.accepted || r.updated) && console.log(`[calendar:${r.name}] +${r.accepted} ~${r.updated}`) : console.error(`[calendar:${r.name}] ${r.error}`)))
          .catch(() => {});
      void tick();
      setInterval(tick, (c.interval_min ?? 30) * 60_000).unref();
      console.log(`  Calendar ${c.name}: every ${c.interval_min ?? 30} min`);
    }
  }

  console.log("Dendrite serve started");

  if (config.inputs.telegram.enabled) {
    await startTelegramBot(opts.config, ctx);
  } else {
    setInterval(() => drainQueue(ctx).catch(() => {}), 5000);
    await new Promise(() => {});
  }
}
