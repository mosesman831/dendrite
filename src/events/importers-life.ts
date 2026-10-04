import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { ImportOptions, ParsedImport } from "./importers.js";

// ---------- Apple Health (export.xml) ----------

/** "2026-10-01 08:00:00 +0100" → "2026-10-01T08:00:00+01:00" */
export function appleDate(v: string | undefined): string | undefined {
  const m = v?.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-])(\d{2})(\d{2})$/);
  return m ? `${m[1]}T${m[2]}${m[3]}${m[4]}:${m[5]}` : v;
}

/** HKQuantityTypeIdentifierStepCount → step_count */
export function appleKind(type: string): string {
  const base = type.replace(/^HK(Quantity|Category|Correlation|Data)?TypeIdentifier/, "").replace(/^HKWorkoutActivityType/, "");
  return (
    base
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
      .toLowerCase()
      .slice(0, 64) || "record"
  );
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([A-Za-z_:][\w:.-]*)="([^"]*)"/g)) {
    out[m[1]] = m[2].replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  }
  return out;
}

export interface AppleHealthOptions extends ImportOptions {
  /** Only records starting at/after this ISO time. */
  since?: string;
  /** Only these HK types (full identifiers or snake kinds). */
  types?: string[];
}

/** Convert one export.xml line to an event, or null. Each Record/Workout opening tag is on one line. */
export function appleHealthLine(line: string, opts: AppleHealthOptions = {}): unknown | null {
  const m = line.match(/<(Record|Workout|ActivitySummary)\b[^>]*>/);
  if (!m) return null;
  const a = attrs(m[0]);
  if (m[1] === "ActivitySummary") {
    if (!a.dateComponents) return null;
    if (opts.types?.length && !opts.types.includes("activity_summary")) return null;
    const data: Record<string, number> = {};
    for (const [k, v] of Object.entries(a)) if (k !== "dateComponents" && Number.isFinite(Number(v))) data[k] = Number(v);
    return {
      stream: opts.stream ?? "health",
      kind: "activity_summary",
      source: opts.source ?? "apple-health",
      occurred_at: a.dateComponents,
      external_id: `activity_summary:${a.dateComponents}`,
      data,
    };
  }
  const type = m[1] === "Workout" ? a.workoutActivityType : a.type;
  if (!type) return null;
  const kind = m[1] === "Workout" ? `workout_${appleKind(type)}`.slice(0, 64) : appleKind(type);
  if (opts.types?.length && !opts.types.includes(type) && !opts.types.includes(kind)) return null;
  const start = appleDate(a.startDate);
  if (!start) return null;
  if (opts.since && Date.parse(start) < Date.parse(opts.since)) return null;
  const end = appleDate(a.endDate);
  const num = Number(a.value);
  const data: Record<string, unknown> =
    m[1] === "Workout"
      ? {
          duration: a.duration ? Number(a.duration) : undefined,
          duration_unit: a.durationUnit,
          distance: a.totalDistance ? Number(a.totalDistance) : undefined,
          distance_unit: a.totalDistanceUnit,
          energy: a.totalEnergyBurned ? Number(a.totalEnergyBurned) : undefined,
          energy_unit: a.totalEnergyBurnedUnit,
        }
      : {
          value: a.value !== undefined && Number.isFinite(num) ? num : a.value?.replace(/^HKCategoryValue\w*?(?=[A-Z])/, ""),
          unit: a.unit,
        };
  if (a.sourceName) data.device = a.sourceName;
  return {
    stream: opts.stream ?? (m[1] === "Workout" ? "fitness" : "health"),
    kind: opts.kind ?? kind,
    source: opts.source ?? "apple-health",
    occurred_at: start,
    ended_at: end && end !== start ? end : undefined,
    data,
  };
}

/** Stream a (potentially multi-GB) export.xml, yielding batches. */
export async function* streamAppleHealth(
  path: string,
  opts: AppleHealthOptions = {},
  batch = 1000,
): AsyncGenerator<unknown[]> {
  const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  let buf: unknown[] = [];
  for await (const line of rl) {
    const e = appleHealthLine(line, opts);
    if (!e) continue;
    buf.push(e);
    if (buf.length >= batch) {
      yield buf;
      buf = [];
    }
  }
  if (buf.length) yield buf;
}

// ---------- Google Takeout location ----------

function e7(v: unknown): number | undefined {
  return typeof v === "number" ? v / 1e7 : undefined;
}

/** "51.5007°, -0.1246°" or "geo:51.5,-0.12" → [lat, lon] */
export function parseLatLng(v: unknown): [number, number] | undefined {
  if (typeof v !== "string") return undefined;
  const m = v.match(/(-?\d+(?:\.\d+)?)°?\s*,\s*(-?\d+(?:\.\d+)?)/);
  return m ? [Number(m[1]), Number(m[2])] : undefined;
}

export function isTakeoutLocation(json: unknown): boolean {
  if (Array.isArray(json)) return json.length > 0 && typeof json[0] === "object" && json[0] !== null && ("visit" in json[0] || "activity" in json[0] || "timelinePath" in json[0]);
  if (!json || typeof json !== "object") return false;
  return "locations" in json || "timelineObjects" in json || "semanticSegments" in json;
}

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export function parseTakeoutLocation(json: unknown, opts: ImportOptions = {}): ParsedImport {
  const items: unknown[] = [];
  const errors: ParsedImport["errors"] = [];
  const src = opts.source ?? "google-takeout";
  const minMs = (opts.minIntervalSec ?? 60) * 1000;
  const root = json as J;

  // Records.json — raw points
  if (Array.isArray(root?.locations)) {
    let last = -Infinity;
    root.locations.forEach((p: J, i: number) => {
      const t = p.timestamp ?? (p.timestampMs ? Number(p.timestampMs) : undefined);
      const lat = e7(p.latitudeE7);
      const lon = e7(p.longitudeE7);
      const ms = typeof t === "number" ? t : Date.parse(t);
      if (lat === undefined || lon === undefined || !Number.isFinite(ms)) {
        errors.push({ index: i, error: "location missing lat/lon/time" });
        return;
      }
      if (ms - last < minMs) return;
      last = ms;
      items.push({
        stream: opts.stream ?? "location",
        kind: "point",
        source: src,
        occurred_at: new Date(ms).toISOString(),
        lat,
        lon,
        data: { lat, lon, accuracy: p.accuracy, altitude: p.altitude },
      });
    });
  }

  // Semantic Location History (monthly files)
  if (Array.isArray(root?.timelineObjects)) {
    root.timelineObjects.forEach((o: J, i: number) => {
      const v = o.placeVisit;
      const a = o.activitySegment;
      if (v) {
        const loc = v.location ?? {};
        const start = v.duration?.startTimestamp ?? v.duration?.startTimestampMs;
        if (!start) return void errors.push({ index: i, error: "placeVisit missing start" });
        const name = loc.name ?? loc.address ?? "Unknown place";
        items.push({
          stream: opts.stream ?? "location",
          kind: "visit",
          source: src,
          occurred_at: /^\d+$/.test(String(start)) ? Number(start) : start,
          ended_at: v.duration?.endTimestamp,
          external_id: loc.placeId ? `${loc.placeId}@${start}` : undefined,
          lat: e7(loc.latitudeE7),
          lon: e7(loc.longitudeE7),
          text: `Visited ${name}${loc.address && loc.name ? ` (${loc.address})` : ""}`,
          entities: loc.name ? [loc.name] : undefined,
          data: { place: loc.name, address: loc.address, place_id: loc.placeId, semantic_type: loc.semanticType },
        });
      } else if (a) {
        const start = a.duration?.startTimestamp;
        if (!start) return void errors.push({ index: i, error: "activitySegment missing start" });
        const type = String(a.activityType ?? "UNKNOWN").toLowerCase();
        items.push({
          stream: opts.stream ?? "movement",
          kind: type.replace(/[^a-z0-9_]/g, "_").slice(0, 64) || "activity",
          source: src,
          occurred_at: start,
          ended_at: a.duration?.endTimestamp,
          lat: e7(a.startLocation?.latitudeE7),
          lon: e7(a.startLocation?.longitudeE7),
          data: { activity: type, distance_m: a.distance ?? a.waypointPath?.distanceMeters },
        });
      }
    });
  }

  // On-device Timeline export (2024+): {semanticSegments:[...]} or bare array
  const segs: J[] | undefined = Array.isArray(root?.semanticSegments) ? root.semanticSegments : Array.isArray(root) ? root : undefined;
  segs?.forEach((s: J, i: number) => {
    const start = s.startTime;
    if (!start) return;
    if (s.visit) {
      const c = s.visit.topCandidate ?? {};
      const ll = parseLatLng(c.placeLocation?.latLng ?? c.placeLocation);
      items.push({
        stream: opts.stream ?? "location",
        kind: "visit",
        source: src,
        occurred_at: start,
        ended_at: s.endTime,
        external_id: c.placeId ? `${c.placeId}@${start}` : undefined,
        lat: ll?.[0],
        lon: ll?.[1],
        text: `Visited ${c.semanticType && c.semanticType !== "UNKNOWN" ? c.semanticType.toLowerCase() : "a place"}`,
        data: { place_id: c.placeId, semantic_type: c.semanticType, probability: c.probability },
      });
    } else if (s.activity) {
      const c = s.activity.topCandidate ?? {};
      const type = String(c.type ?? "unknown").toLowerCase();
      items.push({
        stream: opts.stream ?? "movement",
        kind: type.replace(/[^a-z0-9_]/g, "_").slice(0, 64) || "activity",
        source: src,
        occurred_at: start,
        ended_at: s.endTime,
        data: { activity: type, distance_m: s.activity.distanceMeters },
      });
    } else if (Array.isArray(s.timelinePath)) {
      let last = -Infinity;
      for (const p of s.timelinePath as J[]) {
        const ll = parseLatLng(p.point);
        const ms = Date.parse(p.time);
        if (!ll || !Number.isFinite(ms) || ms - last < minMs) continue;
        last = ms;
        items.push({
          stream: opts.stream ?? "location",
          kind: "point",
          source: src,
          occurred_at: p.time,
          lat: ll[0],
          lon: ll[1],
          data: { lat: ll[0], lon: ll[1] },
        });
      }
    } else errors.push({ index: i, error: "unrecognised segment" });
  });

  return { items, errors };
}

// ---------- stay detection ----------

export function haversineM(a: [number, number], b: [number, number]): number {
  const R = 6371e3;
  const rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad;
  const dLon = (b[1] - a[1]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export interface Stay {
  lat: number;
  lon: number;
  start: string;
  end: string;
  minutes: number;
  points: number;
}

/** Collapse a time-ordered point trail into stays: ≥ minMinutes within radiusM of the running centroid. */
export function detectStays(
  points: Array<{ t: string; lat: number; lon: number }>,
  o: { radiusM?: number; minMinutes?: number } = {},
): Stay[] {
  const radius = o.radiusM ?? 150;
  const minMs = (o.minMinutes ?? 10) * 60_000;
  const pts = [...points].sort((a, b) => a.t.localeCompare(b.t));
  const out: Stay[] = [];
  let cluster: typeof pts = [];
  let c: [number, number] = [0, 0];
  const flush = () => {
    if (cluster.length < 2) return;
    const s = Date.parse(cluster[0].t);
    const e = Date.parse(cluster[cluster.length - 1].t);
    if (e - s >= minMs)
      out.push({
        lat: Math.round(c[0] * 1e6) / 1e6,
        lon: Math.round(c[1] * 1e6) / 1e6,
        start: new Date(s).toISOString(),
        end: new Date(e).toISOString(),
        minutes: Math.round((e - s) / 60_000),
        points: cluster.length,
      });
  };
  for (const p of pts) {
    if (cluster.length && haversineM(c, [p.lat, p.lon]) <= radius) {
      cluster.push(p);
      const n = cluster.length;
      c = [c[0] + (p.lat - c[0]) / n, c[1] + (p.lon - c[1]) / n];
    } else {
      flush();
      cluster = [p];
      c = [p.lat, p.lon];
    }
  }
  flush();
  return out;
}

export function staysToEvents(stays: Stay[], source: string): unknown[] {
  return stays.map((s) => ({
    stream: "location",
    kind: "stay",
    source,
    occurred_at: s.start,
    ended_at: s.end,
    lat: s.lat,
    lon: s.lon,
    text: `Stayed ~${s.minutes} min near ${s.lat.toFixed(4)}, ${s.lon.toFixed(4)}`,
    data: { minutes: s.minutes, points: s.points },
  }));
}

/** Derive stays from point events in an import batch (kind=point with lat/lon). */
export function staysFromItems(items: unknown[], source: string, o?: { radiusM?: number; minMinutes?: number }): unknown[] {
  const pts = (items as J[])
    .filter((e) => e.kind === "point" && typeof e.lat === "number" && typeof e.lon === "number" && e.occurred_at)
    .map((e) => ({ t: new Date(e.occurred_at).toISOString(), lat: e.lat, lon: e.lon }));
  return staysToEvents(detectStays(pts, o), source);
}
