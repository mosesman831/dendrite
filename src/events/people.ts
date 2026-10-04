import type { EventStore } from "./store.js";
import type { PrivacyLevel } from "./types.js";

export interface PeopleOptions {
  now?: string;
  maxPrivacy?: PrivacyLevel;
  minMentions?: number;
  recentDays?: number;
  limit?: number;
}

export interface PersonRow {
  entity: string;
  mentions: number;
  recent: number;
  first_seen: string;
  last_seen: string;
  days_since: number;
  typical_gap_days: number | null;
  drifting: boolean;
}

const DAY = 86_400_000;

/**
 * Everyone/everything the log mentions, with cadence. An entity is "drifting" when the
 * silence since its last mention is well beyond its usual rhythm (≥3× typical gap, ≥14 days).
 */
export function listPeople(store: EventStore, o: PeopleOptions = {}): PersonRow[] {
  const now = Date.parse(o.now ?? new Date().toISOString());
  const recentDays = o.recentDays ?? 30;
  const levels = o.maxPrivacy === "secret" ? ["normal", "sensitive", "secret"] : o.maxPrivacy === "sensitive" ? ["normal", "sensitive"] : ["normal"];
  const rows = store.db
    .prepare(
      `SELECT ee.entity AS entity, COUNT(*) AS mentions, MIN(ee.occurred_at) AS first_seen, MAX(ee.occurred_at) AS last_seen,
              SUM(CASE WHEN ee.occurred_at >= ? THEN 1 ELSE 0 END) AS recent
         FROM event_entities ee JOIN events e ON e.id = ee.event_id
        WHERE e.privacy IN (${levels.map(() => "?").join(",")}) AND e.source NOT LIKE 'trigger:%' AND ee.occurred_at <= ?
        GROUP BY ee.entity HAVING COUNT(*) >= ?`,
    )
    .all(new Date(now - recentDays * DAY).toISOString(), ...levels, new Date(now).toISOString(), o.minMentions ?? 2) as Array<
    Omit<PersonRow, "days_since" | "typical_gap_days" | "drifting">
  >;
  return rows
    .map((r) => {
      const first = Date.parse(r.first_seen);
      const last = Date.parse(r.last_seen);
      const days_since = Math.floor((now - last) / DAY);
      const gap = r.mentions > 1 ? (last - first) / DAY / (r.mentions - 1) : null;
      const typical_gap_days = gap === null ? null : Math.round(gap * 10) / 10;
      const drifting = gap !== null && r.mentions >= 3 && days_since >= Math.max(14, 3 * gap);
      return { ...r, days_since, typical_gap_days, drifting };
    })
    .sort((a, b) => b.recent - a.recent || b.mentions - a.mentions || a.entity.localeCompare(b.entity))
    .slice(0, o.limit ?? 50);
}

export function renderPeople(rows: PersonRow[]): string {
  if (!rows.length) return "_No recurring people, places or things yet._\n";
  const active = rows.filter((r) => r.recent > 0);
  const drifting = rows.filter((r) => r.drifting).sort((a, b) => b.mentions - a.mentions);
  const out: string[] = [];
  if (active.length) {
    out.push("## Active (last 30 days)");
    for (const r of active.slice(0, 20)) out.push(`- **${r.entity}**: ${r.recent} recent · ${r.mentions} total · last ${r.last_seen.slice(0, 10)}`);
  }
  if (drifting.length) {
    out.push("", "## Drifting (usually every ~N days, now quiet)");
    for (const r of drifting.slice(0, 15)) out.push(`- **${r.entity}**: every ~${r.typical_gap_days}d, silent ${r.days_since}d (since ${r.last_seen.slice(0, 10)})`);
  }
  return out.join("\n").trim() + "\n";
}
