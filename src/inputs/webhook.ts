import express, { type Express } from "express";
import type { Dump } from "../types.js";
import type { PipelineContext } from "../pipeline/pipeline.js";
import { enqueueAndProcess } from "../pipeline/pipeline.js";
import { hashId } from "../util/slug.js";
import type { DendriteConfig } from "../config.js";

/** Create the canonical Express app for Dendrite's HTTP surface. */
export function createExpressApp(
  config: DendriteConfig,
  ctx: PipelineContext,
): Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  return app;
}

/** Mount the webhook POST /ingest route on an existing Express app. */
export function mountWebhookRoute(
  app: Express,
  config: DendriteConfig,
  ctx: PipelineContext,
): void {
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

    const { text, source, id, meta, url, title } = req.body as {
      text?: string;
      source?: string;
      id?: string;
      meta?: Record<string, unknown>;
      url?: string;
      title?: string;
    };

    if (!text?.trim()) {
      res.status(400).json({ error: "text required" });
      return;
    }

    const resources: string[] = [];
    const pageUrl = url?.trim();
    const pageTitle = title?.trim();
    if (pageUrl) resources.push(pageUrl);
    if (pageTitle && pageTitle !== pageUrl) resources.push(pageTitle);

    const dumpMeta: Record<string, unknown> = { ...(meta ?? {}) };
    if (pageUrl) dumpMeta.url = pageUrl;
    if (pageTitle) dumpMeta.title = pageTitle;
    if (resources.length > 0) {
      const prior =
        dumpMeta.extracted && typeof dumpMeta.extracted === "object"
          ? (dumpMeta.extracted as Record<string, unknown>)
          : {};
      const priorResources = Array.isArray(prior.resources)
        ? prior.resources.map(String)
        : [];
      dumpMeta.extracted = {
        ...prior,
        resources: [...new Set([...priorResources, ...resources])],
      };
    }

    let captureText = text.trim();
    if (pageUrl) {
      const sourceLines = pageTitle ? [`Page: ${pageTitle}`, pageUrl] : [pageUrl];
      captureText = `${captureText}\n\n${sourceLines.join("\n")}`;
    }

    const dump: Dump = {
      id: id ?? `webhook-${hashId(captureText + Date.now())}`,
      source: "webhook",
      receivedAt: new Date().toISOString(),
      text: captureText,
      meta: Object.keys(dumpMeta).length > 0 ? dumpMeta : undefined,
    };

    try {
      const results = await enqueueAndProcess(ctx, dump);
      res.json({ ok: true, results });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });
}

/** @deprecated Use createExpressApp() + mountWebhookRoute() instead. */
export function createWebhookServer(
  config: DendriteConfig,
  ctx: PipelineContext,
): Express {
  const app = createExpressApp(config, ctx);
  mountWebhookRoute(app, config, ctx);
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
