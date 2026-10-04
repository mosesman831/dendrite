import express, { type Express, type Request, type Response } from "express";
import type { DendriteConfig } from "../config.js";
import type { DendriteIndex } from "../pipeline/index.js";
import { ingestEvents, ingestOptionsFromConfig, parseNdjson } from "../events/ingest.js";
import type { EventQuery, PrivacyLevel } from "../events/types.js";
import { normalizeTime } from "../events/time.js";

export function bearerOk(config: DendriteConfig, req: Request): boolean {
  const token = process.env[config.inputs.webhook.tokenEnv];
  if (!token) return true;
  return req.headers.authorization === `Bearer ${token}`;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length ? v : undefined;
}

export function parseEventQuery(q: Record<string, unknown>): EventQuery | { error: string } {
  const out: EventQuery = {};
  for (const key of ["from", "to"] as const) {
    const v = str(q[key]);
    if (v) {
      const t = normalizeTime(v);
      if (!t) return { error: `${key}: unparseable timestamp` };
      out[key] = t;
    }
  }
  const stream = str(q.stream);
  if (stream) out.stream = stream.includes(",") ? stream.split(",") : stream;
  out.kind = str(q.kind);
  out.source = str(q.source);
  out.entity = str(q.entity);
  out.q = str(q.q);
  out.cursor = str(q.cursor);
  const limit = str(q.limit);
  if (limit) out.limit = Number(limit);
  const minImp = str(q.min_importance);
  if (minImp) out.minImportance = Number(minImp);
  if (str(q.order) === "asc") out.order = "asc";
  return out;
}

/** Mount /v1 life-event endpoints on an Express app. */
export function mountEventsApi(app: Express, config: DendriteConfig, index: DendriteIndex): void {
  const store = index.events;
  const opts = ingestOptionsFromConfig(config);
  const maxPrivacy: PrivacyLevel = "sensitive";

  const guard = (req: Request, res: Response): boolean => {
    if (!config.events.enabled) {
      res.status(404).json({ error: "events disabled" });
      return false;
    }
    if (!bearerOk(config, req)) {
      res.status(401).json({ error: "unauthorized" });
      return false;
    }
    return true;
  };

  app.post("/v1/events", express.json({ limit: config.http.max_body }), (req, res) => {
    if (!guard(req, res)) return;
    const body = req.body as unknown;
    const raws = Array.isArray(body)
      ? body
      : body && typeof body === "object" && Array.isArray((body as { events?: unknown[] }).events)
        ? (body as { events: unknown[] }).events
        : [body];
    const report = ingestEvents(store, raws, opts);
    const status = report.rejected.length && !report.accepted && !report.duplicates ? 400 : 200;
    res.status(status).json({ ok: status === 200, ...report });
  });

  app.post(
    "/v1/events/ndjson",
    express.text({ type: () => true, limit: config.http.max_body }),
    (req, res) => {
      if (!guard(req, res)) return;
      const { items, errors, lineIndex } = parseNdjson(typeof req.body === "string" ? req.body : "");
      const report = ingestEvents(store, items, { ...opts, maxBatch: Math.max(opts.maxBatch, items.length) });
      report.rejected = [
        ...errors,
        ...report.rejected.map((r) => ({ index: lineIndex[r.index] ?? r.index, error: r.error })),
      ].sort((a, b) => a.index - b.index);
      res.json({ ok: true, ...report });
    },
  );

  app.get("/v1/events", (req, res) => {
    if (!guard(req, res)) return;
    const q = parseEventQuery(req.query as Record<string, unknown>);
    if ("error" in q) {
      res.status(400).json(q);
      return;
    }
    res.json(store.query({ ...q, maxPrivacy }));
  });

  app.get("/v1/events/:id", (req, res) => {
    if (!guard(req, res)) return;
    const e = store.get(req.params.id);
    if (!e || e.privacy === "secret") {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(e);
  });

  app.delete("/v1/events/:id", (req, res) => {
    if (!guard(req, res)) return;
    res.json({ ok: store.delete(req.params.id) });
  });

  app.get("/v1/streams", (req, res) => {
    if (!guard(req, res)) return;
    res.json({ streams: store.streams(), total: store.count() });
  });

  app.get("/v1/entities", (req, res) => {
    if (!guard(req, res)) return;
    const q = parseEventQuery(req.query as Record<string, unknown>);
    if ("error" in q) {
      res.status(400).json(q);
      return;
    }
    res.json({ entities: store.topEntities({ from: q.from, to: q.to, limit: q.limit ?? 50 }) });
  });
}
