import express, { type Express, type Request, type Response } from "express";
import { statSync } from "node:fs";
import type { DendriteConfig } from "../config.js";
import type { DendriteIndex } from "../pipeline/index.js";
import { ingestEvents, ingestOptionsFromConfig, parseNdjson } from "../events/ingest.js";
import type { EventQuery, PrivacyLevel } from "../events/types.js";
import { normalizeTime, localDate } from "../events/time.js";
import { authorize, resolveApiKeys, type Scope } from "./http-security.js";
import { renderDigestMarkdown, summarizeDay, summarizeWeek } from "../events/timeline.js";

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

  const keys = resolveApiKeys(config);
  const guard = (req: Request, res: Response, scope: Scope = req.method === "GET" ? "read" : "write"): boolean => {
    if (!config.events.enabled) {
      res.status(404).json({ error: "events disabled" });
      return false;
    }
    const a = authorize(keys, req.headers.authorization, scope);
    if (!a.ok) {
      res.status(a.status ?? 401).json({ error: a.status === 403 ? `forbidden: needs ${scope} scope` : "unauthorized" });
      return false;
    }
    return true;
  };

  const started = Date.now();
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, service: "dendrite", uptime_s: Math.round((Date.now() - started) / 1000) });
  });
  app.get("/readyz", (_req, res) => {
    try {
      index.db.prepare("SELECT 1").get();
      res.json({ ok: true });
    } catch (e) {
      res.status(503).json({ ok: false, error: (e as Error).message });
    }
  });
  app.get("/v1/stats", (req, res) => {
    if (!guard(req, res)) return;
    let db_bytes: number | null = null;
    try {
      db_bytes = statSync(config.index.db_path).size;
    } catch {
      /* in-memory or missing */
    }
    res.json({ events: store.count(), streams: store.streams().length, db_bytes, auth: keys.length ? "keys" : "open" });
  });

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
    if (!guard(req, res, "admin")) return;
    res.json({ ok: store.delete(req.params.id) });
  });

  app.get("/v1/streams", (req, res) => {
    if (!guard(req, res)) return;
    res.json({ streams: store.streams(), total: store.count() });
  });

  const summary = (req: Request, res: Response) => {
    const date = str(req.query.date) ?? localDate(new Date().toISOString(), config.vault.timezone);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ error: "date must be YYYY-MM-DD" });
      return null;
    }
    const o = { timezone: config.vault.timezone, maxPrivacy };
    return str(req.query.period) === "week" ? summarizeWeek(store, date, o) : summarizeDay(store, date, o);
  };

  app.get("/v1/timeline", (req, res) => {
    if (!guard(req, res)) return;
    const s = summary(req, res);
    if (!s) return;
    const { event_ids: _ids, ...rest } = s;
    res.json(rest);
  });

  app.get("/v1/digest", (req, res) => {
    if (!guard(req, res)) return;
    const s = summary(req, res);
    if (!s) return;
    res.type("text/markdown").send(renderDigestMarkdown(s));
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
