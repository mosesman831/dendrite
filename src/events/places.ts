import type { EventStore } from "./store.js";
import type { PrivacyLevel } from "./types.js";
import { maxPrivacy } from "./enrich.js";
import { slugify } from "../util/slug.js";

export interface Place {
  name: string;
  lat: number;
  lon: number;
  radius_m?: number;
  /** Raise privacy of events at this place (e.g. home → sensitive). */
  privacy?: PrivacyLevel;
}

const R = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;

export function distanceM(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = rad(bLat - aLat);
  const dLon = rad(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Nearest configured place whose radius contains the point. */
export function matchPlace(lat: number | null | undefined, lon: number | null | undefined, places: Place[] | undefined): Place | null {
  if (lat == null || lon == null || !places?.length) return null;
  let best: { p: Place; d: number } | null = null;
  for (const p of places) {
    const d = distanceM(lat, lon, p.lat, p.lon);
    if (d <= (p.radius_m ?? 150) && (!best || d < best.d)) best = { p, d };
  }
  return best?.p ?? null;
}

export const placeTag = (p: Place) => `at:${slugify(p.name)}`;

/** Tag already-stored geo events with newly configured places. Returns events updated. */
export function backfillPlaces(store: EventStore, places: Place[]): number {
  if (!places.length) return 0;
  const rows = store.db
    .prepare(`SELECT id, entities, tags, lat, lon, occurred_at, privacy FROM events WHERE lat IS NOT NULL AND lon IS NOT NULL`)
    .all() as Array<{ id: string; entities: string; tags: string; lat: number; lon: number; occurred_at: string; privacy: PrivacyLevel }>;
  const upd = store.db.prepare(`UPDATE events SET entities = ?, tags = ?, privacy = ? WHERE id = ?`);
  const ent = store.db.prepare(`INSERT OR IGNORE INTO event_entities(event_id, entity, occurred_at) VALUES (?, ?, ?)`);
  let n = 0;
  store.db.transaction(() => {
    for (const r of rows) {
      const p = matchPlace(r.lat, r.lon, places);
      if (!p) continue;
      const entities = JSON.parse(r.entities) as string[];
      if (entities.includes(p.name)) continue;
      const tags = JSON.parse(r.tags) as string[];
      upd.run(JSON.stringify([...entities, p.name]), JSON.stringify([...new Set([...tags, placeTag(p)])]), maxPrivacy(r.privacy, p.privacy ?? "normal"), r.id);
      ent.run(r.id, p.name, r.occurred_at);
      n++;
    }
  })();
  return n;
}

export function placeVisits(store: EventStore, places: Place[]): Array<{ name: string; events: number; last_seen: string | null }> {
  const q = store.db.prepare(`SELECT COUNT(*) AS n, MAX(occurred_at) AS last FROM event_entities WHERE entity = ?`);
  return places.map((p) => {
    const r = q.get(p.name) as { n: number; last: string | null };
    return { name: p.name, events: r.n, last_seen: r.last };
  });
}

export function renderPlaces(rows: ReturnType<typeof placeVisits>): string {
  if (!rows.length) return "No places configured (add `places:` to config).\n";
  return rows.map((p) => `- ${p.name}: ${p.events} events, last ${p.last_seen?.slice(0, 16).replace("T", " ") ?? "never"}`).join("\n") + "\n";
}
