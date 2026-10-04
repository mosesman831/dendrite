/**
 * Native payload adapters for always-on phone loggers, so continuous capture needs no glue code:
 * - OwnTracks (iOS/Android) HTTP mode: location fixes + region enter/leave
 * - Overland (iOS) GeoJSON batches
 * - Health Auto Export (iOS) REST automation: metrics + workouts
 * - GitHub repo/org webhooks: commits, PRs, issues, releases (type inferred from payload shape)
 */
type Raw = Record<string, unknown>;

const obj = (v: unknown): Raw | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : null);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const compact = (o: Raw) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/** "2026-10-03 07:00:00 +0100" (HAE) or any Date-parsable string → ISO, else null. */
export function looseIso(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)\s*([+-]\d{2}):?(\d{2})$/.exec(s.trim());
  const d = new Date(m ? `${m[1]}T${m[2]}${m[3]}:${m[4]}` : s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function fromOwnTracks(body: unknown): Raw[] {
  const items = Array.isArray(body) ? body : [body];
  const out: Raw[] = [];
  for (const it of items) {
    const o = obj(it);
    const tst = num(o?.tst);
    if (!o || tst === undefined) continue;
    const lat = num(o.lat);
    const lon = num(o.lon);
    const occurred_at = new Date(tst * 1000).toISOString();
    const tid = str(o.tid) ?? str(o.topic) ?? "";
    if (o._type === "location" && lat !== undefined && lon !== undefined) {
      out.push({
        stream: "location",
        kind: "point",
        source: "owntracks",
        occurred_at,
        lat,
        lon,
        external_id: `owntracks:${tid}:${tst}`,
        data: compact({ accuracy: num(o.acc), altitude: num(o.alt), speed_kmh: num(o.vel), battery: num(o.batt), connection: str(o.conn), device: tid || undefined }),
      });
    } else if (o._type === "transition") {
      const region = str(o.desc) ?? "region";
      const ev = o.event === "leave" ? "leave" : "enter";
      out.push({
        stream: "location",
        kind: ev,
        source: "owntracks",
        occurred_at,
        lat,
        lon,
        text: `${ev === "enter" ? "Arrived at" : "Left"} ${region}`,
        entities: [region],
        external_id: `owntracks:${tid}:${ev}:${tst}`,
        data: { region },
      });
    }
  }
  return out;
}

export function fromOverland(body: unknown): Raw[] {
  const locs = obj(body)?.locations;
  if (!Array.isArray(locs)) return [];
  const out: Raw[] = [];
  for (const f of locs) {
    const g = obj(obj(f)?.geometry);
    const p = obj(obj(f)?.properties) ?? {};
    const c = Array.isArray(g?.coordinates) ? (g!.coordinates as unknown[]) : [];
    const lon = num(c[0]);
    const lat = num(c[1]);
    const occurred_at = looseIso(p.timestamp);
    if (g?.type !== "Point" || lat === undefined || lon === undefined || !occurred_at) continue;
    const motion = Array.isArray(p.motion) ? (p.motion as unknown[]).filter((x): x is string => typeof x === "string") : undefined;
    out.push({
      stream: "location",
      kind: "point",
      source: "overland",
      occurred_at,
      lat,
      lon,
      external_id: `overland:${str(p.device_id) ?? ""}:${occurred_at}`,
      tags: motion?.length ? motion : undefined,
      data: compact({
        accuracy: num(p.horizontal_accuracy),
        altitude: num(p.altitude),
        speed_ms: num(p.speed),
        battery: num(p.battery_level),
        wifi: str(p.wifi),
        device: str(p.device_id),
      }),
    });
  }
  return out;
}

export function fromHealthAutoExport(body: unknown): Raw[] {
  const d = obj(obj(body)?.data) ?? obj(body);
  const out: Raw[] = [];
  for (const m of Array.isArray(d?.metrics) ? (d!.metrics as unknown[]) : []) {
    const mo = obj(m);
    const name = str(mo?.name);
    if (!mo || !name || !Array.isArray(mo.data)) continue;
    for (const s of mo.data as unknown[]) {
      const so = obj(s);
      const occurred_at = looseIso(so?.date);
      if (!so || !occurred_at) continue;
      const value = num(so.qty) ?? num(so.Avg) ?? num(so.avg);
      out.push({
        stream: "health",
        kind: name,
        source: "health-auto-export",
        occurred_at,
        privacy: "sensitive",
        external_id: `hae:${name}:${occurred_at}`,
        data: compact({ value, unit: str(mo.units), min: num(so.Min) ?? num(so.min), max: num(so.Max) ?? num(so.max), origin: str(so.source) }),
      });
    }
  }
  for (const w of Array.isArray(d?.workouts) ? (d!.workouts as unknown[]) : []) {
    const wo = obj(w);
    const start = looseIso(wo?.start);
    if (!wo || !start) continue;
    const name = str(wo.name) ?? "Workout";
    const q = (k: string) => num(wo[k]) ?? num(obj(wo[k])?.qty);
    out.push({
      stream: "health",
      kind: "workout",
      source: "health-auto-export",
      occurred_at: start,
      ended_at: looseIso(wo.end) ?? undefined,
      privacy: "sensitive",
      text: name,
      external_id: `hae:workout:${str(wo.id) ?? start}`,
      data: compact({ duration_s: num(wo.duration), energy_kcal: q("activeEnergyBurned") ?? q("activeEnergy"), distance: q("distance") }),
    });
  }
  return out;
}

/** GitHub webhook payload → work events. Event type is inferred from the body so no header plumbing is needed. */
export function fromGitHub(body: unknown): Raw[] {
  const b = obj(body);
  if (!b) return [];
  const repo = str(obj(b.repository)?.full_name) ?? "github";
  const base = { stream: "code", source: "github", tags: ["github"] };
  const action = str(b.action);
  const commits = Array.isArray(b.commits) ? b.commits : null;
  if (commits && str(b.ref)) {
    if (b.deleted === true) return [];
    const branch = str(b.ref)!.replace(/^refs\/heads\//, "");
    return commits.flatMap((c) => {
      const o = obj(c);
      const sha = str(o?.id);
      if (!o || !sha) return [];
      const msg = str(o.message) ?? "";
      return [{
        ...base,
        kind: "commit",
        external_id: `gh:commit:${sha}`,
        occurred_at: looseIso(o.timestamp) ?? undefined,
        text: `${repo}@${branch}: ${msg.split("\n")[0]}`,
        data: compact({ repo, branch, sha, url: str(o.url), author: str(obj(o.author)?.name) }),
      }];
    });
  }
  const item = obj(b.pull_request) ?? obj(b.issue) ?? obj(b.release);
  if (!item || !action) return [];
  const type = b.pull_request ? "pr" : b.issue ? "issue" : "release";
  const verb = type === "pr" && action === "closed" && item.merged === true ? "merged" : action;
  const keep: Record<string, string[]> = {
    pr: ["opened", "merged", "closed", "reopened", "ready_for_review"],
    issue: ["opened", "closed", "reopened"],
    release: ["published"],
  };
  if (!keep[type]!.includes(verb)) return [];
  const n = num(item.number);
  const title = str(item.title) ?? str(item.name) ?? str(item.tag_name) ?? "";
  const at = looseIso(item.merged_at) ?? looseIso(item.closed_at) ?? looseIso(item.published_at) ?? looseIso(item.updated_at) ?? looseIso(item.created_at);
  const label = type === "pr" ? `PR #${n}` : type === "issue" ? `issue #${n}` : "release";
  return [{
    ...base,
    kind: `${type}_${verb}`,
    external_id: `gh:${type}:${repo}:${n ?? str(item.tag_name) ?? title}:${verb}:${at ?? ""}`,
    occurred_at: at ?? undefined,
    text: `${repo} ${label} ${verb}: ${title}`,
    data: compact({ repo, number: n, url: str(item.html_url), user: str(obj(item.user)?.login) ?? str(obj(item.author)?.login) }),
  }];
}

export const RECEIVERS = {
  owntracks: { parse: fromOwnTracks, reply: () => [] as unknown },
  overland: { parse: fromOverland, reply: () => ({ result: "ok" }) as unknown },
  "health-auto-export": { parse: fromHealthAutoExport, reply: () => ({ ok: true }) as unknown },
  github: { parse: fromGitHub, reply: () => ({ ok: true }) as unknown },
} as const;
