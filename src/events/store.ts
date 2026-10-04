import { EventBus } from "./bus.js";
import type Database from "better-sqlite3";
import type {
  EventPage,
  EventQuery,
  EventRecord,
  PrivacyLevel,
  StreamSummary,
} from "./types.js";
import { privacyRank } from "./enrich.js";

const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS events (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  stream TEXT NOT NULL,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  ended_at TEXT,
  received_at TEXT NOT NULL,
  external_id TEXT,
  content_hash TEXT NOT NULL UNIQUE,
  text TEXT,
  data TEXT,
  entities TEXT NOT NULL DEFAULT '[]',
  tags TEXT NOT NULL DEFAULT '[]',
  lat REAL,
  lon REAL,
  importance REAL NOT NULL DEFAULT 0.5,
  privacy TEXT NOT NULL DEFAULT 'normal',
  distilled_at TEXT,
  note_path TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS events_source_ext ON events(source, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_occurred ON events(occurred_at, id);
CREATE INDEX IF NOT EXISTS events_stream_occurred ON events(stream, occurred_at);
CREATE TABLE IF NOT EXISTS event_entities (
  event_id TEXT NOT NULL,
  entity TEXT NOT NULL COLLATE NOCASE,
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (event_id, entity)
);
CREATE INDEX IF NOT EXISTS event_entities_entity ON event_entities(entity, occurred_at);
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
  text, entities, tags, stream, kind,
  content='events', content_rowid='rowid', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
  INSERT INTO events_fts(rowid, text, entities, tags, stream, kind)
  VALUES (new.rowid, new.text, new.entities, new.tags, new.stream, new.kind);
END;
CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, text, entities, tags, stream, kind)
  VALUES ('delete', old.rowid, old.text, old.entities, old.tags, old.stream, old.kind);
  DELETE FROM event_entities WHERE event_id = old.id;
END;
CREATE TRIGGER IF NOT EXISTS events_au AFTER UPDATE OF text, entities, tags ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, text, entities, tags, stream, kind)
  VALUES ('delete', old.rowid, old.text, old.entities, old.tags, old.stream, old.kind);
  INSERT INTO events_fts(rowid, text, entities, tags, stream, kind)
  VALUES (new.rowid, new.text, new.entities, new.tags, new.stream, new.kind);
END;
CREATE TABLE IF NOT EXISTS checkpoints (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
  },
];

export function migrate(db: Database.Database): number {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    component TEXT PRIMARY KEY, version INTEGER NOT NULL, updated_at TEXT NOT NULL)`);
  const row = db.prepare(`SELECT version FROM schema_version WHERE component = 'events'`).get() as
    | { version: number }
    | undefined;
  let current = row?.version ?? 0;
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare(
        `INSERT INTO schema_version(component, version, updated_at) VALUES ('events', ?, ?)
         ON CONFLICT(component) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at`,
      ).run(m.version, new Date().toISOString());
    })();
    current = m.version;
  }
  return current;
}

interface EventRow {
  id: string;
  stream: string;
  source: string;
  kind: string;
  occurred_at: string;
  ended_at: string | null;
  received_at: string;
  external_id: string | null;
  content_hash: string;
  text: string | null;
  data: string | null;
  entities: string;
  tags: string;
  lat: number | null;
  lon: number | null;
  importance: number;
  privacy: PrivacyLevel;
  distilled_at: string | null;
  note_path: string | null;
}

function parseJson<T>(s: string | null, fallback: T): T {
  if (s === null || s === undefined) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

function rowToRecord(r: EventRow): EventRecord {
  return {
    ...r,
    data: parseJson(r.data, null),
    entities: parseJson<string[]>(r.entities, []),
    tags: parseJson<string[]>(r.tags, []),
  };
}

export function encodeCursor(occurredAt: string, id: string): string {
  return Buffer.from(`${occurredAt}|${id}`).toString("base64url");
}

export function decodeCursor(cursor: string): { occurred_at: string; id: string } | null {
  try {
    const [occurred_at, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
    if (!occurred_at || !id) return null;
    return { occurred_at, id };
  } catch {
    return null;
  }
}

/** Escape free text into a safe FTS5 query (prefix-matched OR of terms). */
const FTS_OPERATORS = new Set(["or", "and", "not", "near"]);

export function toFtsQuery(q: string): string | null {
  const terms = q
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length >= 2 && !FTS_OPERATORS.has(t))
    .slice(0, 16);
  if (!terms.length) return null;
  return terms.map((t) => `"${t}"*`).join(" OR ");
}

export class EventStore {
  readonly db: Database.Database;
  readonly bus = new EventBus();

  constructor(db: Database.Database) {
    this.db = db;
    migrate(db);
  }

  insert(e: Omit<EventRecord, "distilled_at" | "note_path">): "inserted" | "duplicate" {
    const existing = this.db
      .prepare(
        `SELECT id FROM events WHERE content_hash = ?
         OR (external_id IS NOT NULL AND source = ? AND external_id = ?) LIMIT 1`,
      )
      .get(e.content_hash, e.source, e.external_id);
    if (existing) return "duplicate";
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO events (id, stream, source, kind, occurred_at, ended_at, received_at, external_id,
             content_hash, text, data, entities, tags, lat, lon, importance, privacy)
           VALUES (@id, @stream, @source, @kind, @occurred_at, @ended_at, @received_at, @external_id,
             @content_hash, @text, @data, @entities, @tags, @lat, @lon, @importance, @privacy)`,
        )
        .run({
          ...e,
          data: e.data === undefined || e.data === null ? null : JSON.stringify(e.data),
          entities: JSON.stringify(e.entities),
          tags: JSON.stringify(e.tags),
        });
      const ins = this.db.prepare(
        `INSERT OR IGNORE INTO event_entities(event_id, entity, occurred_at) VALUES (?, ?, ?)`,
      );
      for (const ent of e.entities) ins.run(e.id, ent, e.occurred_at);
    });
    tx();
    return "inserted";
  }

  get(id: string): EventRecord | null {
    const r = this.db.prepare(`SELECT * FROM events WHERE id = ?`).get(id) as EventRow | undefined;
    return r ? rowToRecord(r) : null;
  }

  delete(id: string): boolean {
    return this.db.prepare(`DELETE FROM events WHERE id = ?`).run(id).changes > 0;
  }

  query(q: EventQuery = {}): EventPage {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    const order = q.order === "asc" ? "ASC" : "DESC";
    if (q.from) {
      where.push(`e.occurred_at >= @from`);
      params.from = q.from;
    }
    if (q.to) {
      where.push(`e.occurred_at < @to`);
      params.to = q.to;
    }
    if (q.stream) {
      const streams = Array.isArray(q.stream) ? q.stream : [q.stream];
      where.push(`e.stream IN (${streams.map((_, i) => `@s${i}`).join(",")})`);
      streams.forEach((s, i) => (params[`s${i}`] = s));
    }
    if (q.kind) {
      where.push(`e.kind = @kind`);
      params.kind = q.kind;
    }
    if (q.source) {
      where.push(`e.source = @source`);
      params.source = q.source;
    }
    if (typeof q.minImportance === "number") {
      where.push(`e.importance >= @minImp`);
      params.minImp = q.minImportance;
    }
    const maxP = q.maxPrivacy ?? "sensitive";
    const allowed = (["normal", "sensitive", "secret"] as PrivacyLevel[]).filter(
      (p) => privacyRank(p) <= privacyRank(maxP),
    );
    where.push(`e.privacy IN (${allowed.map((p) => `'${p}'`).join(",")})`);
    if (q.entity) {
      where.push(`e.id IN (SELECT event_id FROM event_entities WHERE entity = @entity)`);
      params.entity = q.entity;
    }
    let join = "";
    if (q.q) {
      const fts = toFtsQuery(q.q);
      if (fts) {
        join = `JOIN events_fts f ON f.rowid = e.rowid`;
        where.push(`events_fts MATCH @fts`);
        params.fts = fts;
      }
    }
    if (q.cursor) {
      const c = decodeCursor(q.cursor);
      if (c) {
        where.push(
          order === "DESC"
            ? `(e.occurred_at < @cAt OR (e.occurred_at = @cAt AND e.id < @cId))`
            : `(e.occurred_at > @cAt OR (e.occurred_at = @cAt AND e.id > @cId))`,
        );
        params.cAt = c.occurred_at;
        params.cId = c.id;
      }
    }
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 1000);
    params.limit = limit + 1;
    const sql = `SELECT e.* FROM events e ${join}
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY e.occurred_at ${order}, e.id ${order} LIMIT @limit`;
    const rows = this.db.prepare(sql).all(params) as EventRow[];
    const more = rows.length > limit;
    const page = rows.slice(0, limit).map(rowToRecord);
    const last = page[page.length - 1];
    return { events: page, next_cursor: more && last ? encodeCursor(last.occurred_at, last.id) : null };
  }

  /** Iterate all matching events (asc) without loading everything into memory. */
  *iterate(q: Omit<EventQuery, "cursor" | "limit" | "order"> = {}, batch = 500): Generator<EventRecord> {
    let cursor: string | undefined;
    for (;;) {
      const page = this.query({ ...q, order: "asc", limit: batch, cursor });
      for (const e of page.events) yield e;
      if (!page.next_cursor) return;
      cursor = page.next_cursor;
    }
  }

  count(q: Pick<EventQuery, "from" | "to" | "stream"> = {}): number {
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.from) {
      where.push("occurred_at >= ?");
      params.push(q.from);
    }
    if (q.to) {
      where.push("occurred_at < ?");
      params.push(q.to);
    }
    if (typeof q.stream === "string") {
      where.push("stream = ?");
      params.push(q.stream);
    }
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM events ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`)
      .get(...params) as { c: number };
    return row.c;
  }

  streams(): StreamSummary[] {
    const rows = this.db
      .prepare(
        `SELECT stream, COUNT(*) AS count, MIN(occurred_at) AS first_at, MAX(occurred_at) AS last_at,
           GROUP_CONCAT(DISTINCT kind) AS kinds
         FROM events GROUP BY stream ORDER BY count DESC`,
      )
      .all() as Array<Omit<StreamSummary, "kinds"> & { kinds: string }>;
    return rows.map((r) => ({ ...r, kinds: (r.kinds ?? "").split(",").filter(Boolean).sort() }));
  }

  topEntities(opts: { from?: string; to?: string; limit?: number } = {}): Array<{
    entity: string;
    count: number;
    first_at: string;
    last_at: string;
  }> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.from) {
      where.push("occurred_at >= ?");
      params.push(opts.from);
    }
    if (opts.to) {
      where.push("occurred_at < ?");
      params.push(opts.to);
    }
    params.push(opts.limit ?? 50);
    return this.db
      .prepare(
        `SELECT entity, COUNT(*) AS count, MIN(occurred_at) AS first_at, MAX(occurred_at) AS last_at
         FROM event_entities ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         GROUP BY entity COLLATE NOCASE ORDER BY count DESC, last_at DESC LIMIT ?`,
      )
      .all(...params) as Array<{ entity: string; count: number; first_at: string; last_at: string }>;
  }

  markDistilled(ids: string[], notePath: string, at = new Date().toISOString()): void {
    const stmt = this.db.prepare(`UPDATE events SET distilled_at = ?, note_path = ? WHERE id = ?`);
    this.db.transaction(() => ids.forEach((id) => stmt.run(at, notePath, id)))();
  }

  /** Delete events older than `before` in a stream. Returns deleted count. */
  prune(stream: string, before: string, dryRun = false): number {
    if (dryRun) {
      return (
        this.db
          .prepare(`SELECT COUNT(*) AS c FROM events WHERE stream = ? AND occurred_at < ?`)
          .get(stream, before) as { c: number }
      ).c;
    }
    return this.db.prepare(`DELETE FROM events WHERE stream = ? AND occurred_at < ?`).run(stream, before).changes;
  }

  rebuildFts(): void {
    this.db.exec(`INSERT INTO events_fts(events_fts) VALUES ('rebuild')`);
    this.db.exec(`DELETE FROM event_entities`);
    const ins = this.db.prepare(
      `INSERT OR IGNORE INTO event_entities(event_id, entity, occurred_at) VALUES (?, ?, ?)`,
    );
    const rows = this.db.prepare(`SELECT id, entities, occurred_at FROM events`).all() as Array<{
      id: string;
      entities: string;
      occurred_at: string;
    }>;
    this.db.transaction(() => {
      for (const r of rows) for (const ent of parseJson<string[]>(r.entities, [])) ins.run(r.id, ent, r.occurred_at);
    })();
  }

  getCheckpoint(name: string): string | null {
    const r = this.db.prepare(`SELECT value FROM checkpoints WHERE name = ?`).get(name) as { value: string } | undefined;
    return r?.value ?? null;
  }

  setCheckpoint(name: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO checkpoints(name, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(name, value, new Date().toISOString());
  }
}
