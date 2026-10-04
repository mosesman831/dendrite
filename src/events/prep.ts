import type { EventStore } from "./store.js";
import type { EventRecord, PrivacyLevel } from "./types.js";
import { entityProfile } from "./recall.js";
import { eventSummary } from "./timeline.js";
import { localDate, localTime } from "./time.js";
import { privacyRank } from "./enrich.js";

export interface PrepOptions {
  now?: string;
  timezone?: string;
  maxPrivacy?: PrivacyLevel;
  aliases?: Record<string, string[]>;
  /** Hours ahead to look for the next meeting (default 24). */
  horizonHours?: number;
  /** Prep for a specific calendar event id instead of the next one. */
  eventId?: string;
}

export interface PrepPerson {
  entity: string;
  mentions: number;
  last_at: string | null;
  open_loops: Array<{ id: string; text: string; due_date: string | null }>;
  recent: Array<{ at: string; stream: string; summary: string }>;
}

export interface MeetingPrep {
  meeting: { id: string; at: string; ended_at: string | null; summary: string; in_progress: boolean } | null;
  people: PrepPerson[];
}

/** Brief for the next (or given) calendar entry: who's involved, last interactions, and open loops with them. */
export function buildPrep(store: EventStore, o: PrepOptions = {}): MeetingPrep {
  const now = o.now ?? new Date().toISOString();
  const maxPrivacy = o.maxPrivacy ?? "normal";
  const t = Date.parse(now);
  let ev: EventRecord | undefined;
  if (o.eventId) {
    const e = store.get(o.eventId);
    ev = e && e.stream === "calendar" && privacyRank(e.privacy) <= privacyRank(maxPrivacy) ? e : undefined;
  } else {
    ev = store
      .query({
        stream: "calendar",
        maxPrivacy,
        from: new Date(t - 24 * 3600_000).toISOString(),
        to: new Date(t + (o.horizonHours ?? 24) * 3600_000).toISOString(),
        order: "asc",
        limit: 200,
      })
      .events.find((e) => e.kind !== "cancelled" && (e.occurred_at >= now || (e.ended_at != null && e.ended_at > now)));
  }
  if (!ev) return { meeting: null, people: [] };
  const people = ev.entities.slice(0, 6).map((name) => {
    const p = entityProfile(store, name, { maxPrivacy, aliases: o.aliases, recent: 8 });
    return {
      entity: p.entity,
      mentions: p.count,
      last_at: p.recent.find((r) => r.id !== ev!.id && r.occurred_at < ev!.occurred_at)?.occurred_at ?? null,
      open_loops: p.open_loops,
      recent: p.recent
        .filter((r) => r.id !== ev!.id && r.occurred_at < ev!.occurred_at)
        .slice(0, 3)
        .map((r) => ({ at: r.occurred_at, stream: r.stream, summary: eventSummary(r) })),
    };
  });
  return {
    meeting: { id: ev.id, at: ev.occurred_at, ended_at: ev.ended_at, summary: eventSummary(ev), in_progress: ev.occurred_at < now },
    people,
  };
}

export function renderPrep(p: MeetingPrep, tz = "UTC"): string {
  if (!p.meeting) return "_No upcoming meeting in the calendar._\n";
  const m = p.meeting;
  const out = [`# Prep — ${m.summary}`, `${m.in_progress ? "In progress since" : "At"} ${localDate(m.at, tz)} ${localTime(m.at, tz)}`];
  if (!p.people.length) out.push("", "_No people or things recognised in this entry._");
  for (const x of p.people) {
    out.push("", `## ${x.entity}`, x.last_at ? `Last: ${localDate(x.last_at, tz)} · ${x.mentions} mention(s)` : "_No earlier history._");
    if (x.open_loops.length) out.push("**Open loops:**", ...x.open_loops.map((l) => `- [ ] ${l.text}${l.due_date ? ` (due ${l.due_date})` : ""}`));
    if (x.recent.length) out.push("**Recently:**", ...x.recent.map((r) => `- ${localDate(r.at, tz)} [${r.stream}] ${r.summary}`));
  }
  return out.join("\n") + "\n";
}

/** Calendar entries starting within `minutes` that haven't been nudged yet (ids recorded in `sent`). */
export function dueNudges(store: EventStore, o: PrepOptions & { minutes: number; sent: Set<string> }): MeetingPrep[] {
  const now = o.now ?? new Date().toISOString();
  const to = new Date(Date.parse(now) + o.minutes * 60_000).toISOString();
  return store
    .query({ stream: "calendar", maxPrivacy: o.maxPrivacy ?? "normal", from: now, to, order: "asc", limit: 20 })
    .events.filter((e) => e.kind !== "cancelled" && e.occurred_at >= now && !o.sent.has(e.id))
    .map((e) => {
      o.sent.add(e.id);
      return buildPrep(store, { ...o, now, eventId: e.id });
    });
}

/** Calendar entries with people that ended within the last `minutes`, not yet asked about — prompts to capture outcomes. */
export function dueFollowups(store: EventStore, o: { now?: string; minutes: number; sent: Set<string>; maxPrivacy?: PrivacyLevel }): Array<{ id: string; summary: string; entities: string[] }> {
  const now = o.now ?? new Date().toISOString();
  const since = new Date(Date.parse(now) - o.minutes * 60_000).toISOString();
  return store
    .query({ stream: "calendar", maxPrivacy: o.maxPrivacy ?? "normal", from: new Date(Date.parse(since) - 24 * 3600_000).toISOString(), to: now, order: "asc", limit: 200 })
    .events.filter((e) => e.kind !== "cancelled" && e.ended_at != null && e.ended_at > since && e.ended_at <= now && e.entities.length > 0 && !o.sent.has(e.id))
    .map((e) => {
      o.sent.add(e.id);
      return { id: e.id, summary: eventSummary(e), entities: e.entities };
    });
}

export function renderFollowup(f: { summary: string; entities: string[] }): string {
  return `How did "${f.summary}" go? Reply with outcomes or follow-ups (with ${f.entities.slice(0, 3).join(", ")}) — they're logged, and "I'll…" becomes an open loop.`;
}

/** Inverse of `renderFollowup`: recognises a reply-to prompt so the answer can be linked to the meeting's people. */
export function parseFollowupPrompt(text: string): { summary: string; entities: string[] } | null {
  const m = /^How did "(.+)" go\? Reply with outcomes or follow-ups \(with ([^)]*)\)/s.exec(text);
  if (!m) return null;
  return { summary: m[1], entities: m[2].split(",").map((s) => s.trim()).filter(Boolean) };
}

/** A `sent` set backed by a checkpoint, so nudges/follow-ups aren't repeated after a restart. Keeps the last `max` ids. */
export function persistedSent(store: EventStore, name: string, max = 500): Set<string> {
  const key = `sent:${name}`;
  let ids: string[] = [];
  try {
    ids = JSON.parse(store.getCheckpoint(key) ?? "[]") as string[];
  } catch {
    ids = [];
  }
  const set = new Set<string>(ids);
  const add = set.add.bind(set);
  set.add = (id: string) => {
    if (!set.has(id)) {
      add(id);
      const all = [...set];
      if (all.length > max) for (const old of all.slice(0, all.length - max)) set.delete(old);
      store.setCheckpoint(key, JSON.stringify([...set]));
    }
    return set;
  };
  return set;
}
