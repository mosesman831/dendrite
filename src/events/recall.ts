import { aliasMap } from "./aliases.js";
import type { EventStore } from "./store.js";
import type { EventRecord, PrivacyLevel } from "./types.js";
import { PRIVACY_LEVELS } from "./types.js";
import { privacyRank } from "./enrich.js";
import { localDate, localTime, normalizeTime } from "./time.js";
import { eventSummary } from "./timeline.js";

export interface RecallOptions {
  q?: string;
  entity?: string;
  /** Center time: returns everything within ±windowMin. */
  at?: string;
  windowMin?: number;
  from?: string;
  to?: string;
  stream?: string | string[];
  limit?: number;
  /** For q/entity hits: neighbouring events (any stream) within ±contextMin. */
  contextMin?: number;
  maxPrivacy?: PrivacyLevel;
  timezone?: string;
  /** Query embedding: blends cosine matches with FTS hits (hybrid recall). */
  vector?: number[];
  semanticModel?: string;
  /** 0 = FTS only, 1 = vectors only (default 0.5). */
  semanticWeight?: number;
}

export interface RecallHit {
  event: EventRecord;
  context: EventRecord[];
}

export interface RecallPack {
  mode: "around" | "search";
  query: Record<string, unknown>;
  range: { from: string | null; to: string | null };
  hits: RecallHit[];
  entities: Array<{ entity: string; count: number }>;
  total_hits: number;
  markdown: string;
}

const MIN = 60_000;

function shift(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

function line(e: EventRecord, tz: string): string {
  return `- ${localDate(e.occurred_at, tz)} ${localTime(e.occurred_at, tz)} [${e.stream}/${e.kind}] ${eventSummary(e, 240)}`;
}

/**
 * Build an agent-ready context pack: either "what happened around time T", or
 * "find events matching q/entity, each with its surrounding moment".
 */
export function recall(store: EventStore, o: RecallOptions): RecallPack {
  const tz = o.timezone ?? "UTC";
  const maxPrivacy = o.maxPrivacy ?? "sensitive";
  const limit = Math.min(Math.max(o.limit ?? 20, 1), 200);
  let hits: RecallHit[];
  let mode: RecallPack["mode"];
  let from = o.from ? normalizeTime(o.from) : null;
  let to = o.to ? normalizeTime(o.to) : null;

  if (o.at) {
    mode = "around";
    const at = normalizeTime(o.at);
    if (!at) throw new Error(`unparseable time: ${o.at}`);
    const w = (o.windowMin ?? 60) * MIN;
    from = shift(at, -w);
    to = shift(at, w);
    const page = store.query({
      from,
      to,
      stream: o.stream,
      q: o.q,
      entity: o.entity,
      maxPrivacy,
      limit,
      order: "asc",
    });
    hits = page.events.map((event) => ({ event, context: [] }));
  } else {
    mode = "search";
    if (!o.q && !o.entity) throw new Error("recall needs q, entity, or at");
    const page = store.query({
      q: o.q,
      entity: o.entity,
      from: from ?? undefined,
      to: to ?? undefined,
      stream: o.stream,
      maxPrivacy,
      limit: Math.min(limit * 5, 500),
    });
    let ranked: EventRecord[];
    if (o.vector && o.semanticModel && o.q) {
      const w = o.semanticWeight ?? 0.5;
      const sem = store.semanticSearch(o.vector, {
        model: o.semanticModel,
        from: from ?? undefined,
        to: to ?? undefined,
        stream: o.stream,
        maxPrivacy,
        limit: limit * 3,
      });
      const want = o.entity?.toLowerCase();
      const pool = new Map<string, { event: EventRecord; fts: number; cos: number }>();
      for (const e of page.events) pool.set(e.id, { event: e, fts: 1, cos: 0 });
      for (const { event, score } of sem) {
        if (want && !event.entities.some((x) => x.toLowerCase() === want)) continue;
        const cur = pool.get(event.id);
        if (cur) cur.cos = score;
        else pool.set(event.id, { event, fts: 0, cos: score });
      }
      ranked = [...pool.values()]
        .map((x) => ({ e: x.event, s: w * x.cos + (1 - w) * x.fts + 0.05 * x.event.importance }))
        .sort((a, b) => b.s - a.s || b.e.occurred_at.localeCompare(a.e.occurred_at))
        .slice(0, limit)
        .map((x) => x.e);
    } else {
      ranked = [...page.events]
        .sort((a, b) => b.importance - a.importance || b.occurred_at.localeCompare(a.occurred_at))
        .slice(0, limit);
    }
    const cm = (o.contextMin ?? 30) * MIN;
    hits = ranked
      .map((event) => ({
        event,
        context: cm
          ? store
              .query({
                from: shift(event.occurred_at, -cm),
                to: shift(event.occurred_at, cm + 1),
                maxPrivacy,
                limit: 6,
                order: "asc",
              })
              .events.filter((c) => c.id !== event.id)
              .slice(0, 5)
          : [],
      }))
      .sort((a, b) => b.event.occurred_at.localeCompare(a.event.occurred_at));
  }

  const counts = new Map<string, number>();
  for (const h of hits)
    for (const e of [h.event, ...h.context]) for (const en of e.entities) counts.set(en, (counts.get(en) ?? 0) + 1);
  const entities = [...counts]
    .map(([entity, count]) => ({ entity, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);

  const head =
    mode === "around"
      ? `## Around ${o.at} (±${o.windowMin ?? 60} min)`
      : `## Recall: ${[o.q && `"${o.q}"`, o.entity && `entity ${o.entity}`].filter(Boolean).join(", ")}`;
  const body: string[] = [head, ""];
  if (!hits.length) body.push("_No matching events._");
  for (const h of hits) {
    body.push(line(h.event, tz));
    for (const c of h.context) body.push(`  ${line(c, tz)}`);
  }
  if (entities.length) body.push("", `People/places/things: ${entities.map((e) => `${e.entity} (${e.count})`).join(", ")}`);

  return {
    mode,
    query: { q: o.q, entity: o.entity, at: o.at, stream: o.stream, semantic: Boolean(o.vector && o.semanticModel && o.q && !o.at) },
    range: { from, to },
    hits,
    entities,
    total_hits: hits.length,
    markdown: body.join("\n"),
  };
}

export interface EntityProfile {
  entity: string;
  count: number;
  first_at: string | null;
  last_at: string | null;
  streams: Array<{ stream: string; count: number }>;
  related: Array<{ entity: string; count: number }>;
  recent: EventRecord[];
  open_loops: Array<{ id: string; text: string; due_date: string | null }>;
}

/** Everything known about a person/place/thing: activity span, streams, co-mentions, recent events. */
export function entityProfile(
  store: EventStore,
  name: string,
  o: { maxPrivacy?: PrivacyLevel; recent?: number; aliases?: Record<string, string[]> } = {},
): EntityProfile {
  name = resolveEntity(store, name, o.aliases);
  const allowed = PRIVACY_LEVELS.filter((p) => privacyRank(p) <= privacyRank(o.maxPrivacy ?? "sensitive"));
  const ph = allowed.map(() => "?").join(",");
  const db = store.db;
  const base = `FROM event_entities ee JOIN events e ON e.id = ee.event_id WHERE ee.entity = ? AND e.privacy IN (${ph})`;
  const agg = db
    .prepare(`SELECT COUNT(*) AS count, MIN(e.occurred_at) AS first_at, MAX(e.occurred_at) AS last_at ${base}`)
    .get(name, ...allowed) as { count: number; first_at: string | null; last_at: string | null };
  const streams = db
    .prepare(`SELECT e.stream AS stream, COUNT(*) AS count ${base} GROUP BY e.stream ORDER BY count DESC`)
    .all(name, ...allowed) as Array<{ stream: string; count: number }>;
  const related = db
    .prepare(
      `SELECT o.entity AS entity, COUNT(*) AS count ${base.replace(
        "FROM event_entities ee",
        "FROM event_entities ee JOIN event_entities o ON o.event_id = ee.event_id AND o.entity <> ee.entity",
      )} GROUP BY o.entity COLLATE NOCASE ORDER BY count DESC LIMIT 15`,
    )
    .all(name, ...allowed) as Array<{ entity: string; count: number }>;
  const recent = store.query({ entity: name, maxPrivacy: o.maxPrivacy ?? "sensitive", limit: o.recent ?? 10 }).events;
  const loopLv = (o.maxPrivacy ?? "sensitive") === "normal" ? ["normal"] : ["normal", "sensitive"];
  const open_loops = db
    .prepare(
      `SELECT DISTINCT l.id AS id, l.text AS text, l.due_date AS due_date FROM open_loops l
       LEFT JOIN event_entities ee ON ee.event_id = l.event_id AND ee.entity = ?
       WHERE (ee.entity IS NOT NULL OR instr(lower(l.text), lower(?)) > 0)
         AND (l.status = 'open' OR (l.status = 'snoozed' AND l.snooze_until <= ?))
         AND l.privacy IN (${loopLv.map(() => "?").join(",")})
       ORDER BY CASE WHEN l.due_date IS NULL THEN 1 ELSE 0 END, l.due_date LIMIT 20`,
    )
    .all(name, name, new Date().toISOString(), ...loopLv) as EntityProfile["open_loops"];
  return { entity: name, ...agg, streams, related, recent, open_loops };
}

/** Alias → canonical, else the stored spelling of a case-insensitive match, else the input. */
export function resolveEntity(store: EventStore, name: string, aliases?: Record<string, string[]>): string {
  const canon = aliasMap(aliases).get(name.trim().toLowerCase());
  if (canon) return canon;
  if (store.db.prepare(`SELECT 1 FROM event_entities WHERE entity = ? LIMIT 1`).get(name)) return name;
  const hit = store.db
    .prepare(`SELECT entity, COUNT(*) AS n FROM event_entities WHERE lower(entity) = lower(?) GROUP BY entity ORDER BY n DESC LIMIT 1`)
    .get(name) as { entity: string } | undefined;
  return hit?.entity ?? name;
}
