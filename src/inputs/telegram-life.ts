import { habitStatus, renderHabits } from "../events/habits.js";
import { lastTime, renderLastTime } from "../events/last.js";
import { entityProfile } from "../events/recall.js";
import { buildNow, renderNow } from "../events/now.js";
import type { DendriteConfig, EmbeddingsConfig } from "../config.js";
import type { EventStore } from "../events/store.js";
import { ingestEvents, ingestOptionsFromConfig } from "../events/ingest.js";
import { listLoops, renderLoops, setLoopStatus, type LoopStatus } from "../events/loops.js";
import { briefOptionsFromConfig, buildBriefing, renderBriefing } from "../events/briefing.js";
import { computeInsights, renderInsights } from "../events/insights.js";
import { listPeople, renderPeople } from "../events/people.js";
import { matchPlace, placeVisits, renderPlaces } from "../events/places.js";
import { renderSources, sourceHealth } from "../events/sources.js";
import { recallHybrid } from "../events/semantic.js";
import { summarizeDay, renderTimelineText, eventSummary } from "../events/timeline.js";
import { localDate, localTime, normalizeTime } from "../events/time.js";

export interface LifeDeps {
  store: EventStore;
  config: DendriteConfig;
  emb?: EmbeddingsConfig | null;
  now?: () => Date;
}

export const LIFE_COMMANDS = [
  { command: "brief", description: "Today at a glance: agenda, loops, yesterday" },
  { command: "today", description: "Timeline for today (or /today YYYY-MM-DD)" },
  { command: "insights", description: "Patterns vs the previous period: /insights [days]" },
  { command: "people", description: "Who's active, and who you've drifted from" },
  { command: "places", description: "Named places and when you were last there" },
  { command: "sources", description: "Which data feeds are alive or stale" },
  { command: "loops", description: "Open loops (things you said you'd do)" },
  { command: "done", description: "Close a loop: /done <id>" },
  { command: "snooze", description: "Snooze a loop: /snooze <id> [until]" },
  { command: "drop", description: "Drop a loop: /drop <id>" },
  { command: "recall", description: "Search your life log: /recall <query>" },
  { command: "last", description: "When did I last…? /last <thing>" },
  { command: "now", description: "Where you are, what's due, what's broken" },
  { command: "who", description: "Person/place profile + open loops: /who <name>" },
  { command: "habits", description: "Habit streaks and what's overdue" },
  { command: "log", description: "Record an event verbatim: /log <text>" },
  { command: "where", description: "Last known location" },
] as const;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX = 4000;
const clip = (s: string) => (s.length > MAX ? s.slice(0, MAX - 1) + "…" : s);

function findLoop(store: EventStore, prefix: string): { id?: string; error?: string } {
  const p = prefix.trim().toLowerCase();
  if (!/^[0-9a-f]{4,64}$/.test(p)) return { error: "Give the loop id (at least 4 hex chars) shown by /loops." };
  const rows = store.db
    .prepare(`SELECT id FROM open_loops WHERE id LIKE ? AND status IN ('open','snoozed') AND privacy != 'secret' LIMIT 2`)
    .all(`${p}%`) as Array<{ id: string }>;
  if (!rows.length) return { error: `No active loop matches ${p}.` };
  if (rows.length > 1) return { error: `${p} is ambiguous — use more characters.` };
  return { id: rows[0]!.id };
}

/** Pure handler for the life-log Telegram commands. Returns the plain-text reply. */
export async function lifeCommand(d: LifeDeps, cmd: string, arg: string): Promise<string> {
  const { store, config } = d;
  const nowIso = (d.now?.() ?? new Date()).toISOString();
  const tz = config.vault?.timezone ?? "UTC";
  const today = localDate(nowIso, tz);
  const a = arg.trim();

  switch (cmd) {
    case "brief": {
      const date = DAY.test(a) ? a : today;
      return clip(renderBriefing(buildBriefing(store, date, briefOptionsFromConfig(config))));
    }
    case "today": {
      const date = DAY.test(a) ? a : today;
      const s = summarizeDay(store, date, { timezone: tz, maxPrivacy: "normal", maxTimeline: 80 });
      return clip(s.total ? renderTimelineText(s) : `Nothing recorded on ${date}.`);
    }
    case "insights": {
      const days = arg.trim() ? Number(arg.trim()) : (config.insights?.days ?? 7);
      if (!Number.isInteger(days) || days < 1 || days > 366) return "Usage: /insights [days 1–366]";
      return clip(renderInsights(computeInsights(store, { to: today, days, timezone: tz, maxPrivacy: config.insights?.include_sensitive ? "sensitive" : "normal" })));
    }
    case "places":
      return clip(renderPlaces(placeVisits(store, config.places ?? [])));
    case "sources":
      return clip(renderSources(sourceHealth(store, { now: nowIso })));
    case "people":
      return clip(renderPeople(listPeople(store, { now: nowIso, limit: 100 })));
    case "loops": {
      const loops = listLoops(store, { status: "active", maxPrivacy: "normal", limit: 30, now: nowIso });
      return loops.length ? clip(renderLoops(loops, today)) : "No open loops. 🎉";
    }
    case "done":
    case "drop":
    case "snooze": {
      const [idArg = "", ...rest] = a.split(/\s+/);
      const f = findLoop(store, idArg);
      if (!f.id) return f.error!;
      const status: LoopStatus = cmd === "done" ? "done" : cmd === "drop" ? "dropped" : "snoozed";
      let until: string | undefined;
      if (status === "snoozed") {
        const u = rest.join(" ");
        until = (u && normalizeTime(u)) || new Date(Date.parse(nowIso) + 86_400_000).toISOString();
      }
      const l = setLoopStatus(store, f.id, status, until);
      if (!l) return "Loop not found.";
      return status === "snoozed" ? `Snoozed until ${localDate(until!, tz)} ${localTime(until!, tz)}: ${l.text}` : `${status === "done" ? "✓ Done" : "✗ Dropped"}: ${l.text}`;
    }
    case "habits":
      return clip(renderHabits(habitStatus(store, config.habits ?? [], { now: nowIso, timezone: tz, maxPrivacy: "normal" })));
    case "last":
      if (!a) return "Usage: /last <thing> — e.g. /last haircut";
      return clip(renderLastTime(lastTime(store, a, { now: nowIso, timezone: tz }), tz));
    case "now":
      return clip(renderNow(buildNow(store, { now: nowIso, timezone: tz, places: config.places, habits: config.habits, maxPrivacy: "normal" }), tz));
    case "who": {
      if (!a) return "Usage: /who <name>";
      const p = entityProfile(store, a, { maxPrivacy: "normal", recent: 5, aliases: config.aliases });
      if (!p.count) return `Nothing mentions “${a}”.`;
      const lines = [
        `${p.entity} — ${p.count} event(s), ${localDate(p.first_at!, tz)} → ${localDate(p.last_at!, tz)}`,
        ...(p.related.length ? [`Often with: ${p.related.slice(0, 5).map((x) => x.entity).join(", ")}`] : []),
        ...(p.open_loops.length ? ["", "Open loops:", ...p.open_loops.map((l) => `• ${l.text}${l.due_date ? ` (due ${l.due_date})` : ""}`)] : []),
        "",
        "Recent:",
        ...p.recent.map((e) => `• ${localDate(e.occurred_at, tz)} ${eventSummary(e, 120)}`),
      ];
      return clip(lines.join("\n"));
    }
    case "recall": {
      if (!a) return "Usage: /recall <what to look for>";
      const pack = await recallHybrid(store, { q: a, limit: 12, timezone: tz, maxPrivacy: "normal" }, d.emb ?? null);
      return pack.total_hits ? clip(pack.markdown) : `Nothing found for “${a}”.`;
    }
    case "log": {
      if (!a) return "Usage: /log <what happened>";
      const r = ingestEvents(store, [{ stream: "note", kind: "log", source: "telegram", text: a, occurred_at: nowIso }], ingestOptionsFromConfig(config));
      return r.accepted ? "Logged." : "Already logged.";
    }
    case "where": {
      const e = store.query({ stream: ["location", "movement"], maxPrivacy: "normal", limit: 1, order: "desc" }).events[0];
      if (!e) return "No location recorded yet.";
      const coords = e.lat != null && e.lon != null ? ` (${e.lat.toFixed(4)}, ${e.lon.toFixed(4)})` : "";
      const place = matchPlace(e.lat, e.lon, config.places);
      return `${localDate(e.occurred_at, tz)} ${localTime(e.occurred_at, tz)} — ${place ? `at ${place.name} · ` : ""}${eventSummary(e)}${coords}`;
    }
    default:
      return `Unknown command /${cmd}`;
  }
}

/** Mirror a Telegram text capture into the lossless event log (idempotent per chat+message). */
export function logTelegramMessage(
  store: EventStore,
  config: DendriteConfig,
  m: { text: string; chatId: number; messageId: number; date: number; kind?: string },
): boolean {
  const r = ingestEvents(
    store,
    [
      {
        stream: "note",
        kind: m.kind ?? "telegram",
        source: "telegram",
        external_id: `tg:${m.chatId}:${m.messageId}`,
        occurred_at: new Date(m.date * 1000).toISOString(),
        text: m.text,
      },
    ],
    ingestOptionsFromConfig(config),
  );
  return r.accepted > 0;
}
