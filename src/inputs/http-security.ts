import type { NextFunction, Request, Response, Express } from "express";
import { timingSafeEqual, randomUUID } from "node:crypto";
import type { DendriteConfig } from "../config.js";

export type Scope = "read" | "write" | "admin";

export interface ApiKey {
  name: string;
  token: string;
  scopes: Scope[];
}

function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Resolve configured keys from env. The legacy webhook token is a full-access key. */
export function resolveApiKeys(config: DendriteConfig, env: NodeJS.ProcessEnv = process.env): ApiKey[] {
  const keys: ApiKey[] = [];
  const legacy = env[config.inputs.webhook.tokenEnv];
  if (legacy) keys.push({ name: "webhook", token: legacy, scopes: ["read", "write", "admin"] });
  for (const k of config.http.api_keys) {
    const token = env[k.tokenEnv];
    if (token) keys.push({ name: k.name, token, scopes: k.scopes });
  }
  return keys;
}

export interface AuthResult {
  ok: boolean;
  status?: 401 | 403;
  key?: string;
}

/** Open mode (no keys configured) allows everything — warned at startup. */
export function authorize(keys: ApiKey[], header: string | undefined, scope: Scope): AuthResult {
  if (!keys.length) return { ok: true, key: "open" };
  const m = header?.match(/^Bearer\s+(.+)$/i);
  if (!m) return { ok: false, status: 401 };
  const key = keys.find((k) => safeEq(k.token, m[1].trim()));
  if (!key) return { ok: false, status: 401 };
  if (!key.scopes.includes(scope) && !key.scopes.includes("admin")) return { ok: false, status: 403, key: key.name };
  return { ok: true, key: key.name };
}

/** Fixed-window-per-minute limiter keyed by bearer token or IP. 0 disables. */
export class RateLimiter {
  private hits = new Map<string, { window: number; count: number }>();
  constructor(
    private perMin: number,
    private now: () => number = Date.now,
  ) {}

  check(id: string): { ok: boolean; remaining: number; retryAfter: number } {
    if (!this.perMin) return { ok: true, remaining: Infinity, retryAfter: 0 };
    const t = this.now();
    const window = Math.floor(t / 60_000);
    const cur = this.hits.get(id);
    const entry = cur && cur.window === window ? cur : { window, count: 0 };
    entry.count++;
    this.hits.set(id, entry);
    if (this.hits.size > 10_000) {
      for (const [k, v] of this.hits) if (v.window !== window) this.hits.delete(k);
    }
    const retryAfter = Math.ceil(((window + 1) * 60_000 - t) / 1000);
    return { ok: entry.count <= this.perMin, remaining: Math.max(0, this.perMin - entry.count), retryAfter };
  }
}

/** Security headers, request id, and rate limiting for all routes. */
export function applyHttpHardening(app: Express, config: DendriteConfig): void {
  app.disable("x-powered-by");
  const limiter = new RateLimiter(config.http.rate_limit_per_min);
  app.use((req: Request, res: Response, next: NextFunction) => {
    const rid = (typeof req.headers["x-request-id"] === "string" && req.headers["x-request-id"].slice(0, 64)) || randomUUID();
    res.setHeader("X-Request-Id", rid);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    if (req.path === "/healthz" || req.path === "/readyz") return next();
    const id = req.headers.authorization ? `t:${req.headers.authorization.slice(-16)}` : `ip:${req.ip}`;
    const r = limiter.check(id);
    if (Number.isFinite(r.remaining)) res.setHeader("X-RateLimit-Remaining", String(r.remaining));
    if (!r.ok) {
      res.setHeader("Retry-After", String(r.retryAfter));
      res.status(429).json({ error: "rate limited", retry_after: r.retryAfter });
      return;
    }
    next();
  });
}
