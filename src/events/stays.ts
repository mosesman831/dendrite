import type { EventStore } from "./store.js";
import type { PrivacyLevel } from "./types.js";
import { detectStays } from "./importers-life.js";
import { ingestEvents, type IngestOptions } from "./ingest.js";
import { matchPlace, type Place } from "./places.js";
import { maxPrivacy } from "./enrich.js";

export interface LiveStayOptions {
  from: string;
  to?: string;
  places?: Place[];
  radiusM?: number;
  minMinutes?: number;
}

/**
 * Turn streamed location points into `location/stay` events. Only *closed* stays are emitted
 * (a later point exists outside the cluster), so ids keyed by start time stay stable across runs.
 */
export function deriveLiveStays(store: EventStore, o: LiveStayOptions, ingest: IngestOptions): { created: number } {
  const pts: Array<{ t: string; lat: number; lon: number; privacy: PrivacyLevel }> = [];
  for (const e of store.iterate({ from: o.from, to: o.to, stream: "location", maxPrivacy: "sensitive" }))
    if (e.kind === "point" && e.lat != null && e.lon != null) pts.push({ t: e.occurred_at, lat: e.lat, lon: e.lon, privacy: e.privacy });
  if (pts.length < 2) return { created: 0 };
  pts.sort((a, b) => a.t.localeCompare(b.t));
  const last = pts[pts.length - 1]!.t;
  const stays = detectStays(pts, { radiusM: o.radiusM, minMinutes: o.minMinutes }).filter((s) => s.end < last);
  const events = stays.map((s) => {
    const place = matchPlace(s.lat, s.lon, o.places);
    const privacy = pts.filter((p) => p.t >= s.start && p.t <= s.end).reduce<PrivacyLevel>((m, p) => maxPrivacy(m, p.privacy), "normal");
    return {
      stream: "location",
      kind: "stay",
      source: "derived:stays",
      external_id: `stay:${s.start}`,
      occurred_at: s.start,
      ended_at: s.end,
      lat: s.lat,
      lon: s.lon,
      privacy,
      text: place ? `At ${place.name} for ~${s.minutes} min` : `Stayed ~${s.minutes} min near ${s.lat.toFixed(4)}, ${s.lon.toFixed(4)}`,
      data: { minutes: s.minutes, points: s.points, place: place?.name },
    };
  });
  return { created: events.length ? ingestEvents(store, events, ingest).accepted : 0 };
}
