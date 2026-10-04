import { isNoiseEntity } from "./enrich.js";
import type { EventStore } from "./store.js";

/** canonical → [alias, …] (config `aliases:`) into lowercase alias → canonical. */
export function aliasMap(aliases: Record<string, string[]> | undefined): Map<string, string> {
  const m = new Map<string, string>();
  for (const [canon, list] of Object.entries(aliases ?? {})) for (const a of list) if (a.trim()) m.set(a.trim().toLowerCase(), canon);
  return m;
}

export function canonicalize(entities: string[], m: Map<string, string> | undefined): string[] {
  if (!m?.size) return entities;
  return [...new Set(entities.map((e) => m.get(e.toLowerCase()) ?? e))];
}

/** Rewrite stored events so aliases collapse into their canonical entity. Returns events changed. */
export function applyAliases(store: EventStore, aliases: Record<string, string[]>): number {
  const m = aliasMap(aliases);
  if (!m.size) return 0;
  const names = [...m.keys()];
  const rows = store.db
    .prepare(
      `SELECT DISTINCT e.id, e.entities, e.occurred_at FROM events e JOIN event_entities x ON x.event_id = e.id
       WHERE lower(x.entity) IN (${names.map(() => "?").join(",")})`,
    )
    .all(...names) as Array<{ id: string; entities: string; occurred_at: string }>;
  const upd = store.db.prepare(`UPDATE events SET entities = ? WHERE id = ?`);
  const del = store.db.prepare(`DELETE FROM event_entities WHERE event_id = ?`);
  const ins = store.db.prepare(`INSERT OR IGNORE INTO event_entities(event_id, entity, occurred_at) VALUES (?, ?, ?)`);
  store.db.transaction(() => {
    for (const r of rows) {
      const next = canonicalize(JSON.parse(r.entities) as string[], m);
      upd.run(JSON.stringify(next), r.id);
      del.run(r.id);
      for (const e of next) ins.run(r.id, e, r.occurred_at);
    }
  })();
  return rows.length;
}

/** Events currently stored under each alias (what `applyAliases` would merge). */
export function aliasUsage(store: EventStore, aliases: Record<string, string[]>): Array<{ canonical: string; alias: string; events: number }> {
  const q = store.db.prepare(`SELECT COUNT(*) AS n FROM event_entities WHERE lower(entity) = ?`);
  const out: Array<{ canonical: string; alias: string; events: number }> = [];
  for (const [canonical, list] of Object.entries(aliases)) for (const alias of list) out.push({ canonical, alias, events: (q.get(alias.toLowerCase()) as { n: number }).n });
  return out;
}

/**
 * Entities stored by older extractors that are only stop/sentence-start words, with event counts.
 * With `apply`, removes them from those events (event text is untouched).
 */
export function pruneNoiseEntities(store: EventStore, o: { apply?: boolean } = {}): Array<{ entity: string; events: number }> {
  const found = (
    store.db.prepare(`SELECT entity COLLATE BINARY AS entity, COUNT(*) AS events FROM event_entities GROUP BY entity COLLATE BINARY`).all() as Array<{ entity: string; events: number }>
  ).filter((r) => isNoiseEntity(r.entity));
  if (o.apply && found.length) {
    const noise = new Set(found.map((r) => r.entity));
    const rows = store.db
      .prepare(`SELECT DISTINCT e.id, e.entities FROM events e JOIN event_entities x ON x.event_id = e.id WHERE x.entity COLLATE BINARY IN (${found.map(() => "?").join(",")})`)
      .all(...noise) as Array<{ id: string; entities: string }>;
    const upd = store.db.prepare(`UPDATE events SET entities = ? WHERE id = ?`);
    const del = store.db.prepare(`DELETE FROM event_entities WHERE event_id = ? AND entity = ? COLLATE BINARY`);
    store.db.transaction(() => {
      for (const r of rows) {
        const ents = JSON.parse(r.entities) as string[];
        upd.run(JSON.stringify(ents.filter((e) => !noise.has(e))), r.id);
        for (const e of ents) if (noise.has(e)) del.run(r.id, e);
      }
    })();
  }
  return found.sort((a, b) => b.events - a.events);
}
