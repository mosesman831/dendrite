import Database from "better-sqlite3";
import { mkdirSync, readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import matter from "gray-matter";
import type { Correction, NoteRecord, SearchHit } from "../types.js";
import { blobToVector, cosineSimilarity, vectorToBlob } from "../providers/embeddings.js";

/** Paths Dendrite manages internally — never index or cross-link these. */
export function isSystemNotePath(relPath: string): boolean {
  return relPath.includes("brain/_dendrite/");
}

/** Daily journal slugs are poor link targets for durable notes. */
export function isEphemeralNotePath(relPath: string): boolean {
  return relPath.includes("brain/journal/") || relPath.includes("brain/inbox/");
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS dumps (
  id TEXT PRIMARY KEY,
  source TEXT,
  received_at TEXT,
  note_path TEXT,
  compartment TEXT,
  confidence REAL,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS notes (
  path TEXT PRIMARY KEY,
  compartment TEXT,
  title TEXT,
  entities TEXT,
  tags TEXT,
  summary TEXT,
  updated_at TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  title, entities, tags, summary,
  content='notes', content_rowid='rowid',
  tokenize='porter'
);

CREATE TABLE IF NOT EXISTS corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dump_id TEXT,
  text_excerpt TEXT,
  predicted_compartment TEXT,
  corrected_compartment TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS ingest_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dump_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS embeddings (
  note_path TEXT PRIMARY KEY,
  vector BLOB NOT NULL,
  model TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS write_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  dump_id TEXT NOT NULL,
  ts TEXT NOT NULL
);
`;

export class DendriteIndex {
  readonly db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    this.migrateSchema();
    this.setupFtsTriggers();
  }

  private migrateSchema(): void {
    const cols = this.db
      .prepare(`PRAGMA table_info(dumps)`)
      .all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "text")) {
      try {
        this.db.exec(`ALTER TABLE dumps ADD COLUMN text TEXT`);
      } catch {
        /* column may already exist */
      }
    }
  }

  private setupFtsTriggers(): void {
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
        INSERT INTO notes_fts(rowid, title, entities, tags, summary)
        VALUES (new.rowid, new.title, new.entities, new.tags, new.summary);
      END;
      CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
        INSERT INTO notes_fts(notes_fts, rowid, title, entities, tags, summary)
        VALUES ('delete', old.rowid, old.title, old.entities, old.tags, old.summary);
      END;
      CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
        INSERT INTO notes_fts(notes_fts, rowid, title, entities, tags, summary)
        VALUES ('delete', old.rowid, old.title, old.entities, old.tags, old.summary);
        INSERT INTO notes_fts(rowid, title, entities, tags, summary)
        VALUES (new.rowid, new.title, new.entities, new.tags, new.summary);
      END;
    `);
  }

  close(): void {
    this.db.close();
  }

  isDumpProcessed(id: string): boolean {
    const row = this.db.prepare("SELECT id FROM dumps WHERE id = ?").get(id);
    return !!row;
  }

  /** True if parent or any child segment dump id was already processed. */
  isDumpFamilyProcessed(parentId: string): boolean {
    const row = this.db
      .prepare(`SELECT id FROM dumps WHERE id = ? OR id LIKE ? LIMIT 1`)
      .get(parentId, `${parentId}#%`);
    return !!row;
  }

  getDumpFamily(parentId: string): Array<{
    id: string;
    note_path: string;
    compartment: string;
    confidence: number;
    source: string;
    received_at: string;
    text: string | null;
  }> {
    return this.db
      .prepare(
        `SELECT id, note_path, compartment, confidence, source, received_at, text FROM dumps
         WHERE id = ? OR id LIKE ?
         ORDER BY id`,
      )
      .all(parentId, `${parentId}#%`) as Array<{
      id: string;
      note_path: string;
      compartment: string;
      confidence: number;
      source: string;
      received_at: string;
      text: string | null;
    }>;
  }

  /** Reconstruct a multi-segment capture by parent dump id / split_group. */
  getCaptureSiblings(
    splitGroup: string,
    vaultPath?: string,
  ): Array<{
    dumpId: string;
    notePath: string;
    compartment: string;
    confidence: number;
    source: string;
    receivedAt: string;
    title: string;
    summary: string;
    segmentIndex: number | null;
    text?: string;
    transcript?: string;
  }> {
    const parentId = splitGroup.includes("#") ? splitGroup.replace(/#\d+$/, "") : splitGroup;
    const family = this.getDumpFamily(parentId);
    const parentTranscript =
      family.find((r) => r.id === parentId)?.text ??
      family.find((r) => r.id === `${parentId}#0`)?.text ??
      undefined;
    const byPath = new Map(family.map((r) => [r.note_path, r]));

    if (vaultPath) {
      for (const note of this.listAllNotes()) {
        if (byPath.has(note.path)) continue;
        const abs = join(vaultPath, note.path);
        if (!existsSync(abs)) continue;
        try {
          const raw = readFileSync(abs, "utf8");
          const { data } = matter(raw);
          if (String(data.split_group ?? "") !== parentId) continue;
          byPath.set(note.path, {
            id: `${parentId}#?`,
            note_path: note.path,
            compartment: note.compartment,
            confidence: Number(data.confidence ?? 0),
            source: String(data.source ?? "unknown"),
            received_at: String(data.created ?? note.updated_at),
            text: null,
          });
        } catch {
          /* skip unreadable */
        }
      }
    }

    return [...byPath.values()].map((row) => {
      const hash = row.id.indexOf("#");
      const segPart = hash >= 0 ? row.id.slice(hash + 1) : "";
      const segIdx = /^\d+$/.test(segPart) ? Number.parseInt(segPart, 10) : null;
      const note = this.getNote(row.note_path);
      const rowText = row.text ?? undefined;
      return {
        dumpId: row.id,
        notePath: row.note_path,
        compartment: row.compartment,
        confidence: row.confidence,
        source: row.source,
        receivedAt: row.received_at,
        title: note?.title ?? row.note_path,
        summary: note?.summary ?? "",
        segmentIndex: segIdx,
        text: rowText,
        transcript: parentTranscript ?? rowText,
      };
    });
  }

  deleteDump(id: string): void {
    this.db.prepare(`DELETE FROM dumps WHERE id = ?`).run(id);
  }

  deleteDumpFamily(parentId: string): void {
    this.db.prepare(`DELETE FROM dumps WHERE id = ? OR id LIKE ?`).run(parentId, `${parentId}#%`);
  }

  getLastCaptureParentId(): string | null {
    const row = this.db
      .prepare(`SELECT id FROM dumps ORDER BY created_at DESC LIMIT 1`)
      .get() as { id: string } | undefined;
    if (!row) return null;
    const hash = row.id.indexOf("#");
    return hash >= 0 ? row.id.slice(0, hash) : row.id;
  }

  recordDump(
    id: string,
    source: string,
    receivedAt: string,
    notePath: string,
    compartment: string,
    confidence: number,
    text?: string,
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO dumps (id, source, received_at, note_path, compartment, confidence, created_at, text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        source,
        receivedAt,
        notePath,
        compartment,
        confidence,
        new Date().toISOString(),
        text ?? null,
      );
  }

  recordWriteAudit(agentId: string, tool: string, dumpId: string): void {
    this.db
      .prepare(`INSERT INTO write_audit (agent_id, tool, dump_id, ts) VALUES (?, ?, ?, ?)`)
      .run(agentId, tool, dumpId, new Date().toISOString());
  }

  upsertNote(note: NoteRecord): void {
    this.db
      .prepare(
        `INSERT INTO notes (path, compartment, title, entities, tags, summary, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           compartment=excluded.compartment,
           title=excluded.title,
           entities=excluded.entities,
           tags=excluded.tags,
           summary=excluded.summary,
           updated_at=excluded.updated_at`,
      )
      .run(
        note.path,
        note.compartment,
        note.title,
        JSON.stringify(note.entities),
        JSON.stringify(note.tags),
        note.summary,
        note.updated_at,
      );
  }

  search(
    query: string,
    compartment?: string,
    limit = 5,
    opts?: { excludeEphemeral?: boolean; queryVector?: number[]; hybridWeight?: number },
  ): SearchHit[] {
    const ftsHits = this.searchFts(query, compartment, limit * 3, opts?.excludeEphemeral);
    if (!opts?.queryVector || opts.queryVector.length === 0) {
      return ftsHits.slice(0, limit);
    }
    return this.mergeHybridHits(ftsHits, opts.queryVector, limit, opts.hybridWeight ?? 0.4, compartment);
  }

  private searchFts(
    query: string,
    compartment?: string,
    limit = 5,
    excludeEphemeral?: boolean,
  ): SearchHit[] {
    const terms = query
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => `"${t.replace(/"/g, '""')}"`)
      .join(" OR ");
    if (!terms) return [];

    let sql = `
      SELECT n.path, n.title, n.summary,
             bm25(notes_fts) AS score
      FROM notes_fts
      JOIN notes n ON notes_fts.rowid = n.rowid
      WHERE notes_fts MATCH ?
    `;
    const params: unknown[] = [terms];
    if (compartment) {
      sql += " AND n.compartment = ?";
      params.push(compartment);
    }
    sql += " ORDER BY score LIMIT ?";
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as Array<{
      path: string;
      title: string;
      summary: string;
      score: number;
    }>;

    return rows
      .filter((r) => {
        if (isSystemNotePath(r.path)) return false;
        if (excludeEphemeral && isEphemeralNotePath(r.path)) return false;
        return true;
      })
      .map((r) => ({
        path: r.path,
        title: r.title,
        snippet: r.summary?.slice(0, 200) ?? "",
        score: Math.abs(r.score),
      }));
  }

  upsertEmbedding(notePath: string, vector: number[], model: string): void {
    this.db
      .prepare(
        `INSERT INTO embeddings (note_path, vector, model, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(note_path) DO UPDATE SET
           vector=excluded.vector,
           model=excluded.model,
           updated_at=excluded.updated_at`,
      )
      .run(notePath, vectorToBlob(vector), model, new Date().toISOString());
  }

  deleteAllEmbeddings(): void {
    this.db.exec(`DELETE FROM embeddings`);
  }

  countEmbeddings(): number {
    const row = this.db.prepare(`SELECT COUNT(*) as c FROM embeddings`).get() as { c: number };
    return row.c;
  }

  queueStatusCounts(): { pending: number; processing: number; done: number; dead: number } {
    const rows = this.db
      .prepare(`SELECT status, COUNT(*) as c FROM ingest_queue GROUP BY status`)
      .all() as Array<{ status: string; c: number }>;
    const out = { pending: 0, processing: 0, done: 0, dead: 0 };
    for (const r of rows) {
      if (r.status === "pending" || r.status === "processing" || r.status === "done" || r.status === "dead") {
        out[r.status] = r.c;
      }
    }
    return out;
  }

  listEmbeddingPaths(): string[] {
    const rows = this.db.prepare(`SELECT note_path FROM embeddings`).all() as Array<{
      note_path: string;
    }>;
    return rows.map((r) => r.note_path);
  }

  searchSemantic(queryVector: number[], compartment?: string, limit = 10): SearchHit[] {
    const rows = this.db
      .prepare(`SELECT e.note_path, e.vector, n.title, n.summary, n.compartment FROM embeddings e JOIN notes n ON n.path = e.note_path`)
      .all() as Array<{
      note_path: string;
      vector: Buffer;
      title: string;
      summary: string;
      compartment: string;
    }>;

    const scored = rows
      .filter((r) => {
        if (isSystemNotePath(r.note_path)) return false;
        if (compartment && r.compartment !== compartment) return false;
        return true;
      })
      .map((r) => ({
        path: r.note_path,
        title: r.title,
        snippet: r.summary?.slice(0, 200) ?? "",
        score: cosineSimilarity(queryVector, blobToVector(r.vector)),
      }))
      .filter((h) => h.score > 0.1)
      .sort((a, b) => b.score - a.score);

    return scored.slice(0, limit);
  }

  private mergeHybridHits(
    ftsHits: SearchHit[],
    queryVector: number[],
    limit: number,
    hybridWeight: number,
    compartment?: string,
  ): SearchHit[] {
    const semHits = this.searchSemantic(queryVector, compartment, limit * 3);
    const ftsMax = ftsHits[0]?.score ?? 1;
    const semMax = semHits[0]?.score ?? 1;
    const combined = new Map<string, SearchHit>();

    for (const h of ftsHits) {
      const norm = ftsMax > 0 ? h.score / ftsMax : 0;
      combined.set(h.path, { ...h, score: (1 - hybridWeight) * norm });
    }
    for (const h of semHits) {
      const norm = semMax > 0 ? h.score / semMax : 0;
      const prev = combined.get(h.path);
      const semScore = hybridWeight * norm;
      if (prev) {
        combined.set(h.path, { ...prev, score: prev.score + semScore });
      } else {
        combined.set(h.path, { ...h, score: semScore });
      }
    }

    return [...combined.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }

  findNearDuplicate(text: string, compartment: string, threshold = 0.85): SearchHit | null {
    const hits = this.search(text.slice(0, 500), compartment, 5);
    for (const hit of hits) {
      if (hit.score < threshold) continue;
      if (isTitleRelevantToText(hit.title, text)) return hit;
    }
    return null;
  }

  getRecentCorrections(limit = 5): Correction[] {
    return this.db
      .prepare(
        `SELECT id, dump_id, text_excerpt, predicted_compartment, corrected_compartment, created_at
         FROM corrections ORDER BY id DESC LIMIT ?`,
      )
      .all(limit) as Correction[];
  }

  addCorrection(
    dumpId: string | null,
    excerpt: string,
    predicted: string,
    corrected: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO corrections (dump_id, text_excerpt, predicted_compartment, corrected_compartment, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(dumpId, excerpt.slice(0, 500), predicted, corrected, new Date().toISOString());
  }

  enqueueDump(dumpJson: string): number {
    const now = new Date().toISOString();
    const r = this.db
      .prepare(
        `INSERT INTO ingest_queue (dump_json, status, created_at, updated_at) VALUES (?, 'pending', ?, ?)`,
      )
      .run(dumpJson, now, now);
    return Number(r.lastInsertRowid);
  }

  claimPendingDumps(limit: number, maxRetries = 5): Array<{ id: number; dump_json: string; attempts: number }> {
    const rows = this.db
      .prepare(
        `SELECT id, dump_json, attempts FROM ingest_queue
         WHERE status = 'pending' AND attempts < ?
         ORDER BY id ASC LIMIT ?`,
      )
      .all(maxRetries, limit) as Array<{ id: number; dump_json: string; attempts: number }>;
    for (const row of rows) {
      this.db
        .prepare(
          `UPDATE ingest_queue SET status = 'processing', updated_at = ? WHERE id = ?`,
        )
        .run(new Date().toISOString(), row.id);
    }
    return rows;
  }

  completeQueueItem(id: number): void {
    this.db
      .prepare(`UPDATE ingest_queue SET status = 'done', updated_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), id);
  }

  failQueueItem(id: number, error: string, maxRetries: number): void {
    const row = this.db
      .prepare(`SELECT attempts FROM ingest_queue WHERE id = ?`)
      .get(id) as { attempts: number };
    const attempts = (row?.attempts ?? 0) + 1;
    const status = attempts >= maxRetries ? "dead" : "pending";
    this.db
      .prepare(
        `UPDATE ingest_queue SET status = ?, attempts = ?, last_error = ?, updated_at = ? WHERE id = ?`,
      )
      .run(status, attempts, error.slice(0, 1000), new Date().toISOString(), id);
  }

  listInboxNotes(): NoteRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM notes WHERE compartment = 'inbox' ORDER BY updated_at DESC`)
      .all() as Array<Record<string, string>>;
    return rows.map(parseNoteRow);
  }

  recentNotes(compartment?: string, since?: string, limit = 10): NoteRecord[] {
    let sql = `SELECT * FROM notes WHERE 1=1`;
    const params: unknown[] = [];
    if (compartment) {
      sql += ` AND compartment = ?`;
      params.push(compartment);
    }
    if (since) {
      sql += ` AND updated_at >= ?`;
      params.push(since);
    }
    sql += ` ORDER BY updated_at DESC LIMIT ?`;
    params.push(limit);
    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, string>>;
    return rows.map(parseNoteRow);
  }

  countDumpsSince(since: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as c FROM dumps WHERE received_at >= ?`)
      .get(since) as { c: number };
    return row.c;
  }

  topEntitiesSince(since: string, limit = 20): Array<{ entity: string; count: number }> {
    const rows = this.db
      .prepare(`SELECT entities FROM notes WHERE updated_at >= ?`)
      .all(since) as Array<{ entities: string }>;
    const counts = new Map<string, number>();
    for (const row of rows) {
      const ents: string[] = JSON.parse(row.entities || "[]");
      for (const e of ents) {
        counts.set(e, (counts.get(e) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .map(([entity, count]) => ({ entity, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }

  getNote(path: string): NoteRecord | null {
    const row = this.db.prepare(`SELECT * FROM notes WHERE path = ?`).get(path) as
      | Record<string, string>
      | undefined;
    return row ? parseNoteRow(row) : null;
  }

  listAllNotes(): NoteRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM notes ORDER BY compartment, title`)
      .all() as Array<Record<string, string>>;
    return rows.map(parseNoteRow).filter((n) => !isSystemNotePath(n.path));
  }

  /** Compact per-compartment note list for the classifier prompt. */
  vaultIndexSummary(limitPerCompartment = 8): string {
    const rows = this.db
      .prepare(
        `SELECT compartment, path, title FROM notes
         WHERE compartment NOT IN ('inbox', '_dendrite')
           AND path NOT LIKE 'brain/_dendrite/%'
           AND path NOT LIKE 'brain/journal/%'
         ORDER BY compartment, updated_at DESC`,
      )
      .all() as Array<{ compartment: string; path: string; title: string }>;

    const byComp = new Map<string, Array<{ path: string; title: string }>>();
    for (const row of rows) {
      const list = byComp.get(row.compartment) ?? [];
      if (list.length < limitPerCompartment) {
        list.push({ path: row.path, title: row.title });
        byComp.set(row.compartment, list);
      }
    }

    if (byComp.size === 0) return "(empty vault — create new topic notes for durable content)";

    return [...byComp.entries()]
      .map(([comp, notes]) => {
        const lines = notes.map((n) => `    - ${n.path} — ${n.title}`).join("\n");
        return `  ${comp} (${notes.length} shown):\n${lines}`;
      })
      .join("\n");
  }

  compartmentCounts(): Record<string, number> {
    const rows = this.db
      .prepare(
        `SELECT compartment, COUNT(*) as c FROM notes
         WHERE path NOT LIKE 'brain/_dendrite/%'
         GROUP BY compartment`,
      )
      .all() as Array<{ compartment: string; c: number }>;
    const out: Record<string, number> = {};
    for (const r of rows) out[r.compartment] = r.c;
    return out;
  }

  reindexVault(vaultPath: string): number {
    this.db.exec(`DELETE FROM notes`);
    this.db.exec(`DELETE FROM notes_fts`);
    let count = 0;
    const walk = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
        } else if (entry.endsWith(".md")) {
          const rel = relative(vaultPath, full).replace(/\\/g, "/");
          if (isSystemNotePath(rel)) continue;
          this.indexFile(full, vaultPath);
          count++;
        }
      }
    };
    walk(vaultPath);
    return count;
  }

  indexFile(absPath: string, vaultPath: string): void {
    const rel = relative(vaultPath, absPath).replace(/\\/g, "/");
    if (isSystemNotePath(rel)) return;
    const raw = readFileSync(absPath, "utf8");
    const { data, content } = matter(raw);
    const compartment = String(data.compartment ?? inferCompartment(rel));
    const title = String(data.title ?? rel.replace(/\.md$/, "").split("/").pop());
    const entities = Array.isArray(data.entities) ? data.entities.map(String) : [];
    const tags = Array.isArray(data.tags) ? data.tags.map(String) : [];
    const summary = String(data.summary ?? content.slice(0, 300).replace(/\s+/g, " "));
    this.upsertNote({
      path: rel,
      compartment,
      title,
      entities,
      tags,
      summary,
      updated_at: String(data.updated ?? data.created ?? new Date().toISOString()),
    });
  }

  /** Recent captures with dump metadata (confidence, source, received_at) joined to notes. */
  recentDumpsWithNotes(limit = 20): Array<NoteRecord & {
    confidence: number;
    source: string;
    received_at: string;
  }> {
    const rows = this.db
      .prepare(
        `SELECT n.path, n.compartment, n.title, n.entities, n.tags,
                n.summary, n.updated_at,
                d.confidence, d.source, d.received_at
         FROM dumps d
         JOIN notes n ON n.path = d.note_path
         WHERE n.path NOT LIKE 'brain/_dendrite/%'
         ORDER BY d.received_at DESC
         LIMIT ?`,
      )
      .all(limit) as Array<Record<string, string>>;
    return rows.map((row) => ({
      ...parseNoteRow(row),
      confidence: Number(row.confidence),
      source: row.source,
      received_at: row.received_at,
    }));
  }

  /** Dump row counts and avg segments per parent capture (strips `#N` suffix). */
  getDumpSegmentStats(since?: string): {
    total_segment_rows: number;
    unique_parent_dumps: number;
    avg_segments_per_dump: number;
  } {
    const where = since ? "WHERE received_at >= ?" : "";
    const params = since ? [since] : [];
    const totalRow = this.db
      .prepare(`SELECT COUNT(*) as c FROM dumps ${where}`)
      .get(...params) as { c: number };
    const parentRow = this.db
      .prepare(
        `SELECT COUNT(DISTINCT
           CASE
             WHEN instr(id, '#') > 0 THEN substr(id, 1, instr(id, '#') - 1)
             ELSE id
           END
         ) as c
         FROM dumps
         ${where}`,
      )
      .get(...params) as { c: number };
    const uniqueParents = parentRow.c;
    const total = totalRow.c;
    const avg = uniqueParents > 0 ? total / uniqueParents : 0;
    return {
      total_segment_rows: total,
      unique_parent_dumps: uniqueParents,
      avg_segments_per_dump: Math.round(avg * 100) / 100,
    };
  }
}

function parseNoteRow(row: Record<string, string>): NoteRecord {
  return {
    path: row.path,
    compartment: row.compartment,
    title: row.title,
    entities: JSON.parse(row.entities || "[]"),
    tags: JSON.parse(row.tags || "[]"),
    summary: row.summary,
    updated_at: row.updated_at,
  };
}

function inferCompartment(relPath: string): string {
  const parts = relPath.split("/");
  if (parts[0] === "brain" && parts[1]) return parts[1];
  return "unknown";
}

/** Require significant title words to appear in text before append_existing via near-dup. */
function isTitleRelevantToText(title: string, text: string): boolean {
  const lower = text.toLowerCase();
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3);
  if (words.length === 0) return false;
  const matches = words.filter((w) => lower.includes(w)).length;
  return matches >= Math.min(2, words.length);
}
