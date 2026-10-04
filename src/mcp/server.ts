import { buildNow, renderNow } from "../events/now.js";
import { buildPrep, renderPrep } from "../events/prep.js";
import { habitStatus, renderHabits } from "../events/habits.js";
import { lastTime, renderLastTime } from "../events/last.js";
import { renderSources, sourceHealth } from "../events/sources.js";
import { placeVisits, renderPlaces } from "../events/places.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { loadConfig, loadCompartments } from "../config.js";
import { DendriteIndex } from "../pipeline/index.js";
import { smartSearch } from "../pipeline/search.js";
import { answerQuestion } from "../pipeline/answer.js";
import { FRONTMATTER_CONTRACT } from "../types.js";
import matter from "gray-matter";
import { entityProfile } from "../events/recall.js";
import { listLoops, renderLoops, setLoopStatus } from "../events/loops.js";
import { briefOptionsFromConfig, buildBriefing, renderBriefing } from "../events/briefing.js";
import { computeInsights, renderInsights } from "../events/insights.js";
import { listPeople, renderPeople } from "../events/people.js";
import { eventEmbeddingsConfig, recallHybrid } from "../events/semantic.js";
import { ingestEvents, ingestOptionsFromConfig } from "../events/ingest.js";
import { normalizeTime, localDate } from "../events/time.js";
import { summarizeDay, summarizeWeek, renderDigestMarkdown } from "../events/timeline.js";

export async function startMcpServer(configPath?: string): Promise<void> {
  const { config, configDir, llm } = loadConfig(configPath);
  const compartments = loadCompartments(config, configDir);
  const index = new DendriteIndex(config.index.db_path);

  const server = new McpServer({
    name: "dendrite",
    version: "0.1.0",
  });

  server.tool(
    "search_vault",
    "Search the Obsidian vault index by keyword",
    {
      query: z.string(),
      compartment: z.string().optional(),
      limit: z.number().optional(),
    },
    async ({ query, compartment, limit }) => {
      const hits = await smartSearch(index, query, config, llm, {
        compartment,
        limit: limit ?? 10,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(hits, null, 2) }],
      };
    },
  );

  server.tool(
    "answer_question",
    "Answer a natural-language question using ONLY vault notes, with [[wikilink]] citations. Read-only RAG; refuses when nothing relevant is found.",
    { question: z.string(), compartment: z.string().optional(), k: z.number().optional() },
    async ({ question, compartment, k }) => {
      const result = await answerQuestion(index, config.vault.path, question, config, llm, { compartment, k });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "read_note",
    "Read a note from the vault by relative path",
    { path: z.string() },
    async ({ path }) => {
      const abs = join(config.vault.path, path);
      if (!existsSync(abs)) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "not found" }) }] };
      }
      const raw = readFileSync(abs, "utf8");
      const { data, content } = matter(raw);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ frontmatter: data, body: content }, null, 2),
          },
        ],
      };
    },
  );

  const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });

  server.tool(
    "record_event",
    "Append a real-world event to the lossless event log (location, health, chat, note, ...). Deduped by content or external_id.",
    {
      stream: z.string(),
      kind: z.string(),
      text: z.string().optional(),
      data: z.record(z.unknown()).optional(),
      occurred_at: z.string().optional(),
      ended_at: z.string().optional(),
      external_id: z.string().optional(),
      source: z.string().optional(),
      tags: z.array(z.string()).optional(),
      importance: z.number().min(0).max(1).optional(),
    },
    async (args) => json(ingestEvents(index.events, [{ ...args, source: args.source ?? "mcp" }], ingestOptionsFromConfig(config))),
  );

  server.tool(
    "query_events",
    "Query the event log by time range, stream, kind, entity, or full-text. Returns newest first with a cursor.",
    {
      from: z.string().optional(),
      to: z.string().optional(),
      stream: z.string().optional(),
      kind: z.string().optional(),
      entity: z.string().optional(),
      q: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
      cursor: z.string().optional(),
      order: z.enum(["asc", "desc"]).optional(),
    },
    async (a) => {
      const from = a.from ? normalizeTime(a.from) : undefined;
      const to = a.to ? normalizeTime(a.to) : undefined;
      if (from === null || to === null) return json({ error: "unparseable from/to" });
      return json(
        index.events.query({
          ...a,
          from,
          to,
          stream: a.stream?.includes(",") ? a.stream.split(",") : a.stream,
          limit: a.limit ?? 50,
          maxPrivacy: "sensitive",
        }),
      );
    },
  );

  server.tool(
    "timeline",
    "What happened on a given day or week (YYYY-MM-DD, default today): per-stream stats, numeric metrics, top entities, highlights, chronological entries.",
    { date: z.string().optional(), period: z.enum(["day", "week"]).optional(), format: z.enum(["json", "markdown"]).optional() },
    async ({ date, period, format }) => {
      const d = date ?? localDate(new Date().toISOString(), config.vault.timezone);
      const o = { timezone: config.vault.timezone, maxPrivacy: "sensitive" as const };
      const s = period === "week" ? summarizeWeek(index.events, d, o) : summarizeDay(index.events, d, o);
      if (format === "markdown") return { content: [{ type: "text" as const, text: renderDigestMarkdown(s) }] };
      const { event_ids: _ids, ...rest } = s;
      return json(rest);
    },
  );

  server.tool(
    "recall",
    "Second-brain recall over the real-world event log. Give `q` and/or `entity` to find matching moments (each with surrounding context), or `at` (ISO time) to see everything that happened around then. Returns a markdown context pack by default.",
    {
      q: z.string().optional().describe("Full-text query"),
      entity: z.string().optional().describe("Person/place/thing"),
      at: z.string().optional().describe("Center time (ISO/date)"),
      window_min: z.number().optional().describe("Window around `at` in minutes (default 60)"),
      from: z.string().optional(),
      to: z.string().optional(),
      streams: z.array(z.string()).optional(),
      limit: z.number().int().min(1).max(200).optional(),
      format: z.enum(["markdown", "json"]).optional(),
    },
    async (a) => {
      const pack = await recallHybrid(index.events, {
        q: a.q,
        entity: a.entity,
        at: a.at,
        windowMin: a.window_min,
        from: a.from,
        to: a.to,
        stream: a.streams,
        limit: a.limit,
        timezone: config.vault.timezone,
        maxPrivacy: config.mcp.include_sensitive ? "sensitive" : "normal",
      }, eventEmbeddingsConfig(config, llm.primary.baseURL));
      return a.format === "json" ? json(pack) : { content: [{ type: "text" as const, text: pack.markdown }] };
    },
  );

  server.tool(
    "open_loops",
    "Commitments/todos the user mentioned (\"I'll…\", \"remind me to…\", \"- [ ] …\") that are not done yet, soonest due first. Use to surface what they still owe or planned.",
    { status: z.enum(["active", "open", "snoozed", "done", "dropped", "all"]).optional(), limit: z.number().int().min(1).max(500).optional(), format: z.enum(["markdown", "json"]).optional() },
    async (a) => {
      const loops = listLoops(index.events, { status: a.status ?? "active", limit: a.limit, maxPrivacy: config.mcp.include_sensitive ? "sensitive" : "normal" });
      return a.format === "json" ? json(loops) : { content: [{ type: "text" as const, text: renderLoops(loops, localDate(new Date().toISOString(), config.vault.timezone)) }] };
    },
  );

  server.tool(
    "briefing",
    "The user's day at a glance: today's agenda, overdue/due-today/upcoming loops, yesterday's highlights, and what happened on this date in past years. Good first call at the start of a conversation.",
    { date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), format: z.enum(["markdown", "json"]).optional() },
    async (a) => {
      const b = buildBriefing(index.events, a.date ?? localDate(new Date().toISOString(), config.vault.timezone), {
        ...briefOptionsFromConfig(config),
        maxPrivacy: config.mcp.include_sensitive ? "sensitive" : "normal",
      });
      return a.format === "json" ? json(b) : { content: [{ type: "text" as const, text: renderBriefing(b) }] };
    },
  );

  server.tool(
    "people",
    "Recurring people, places and things in the user's life log with mention cadence (first/last seen, typical gap). 'drifting' marks ones that have gone quiet relative to their usual rhythm — good for 'who should I catch up with?'.",
    { drifting_only: z.boolean().optional(), format: z.enum(["markdown", "json"]).optional() },
    async (a) => {
      let rows = listPeople(index.events, { maxPrivacy: config.mcp.include_sensitive ? "sensitive" : "normal", limit: 200 });
      if (a.drifting_only) rows = rows.filter((r) => r.drifting);
      return a.format === "json" ? json(rows) : { content: [{ type: "text" as const, text: renderPeople(rows) }] };
    },
  );

  server.tool(
    "now",
    "Call first for situational awareness: the user's current local time, last known place, the most recent events, loops due or overdue, habits due, and capture feeds that are down (so missing data isn't misread as inactivity).",
    { format: z.enum(["markdown", "json"]).optional() },
    async (a) => {
      const tz = config.vault.timezone;
      const n = buildNow(index.events, { timezone: tz, places: config.places, habits: config.habits, maxPrivacy: config.mcp.include_sensitive ? "sensitive" : "normal" });
      return a.format === "json" ? json(n) : { content: [{ type: "text" as const, text: renderNow(n, tz) }] };
    },
  );

  server.tool(
    "meeting_prep",
    "Before a meeting: the next (or given) calendar entry, each person/thing in it with when the user last interacted with them, recent history, and open loops owed — so the agent can brief the user.",
    { event_id: z.string().optional(), format: z.enum(["markdown", "json"]).optional() },
    async (a) => {
      const p = buildPrep(index.events, { eventId: a.event_id, aliases: config.aliases, maxPrivacy: config.mcp.include_sensitive ? "sensitive" : "normal" });
      return a.format === "json" ? json(p) : { content: [{ type: "text" as const, text: renderPrep(p, config.vault.timezone) }] };
    },
  );

  server.tool(
    "habits",
    "The user's configured habits (gym, call mum, …): when each was last done per the life log, current streak, 30-day count, and which are overdue.",
    { format: z.enum(["markdown", "json"]).optional() },
    async (a) => {
      const rows = habitStatus(index.events, config.habits ?? [], { timezone: config.vault.timezone, maxPrivacy: config.mcp.include_sensitive ? "sensitive" : "normal" });
      return a.format === "json" ? json(rows) : { content: [{ type: "text" as const, text: renderHabits(rows) }] };
    },
  );

  server.tool(
    "last_time",
    "Answer 'when did I last …?' from the life log: the most recent matching event, how many days ago, how often it usually happens, and whether it's overdue vs that rhythm.",
    { query: z.string().min(1), format: z.enum(["markdown", "json"]).optional() },
    async (a) => {
      const r = lastTime(index.events, a.query, { timezone: config.vault.timezone, maxPrivacy: config.mcp.include_sensitive ? "sensitive" : "normal" });
      return a.format === "json" ? json(r) : { content: [{ type: "text" as const, text: renderLastTime(r, config.vault.timezone) }] };
    },
  );

  server.tool(
    "source_health",
    "Which ingest feeds (phone GPS, health, imports, bots) are alive: per-source volume, active days, last received, cadence, and 'stale' for continuous feeds that went silent. Use to judge whether missing data means 'nothing happened' or 'the capture broke'.",
    { days: z.number().int().min(1).max(365).optional(), format: z.enum(["markdown", "json"]).optional() },
    async (a) => {
      const rows = sourceHealth(index.events, { windowDays: a.days ?? 30 });
      return a.format === "json" ? json(rows) : { content: [{ type: "text" as const, text: renderSources(rows) }] };
    },
  );

  server.tool(
    "places",
    "The user's named places (geofences from config) with how many events were recorded at each and when last. Events at a place carry it as an entity, so recall/who work with place names too.",
    { format: z.enum(["markdown", "json"]).optional() },
    async (a) => {
      const rows = placeVisits(index.events, config.places ?? []);
      return a.format === "json" ? json(rows) : { content: [{ type: "text" as const, text: renderPlaces(rows) }] };
    },
  );

  server.tool(
    "insights",
    "Patterns in the user's life log vs the previous period of equal length: activity by stream, most-mentioned people/places (new and faded), numeric metric averages, daily rhythm and quiet days, and loop follow-through.",
    { days: z.number().int().min(1).max(366).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), format: z.enum(["markdown", "json"]).optional() },
    async (a) => {
      const i = computeInsights(index.events, {
        to: a.to ?? localDate(new Date().toISOString(), config.vault.timezone),
        days: a.days ?? 7,
        timezone: config.vault.timezone,
        maxPrivacy: config.mcp.include_sensitive ? "sensitive" : "normal",
      });
      return a.format === "json" ? json(i) : { content: [{ type: "text" as const, text: renderInsights(i) }] };
    },
  );

  if (config.mcp.allow_writes)
    server.tool(
      "update_loop",
      "Mark an open loop done/dropped/open, or snooze it until a time",
      { id: z.string(), status: z.enum(["open", "snoozed", "done", "dropped"]), snooze_until: z.string().optional() },
      async (a) => json(setLoopStatus(index.events, a.id, a.status, a.snooze_until) ?? { error: "unknown loop" }),
    );

  server.tool(
    "entity_profile",
    "Everything recorded about a person/place/thing: first/last seen, streams, frequently co-mentioned entities, recent events",
    { name: z.string() },
    async ({ name }) =>
      json(entityProfile(index.events, name, { maxPrivacy: config.mcp.include_sensitive ? "sensitive" : "normal", aliases: config.aliases })),
  );

  server.tool("event_streams", "List event streams with counts, kinds, and first/last timestamps", {}, async () =>
    json({ streams: index.events.streams(), total: index.events.count() }),
  );

  server.tool("list_compartments", "List brain compartments and note counts", {}, async () => {
    const list = Object.entries(compartments.compartments).map(([name, def]) => {
      const count = index.db
        .prepare(`SELECT COUNT(*) as c FROM notes WHERE compartment = ?`)
        .get(name) as { c: number };
      return { name, path: def.path, description: def.description, count: count.c };
    });
    list.push({
      name: "inbox",
      path: compartments.inbox.path,
      description: compartments.inbox.description,
      count: (index.db.prepare(`SELECT COUNT(*) as c FROM notes WHERE compartment = 'inbox'`).get() as { c: number }).c,
    });
    return { content: [{ type: "text", text: JSON.stringify(list, null, 2) }] };
  });

  server.tool(
    "vault_catalog",
    "Return the full vault index: all notes grouped by compartment with paths, titles, summaries",
    { compartment: z.string().optional() },
    async ({ compartment }) => {
      let notes = index.listAllNotes();
      if (compartment) notes = notes.filter((n) => n.compartment === compartment);
      const counts = index.compartmentCounts();
      const catalogPath = join(config.vault.path, "brain/_dendrite/catalog.md");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                db_path: config.index.db_path,
                catalog_md: existsSync(catalogPath) ? "brain/_dendrite/catalog.md" : null,
                counts,
                notes,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "recent_notes",
    "List recently updated notes",
    {
      compartment: z.string().optional(),
      since: z.string().optional(),
      limit: z.number().optional(),
    },
    async ({ compartment, since, limit }) => {
      const notes = index.recentNotes(compartment, since, limit ?? 10);
      return { content: [{ type: "text", text: JSON.stringify(notes, null, 2) }] };
    },
  );

  server.tool(
    "get_backlinks",
    "Find notes that link to the given note path",
    { path: z.string() },
    async ({ path }) => {
      const slug = path.replace(/\.md$/, "").split("/").pop() ?? path;
      const hits = index.search(slug, undefined, 20);
      const backlinks = hits.filter((h) => h.path !== path);
      return { content: [{ type: "text", text: JSON.stringify(backlinks, null, 2) }] };
    },
  );

  server.tool(
    "get_capture_siblings",
    "Reconstruct a multi-segment capture by parent dump id or split_group frontmatter value",
    { split_group: z.string() },
    async ({ split_group }) => {
      const siblings = index.getCaptureSiblings(split_group, config.vault.path);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                parentId: split_group.includes("#") ? split_group.replace(/#\d+$/, "") : split_group,
                segmentCount: siblings.length,
                siblings,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "describe_schema",
    "Return compartment list and frontmatter contract for agent self-configuration",
    {},
    async () => {
      const schema = {
        version: FRONTMATTER_CONTRACT.version,
        compartments: {
          ...compartments.compartments,
          inbox: compartments.inbox,
        },
        frontmatter_contract: FRONTMATTER_CONTRACT.fields,
        vault_path: config.vault.path,
      };
      return { content: [{ type: "text", text: JSON.stringify(schema, null, 2) }] };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
