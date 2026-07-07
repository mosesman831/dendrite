import express from "express";
import type { Dump } from "../types.js";
import type { PipelineContext } from "../pipeline/pipeline.js";
import { enqueueAndProcess } from "../pipeline/pipeline.js";
import { hashId } from "../util/slug.js";
import type { DendriteConfig } from "../config.js";

export function createWebhookServer(
  config: DendriteConfig,
  ctx: PipelineContext,
): express.Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  const token = process.env[config.inputs.webhook.tokenEnv];

  app.post("/ingest", async (req, res) => {
    const auth = req.headers.authorization;
    if (token) {
      const expected = `Bearer ${token}`;
      if (auth !== expected) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }
    }

    const { text, source, id, meta } = req.body as {
      text?: string;
      source?: string;
      id?: string;
      meta?: Record<string, unknown>;
    };

    if (!text?.trim()) {
      res.status(400).json({ error: "text required" });
      return;
    }

    const dump: Dump = {
      id: id ?? `webhook-${hashId(text + Date.now())}`,
      source: "webhook",
      receivedAt: new Date().toISOString(),
      text,
      meta,
    };

    try {
      const results = await enqueueAndProcess(ctx, dump);
      res.json({ ok: true, results });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/health", (_req, res) => res.json({ ok: true }));

  return app;
}

export async function startWebhook(
  config: DendriteConfig,
  ctx: PipelineContext,
): Promise<void> {
  if (!config.inputs.webhook.enabled) return;
  const app = createWebhookServer(config, ctx);
  const port = config.inputs.webhook.port;
  app.listen(port, () => console.log(`Webhook listening on :${port}`));
}
