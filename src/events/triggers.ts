import { createHmac, randomUUID } from "node:crypto";
import type { DendriteConfig } from "../config.js";
import type { EventStore } from "./store.js";
import type { EventRecord } from "./types.js";
import { ingestEvents, type IngestOptions } from "./ingest.js";

export type TriggerConfig = DendriteConfig["triggers"][number];

export interface CompiledTrigger {
  cfg: TriggerConfig;
  re?: RegExp;
  lastFired: number;
}

export const TRIGGER_SOURCE_PREFIX = "trigger:";

export function compileTriggers(list: TriggerConfig[]): CompiledTrigger[] {
  return list
    .filter((t) => t.enabled)
    .map((cfg) => {
      if (!cfg.webhook && !cfg.record) throw new Error(`trigger ${cfg.name}: needs a webhook or record action`);
      let re: RegExp | undefined;
      if (cfg.match.text) {
        try {
          re = new RegExp(cfg.match.text, "i");
        } catch (e) {
          throw new Error(`trigger ${cfg.name}: bad text regex: ${(e as Error).message}`);
        }
      }
      return { cfg, re, lastFired: 0 };
    });
}

const lc = (xs?: string[]) => xs?.map((x) => x.toLowerCase());

/** Pure match: privacy gate, loop guard, then every configured predicate must hold. */
export function matchTrigger(t: CompiledTrigger, e: EventRecord): boolean {
  const m = t.cfg.match;
  if (e.privacy === "secret") return false;
  if (e.privacy === "sensitive" && !t.cfg.include_sensitive) return false;
  if (e.source.startsWith(TRIGGER_SOURCE_PREFIX)) return false;
  if (m.stream && !lc(m.stream)!.includes(e.stream.toLowerCase())) return false;
  if (m.kind && !lc(m.kind)!.includes(e.kind.toLowerCase())) return false;
  if (m.source && !lc(m.source)!.includes(e.source.toLowerCase())) return false;
  if (m.entity) {
    const want = lc(m.entity)!;
    if (!e.entities.some((x) => want.includes(x.toLowerCase()))) return false;
  }
  if (m.min_importance !== undefined && e.importance < m.min_importance) return false;
  if (t.re && !t.re.test(e.text ?? "")) return false;
  return true;
}

export function renderTemplate(tpl: string, e: EventRecord): string {
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => {
    const v = (e as unknown as Record<string, unknown>)[k];
    if (v === null || v === undefined) return "";
    return Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v);
  });
}

export function signBody(body: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

export interface DeliveryResult {
  ok: boolean;
  status?: number;
  attempts: number;
  error?: string;
}

export async function deliverWebhook(
  t: TriggerConfig,
  e: EventRecord,
  opts: { fetchImpl?: typeof fetch; backoffMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<DeliveryResult> {
  const w = t.webhook!;
  const f = opts.fetchImpl ?? fetch;
  const delivery = randomUUID();
  const body = JSON.stringify({ trigger: t.name, delivery, event: e });
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "dendrite-triggers",
    "X-Dendrite-Trigger": t.name,
    "X-Dendrite-Delivery": delivery,
  };
  const secret = w.secret_env ? (opts.env ?? process.env)[w.secret_env] : undefined;
  if (secret) headers["X-Dendrite-Signature"] = signBody(body, secret);
  const backoff = opts.backoffMs ?? 1000;
  let last: DeliveryResult = { ok: false, attempts: 0 };
  for (let attempt = 1; attempt <= w.retries + 1; attempt++) {
    try {
      const res = await f(w.url, { method: "POST", headers, body, signal: AbortSignal.timeout(w.timeout_ms) });
      last = { ok: res.ok, status: res.status, attempts: attempt };
      // 4xx (except 408/429) is the receiver rejecting us — retrying won't help.
      if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429)) return last;
    } catch (err) {
      last = { ok: false, attempts: attempt, error: (err as Error).message };
    }
    if (attempt <= w.retries) await new Promise((r) => setTimeout(r, backoff * 4 ** (attempt - 1)));
  }
  return last;
}

export interface TriggerFire {
  trigger: string;
  event: string;
  action: "webhook" | "record";
  result: DeliveryResult | { recorded: number };
}

/** Subscribes to the store's bus; fires actions asynchronously so ingestion never waits on the network. */
export function startTriggers(
  store: EventStore,
  triggers: CompiledTrigger[],
  ingestOpts: IngestOptions,
  opts: { log?: (m: string) => void; onFire?: (f: TriggerFire) => void; fetchImpl?: typeof fetch; backoffMs?: number; now?: () => number } = {},
): () => void {
  const log = opts.log ?? (() => {});
  const now = opts.now ?? Date.now;
  return store.bus.subscribe((e) => {
    for (const t of triggers) {
      if (!matchTrigger(t, e)) continue;
      const ts = now();
      if (t.cfg.cooldown_sec && ts - t.lastFired < t.cfg.cooldown_sec * 1000) continue;
      t.lastFired = ts;
      if (t.cfg.record) {
        const r = t.cfg.record;
        // Defer so we never re-enter ingestEvents while the bus is publishing.
        queueMicrotask(() => {
          const rep = ingestEvents(
            store,
            [
              {
                stream: r.stream,
                kind: r.kind,
                source: TRIGGER_SOURCE_PREFIX + t.cfg.name,
                occurred_at: e.occurred_at,
                text: renderTemplate(r.text, e),
                tags: r.tags,
                entities: e.entities,
                data: { trigger: t.cfg.name, cause: e.id },
                privacy: e.privacy,
              },
            ],
            ingestOpts,
          );
          opts.onFire?.({ trigger: t.cfg.name, event: e.id, action: "record", result: { recorded: rep.accepted } });
        });
      }
      if (t.cfg.webhook) {
        void deliverWebhook(t.cfg, e, { fetchImpl: opts.fetchImpl, backoffMs: opts.backoffMs }).then((res) => {
          if (!res.ok) log(`[trigger] ${t.cfg.name} → ${t.cfg.webhook!.url} failed after ${res.attempts}: ${res.error ?? res.status}`);
          opts.onFire?.({ trigger: t.cfg.name, event: e.id, action: "webhook", result: res });
        });
      }
    }
  });
}
