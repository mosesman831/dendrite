import type { EventStore } from "./store.js";

const UNIT_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 7 * 86_400_000,
  y: 365 * 86_400_000,
};

/** "90d" | "12h" | "4w" | "1y" | "30m" → ms. "forever"/"never"/"" → null. */
export function parseDuration(v: string): number | null {
  const s = v.trim().toLowerCase();
  if (!s || s === "forever" || s === "never") return null;
  const m = s.match(/^(\d+(?:\.\d+)?)\s*([mhdwy])$/);
  if (!m) throw new Error(`invalid duration "${v}" (e.g. 90d, 12h, 4w, 1y, forever)`);
  return Number(m[1]) * UNIT_MS[m[2]];
}

export interface RetentionResult {
  stream: string;
  keep: string;
  before: string;
  deleted: number;
}

/** Apply per-stream retention. Key "*" is the default for unlisted streams. */
export function applyRetention(
  store: EventStore,
  policy: Record<string, string>,
  opts: { dryRun?: boolean; now?: Date } = {},
): RetentionResult[] {
  const now = (opts.now ?? new Date()).getTime();
  const out: RetentionResult[] = [];
  const streams = store.streams().map((s) => s.stream);
  for (const stream of streams) {
    const keep = policy[stream] ?? policy["*"];
    if (!keep) continue;
    const ms = parseDuration(keep);
    if (ms === null) continue;
    const before = new Date(now - ms).toISOString();
    const deleted = store.prune(stream, before, opts.dryRun);
    out.push({ stream, keep, before, deleted });
  }
  return out;
}
