import { buildNow, renderNow } from "../events/now.js";
import { habitStatus, renderHabits } from "../events/habits.js";
import { lastTime, renderLastTime } from "../events/last.js";
import { aliasUsage, applyAliases } from "../events/aliases.js";
import { renderSources, sourceHealth } from "../events/sources.js";
import { loadConfig } from "../config.js";
import { DendriteIndex } from "../pipeline/index.js";
import { entityProfile } from "../events/recall.js";
import { embedPendingEvents, eventEmbeddingsConfig, providerEmbedFn, recallHybrid } from "../events/semantic.js";
import { localDate, normalizeTime } from "../events/time.js";
import { listLoops, renderLoops, setLoopStatus, LOOP_STATUSES, type LoopStatus } from "../events/loops.js";
import { eventSummary } from "../events/timeline.js";
import { briefOptionsFromConfig, buildBriefing, renderBriefing } from "../events/briefing.js";
import { computeInsights, renderInsights } from "../events/insights.js";
import { listPeople, renderPeople } from "../events/people.js";
import { backfillPlaces, placeVisits } from "../events/places.js";

export async function runRecall(
  query: string | undefined,
  opts: {
    config?: string;
    entity?: string;
    at?: string;
    window?: string;
    from?: string;
    to?: string;
    stream?: string;
    limit?: string;
    context?: string;
    json?: boolean;
    semantic?: boolean;
  },
): Promise<void> {
  const { config, llm } = loadConfig(opts.config);
  const index = new DendriteIndex(config.index.db_path);
  try {
    const pack = await recallHybrid(index.events, {
      q: query,
      entity: opts.entity,
      at: opts.at,
      windowMin: opts.window ? Number(opts.window) : undefined,
      from: opts.from,
      to: opts.to,
      stream: opts.stream?.split(","),
      limit: opts.limit ? Number(opts.limit) : undefined,
      contextMin: opts.context !== undefined ? Number(opts.context) : undefined,
      timezone: config.vault.timezone,
    }, eventEmbeddingsConfig(config, llm.primary.baseURL), { semantic: opts.semantic, log: (m) => console.error(m) });
    console.log(opts.json ? JSON.stringify(pack, null, 2) : pack.markdown);
  } finally {
    index.close();
  }
}

export async function runWho(name: string, opts: { config?: string; json?: boolean }): Promise<void> {
  const { config } = loadConfig(opts.config);
  const index = new DendriteIndex(config.index.db_path);
  try {
    const p = entityProfile(index.events, name, { aliases: config.aliases });
    if (opts.json) {
      console.log(JSON.stringify(p, null, 2));
      return;
    }
    if (!p.count) {
      console.log(`No events mention "${name}".`);
      return;
    }
    const tz = config.vault.timezone;
    console.log(`# ${p.entity}`);
    console.log(`${p.count} event(s), ${localDate(p.first_at!, tz)} → ${localDate(p.last_at!, tz)}`);
    console.log(`Streams: ${p.streams.map((s) => `${s.stream} (${s.count})`).join(", ")}`);
    if (p.related.length) console.log(`Often with: ${p.related.map((r) => `${r.entity} (${r.count})`).join(", ")}`);
    console.log("\nRecent:");
    for (const e of p.recent) console.log(`- ${localDate(e.occurred_at, tz)} [${e.stream}] ${eventSummary(e, 160)}`);
  } finally {
    index.close();
  }
}

export async function runEmbedEvents(opts: { config?: string; max?: string; json?: boolean }): Promise<void> {
  const { config, llm } = loadConfig(opts.config);
  const emb = eventEmbeddingsConfig(config, llm.primary.baseURL);
  if (!emb) {
    console.error("Event embeddings disabled. Set index.embeddings.enabled: true (and index.embeddings.events: true).");
    process.exitCode = 1;
    return;
  }
  const index = new DendriteIndex(config.index.db_path);
  try {
    const r = await embedPendingEvents(index.events, {
      model: emb.model,
      embed: providerEmbedFn(emb),
      includeSensitive: config.index.embeddings.events_include_sensitive,
      max: opts.max ? Number(opts.max) : 50_000,
      log: (m) => console.error(m),
    });
    console.log(opts.json ? JSON.stringify(r) : `Embedded ${r.embedded} event(s) with ${emb.model}; ${r.failed} failed, ${r.remaining} remaining, ${r.orphans} orphan vector(s) removed.`);
  } finally {
    index.close();
  }
}

export async function runLoops(opts: { config?: string; status?: string; limit?: string; json?: boolean }): Promise<void> {
  const { config } = loadConfig(opts.config);
  const index = new DendriteIndex(config.index.db_path);
  try {
    const loops = listLoops(index.events, { status: (opts.status ?? "active") as LoopStatus, limit: opts.limit ? Number(opts.limit) : undefined });
    console.log(opts.json ? JSON.stringify(loops, null, 2) : renderLoops(loops, localDate(new Date().toISOString(), config.vault.timezone)));
  } finally {
    index.close();
  }
}

export async function runLoopSet(id: string, status: string, until: string | undefined, opts: { config?: string }): Promise<void> {
  if (!(LOOP_STATUSES as readonly string[]).includes(status)) throw new Error(`status must be one of ${LOOP_STATUSES.join(", ")}`);
  const { config } = loadConfig(opts.config);
  const index = new DendriteIndex(config.index.db_path);
  try {
    const snooze = until ? normalizeTime(until) ?? undefined : undefined;
    const l = setLoopStatus(index.events, id, status as LoopStatus, snooze);
    if (!l) {
      console.error(`No loop ${id}`);
      process.exitCode = 1;
    } else console.log(`${l.id} → ${l.status}${l.snooze_until ? ` until ${l.snooze_until}` : ""}: ${l.text}`);
  } finally {
    index.close();
  }
}

export async function runBrief(opts: { config?: string; date?: string; json?: boolean }): Promise<void> {
  const { config } = loadConfig(opts.config);
  const index = new DendriteIndex(config.index.db_path);
  try {
    const date = opts.date ?? localDate(new Date().toISOString(), config.vault.timezone);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("--date must be YYYY-MM-DD");
    const b = buildBriefing(index.events, date, briefOptionsFromConfig(config));
    console.log(opts.json ? JSON.stringify(b, null, 2) : renderBriefing(b));
  } finally {
    index.close();
  }
}

export async function runInsights(opts: { config?: string; days?: string; to?: string; json?: boolean; sensitive?: boolean }): Promise<void> {
  const { config } = loadConfig(opts.config);
  const index = new DendriteIndex(config.index.db_path);
  try {
    const to = opts.to ?? localDate(new Date().toISOString(), config.vault.timezone);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new Error("--to must be YYYY-MM-DD");
    const i = computeInsights(index.events, { to, days: opts.days ? Number(opts.days) : 7, timezone: config.vault.timezone, maxPrivacy: opts.sensitive ? "sensitive" : "normal" });
    console.log(opts.json ? JSON.stringify(i, null, 2) : renderInsights(i));
  } finally {
    index.close();
  }
}

export async function runPeople(opts: { config?: string; drifting?: boolean; json?: boolean; sensitive?: boolean }): Promise<void> {
  const { config } = loadConfig(opts.config);
  const index = new DendriteIndex(config.index.db_path);
  try {
    let rows = listPeople(index.events, { maxPrivacy: opts.sensitive ? "sensitive" : "normal", limit: 200 });
    if (opts.drifting) rows = rows.filter((r) => r.drifting);
    console.log(opts.json ? JSON.stringify(rows, null, 2) : renderPeople(rows));
  } finally {
    index.close();
  }
}

export async function runPlaces(opts: { config?: string; backfill?: boolean; json?: boolean }): Promise<void> {
  const { config } = loadConfig(opts.config);
  const index = new DendriteIndex(config.index.db_path);
  try {
    if (!config.places.length) {
      console.log("No places configured. Add e.g.\nplaces:\n  - { name: Home, lat: 51.5, lon: -0.12, radius_m: 120, privacy: sensitive }");
      return;
    }
    if (opts.backfill) console.log(`Tagged ${backfillPlaces(index.events, config.places)} existing event(s).`);
    const v = placeVisits(index.events, config.places);
    if (opts.json) console.log(JSON.stringify(v, null, 2));
    else for (const p of v) console.log(`${p.name.padEnd(24)} ${String(p.events).padStart(7)} events   last ${p.last_seen?.slice(0, 16).replace("T", " ") ?? "never"}`);
  } finally {
    index.close();
  }
}

export async function runSources(opts: { config?: string; days?: string; json?: boolean }): Promise<void> {
  const { config } = loadConfig(opts.config);
  const index = new DendriteIndex(config.index.db_path);
  try {
    const rows = sourceHealth(index.events, { windowDays: Number(opts.days ?? 30) || 30 });
    console.log(opts.json ? JSON.stringify(rows, null, 2) : renderSources(rows));
  } finally {
    index.close();
  }
}

export async function runAliases(opts: { config?: string; apply?: boolean; json?: boolean }): Promise<void> {
  const { config } = loadConfig(opts.config);
  const index = new DendriteIndex(config.index.db_path);
  try {
    if (!Object.keys(config.aliases).length) {
      console.log('No aliases configured. Add e.g.\naliases:\n  "Priya Shah": [Priya, "P. Shah"]');
      return;
    }
    if (opts.apply) console.log(`Merged aliases in ${applyAliases(index.events, config.aliases)} event(s).`);
    const u = aliasUsage(index.events, config.aliases);
    if (opts.json) console.log(JSON.stringify(u, null, 2));
    else for (const r of u) console.log(`${r.alias.padEnd(20)} → ${r.canonical.padEnd(20)} ${r.events} unmerged event(s)`);
  } finally {
    index.close();
  }
}

export async function runLast(query: string[], opts: { config?: string; json?: boolean; sensitive?: boolean }): Promise<void> {
  const { config } = loadConfig(opts.config);
  const index = new DendriteIndex(config.index.db_path);
  try {
    const r = lastTime(index.events, query.join(" "), { timezone: config.vault.timezone, maxPrivacy: opts.sensitive ? "sensitive" : "normal" });
    console.log(opts.json ? JSON.stringify(r, null, 2) : renderLastTime(r, config.vault.timezone));
  } finally {
    index.close();
  }
}

export async function runHabits(opts: { config?: string; json?: boolean }): Promise<void> {
  const { config } = loadConfig(opts.config);
  const index = new DendriteIndex(config.index.db_path);
  try {
    const rows = habitStatus(index.events, config.habits, { timezone: config.vault.timezone });
    console.log(opts.json ? JSON.stringify(rows, null, 2) : renderHabits(rows));
  } finally {
    index.close();
  }
}

export async function runNow(opts: { config?: string; json?: boolean; sensitive?: boolean }): Promise<void> {
  const { config } = loadConfig(opts.config);
  const index = new DendriteIndex(config.index.db_path);
  try {
    const tz = config.vault.timezone;
    const n = buildNow(index.events, { timezone: tz, places: config.places, habits: config.habits, maxPrivacy: opts.sensitive ? "sensitive" : "normal" });
    console.log(opts.json ? JSON.stringify(n, null, 2) : renderNow(n, tz));
  } finally {
    index.close();
  }
}
