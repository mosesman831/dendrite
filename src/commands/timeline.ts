import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig, type DendriteConfig } from "../config.js";
import { createChatProvider, type ChatProvider } from "../providers/llm.js";
import { narrate, renderNarrative } from "../events/narrate.js";
import { DendriteIndex } from "../pipeline/index.js";
import { localDate, addDays } from "../events/time.js";
import { renderDigestMarkdown, renderTimelineText, summarizeDay, summarizeWeek } from "../events/timeline.js";

export function resolveDate(input: string | undefined, timezone: string): string {
  const today = localDate(new Date().toISOString(), timezone);
  if (!input || input === "today") return today;
  if (input === "yesterday") return addDays(today, -1);
  if (/^-\d+$/.test(input)) return addDays(today, Number(input));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) throw new Error(`invalid date "${input}" (use YYYY-MM-DD, today, yesterday, or -N)`);
  return input;
}

interface Opts {
  config?: string;
  week?: boolean;
  stream?: string;
  json?: boolean;
  includeSensitive?: boolean;
}

export async function runTimeline(date: string | undefined, opts: Opts): Promise<void> {
  const { config } = loadConfig(opts.config);
  const tz = config.vault.timezone;
  const d = resolveDate(date, tz);
  const index = new DendriteIndex(config.index.db_path);
  const so = {
    timezone: tz,
    stream: opts.stream?.split(","),
    maxPrivacy: opts.includeSensitive === false ? ("normal" as const) : ("sensitive" as const),
  };
  const s = opts.week ? summarizeWeek(index.events, d, so) : summarizeDay(index.events, d, so);
  index.close();
  if (opts.json) {
    const { event_ids: _ids, ...rest } = s;
    console.log(JSON.stringify(rest, null, 2));
  } else console.log(renderTimelineText(s));
}

export interface WriteDigestOptions {
  week?: boolean;
  stream?: string[];
  dryRun?: boolean;
  narrate?: boolean;
  chat?: ChatProvider;
  log?: (msg: string) => void;
}

/** Build (and optionally narrate) one daily/weekly digest and write it into the vault. Returns the vault-relative path or null. */
export async function writeDigest(
  index: DendriteIndex,
  config: DendriteConfig,
  day: string,
  o: WriteDigestOptions = {},
): Promise<string | null> {
  const log = o.log ?? console.log;
  const tz = config.vault.timezone;
  const so = { timezone: tz, stream: o.stream };
  const s = o.week ? summarizeWeek(index.events, day, so) : summarizeDay(index.events, day, so);
  let narrativeMd: string | undefined;
  if (o.narrate && o.chat && s.total) {
    const forPrompt = config.digest.narrate_sensitive
      ? s
      : o.week
        ? summarizeWeek(index.events, day, { ...so, maxPrivacy: "normal" })
        : summarizeDay(index.events, day, { ...so, maxPrivacy: "normal" });
    const n = await narrate(o.chat, forPrompt, {
      maxEntries: config.digest.max_prompt_events,
      onError: (e) => log(`${s.label}: narration failed (${e.message}); writing deterministic digest`),
    });
    if (n) narrativeMd = renderNarrative(n);
  }
  const rel = join(config.digest.folder, `${s.label}.md`);
  const md = renderDigestMarkdown(s, narrativeMd);
  if (o.dryRun) {
    log(md);
    return null;
  }
  if (!s.total && !config.digest.write_empty) {
    log(`${s.label}: no events, skipped`);
    return null;
  }
  const abs = join(config.vault.path, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, md);
  if (s.period === "day") index.events.markDistilled(s.event_ids, rel);
  log(`${s.label}: ${s.total} events → ${rel}${narrativeMd ? " (narrated)" : ""}`);
  return rel;
}

export async function runDigest(
  date: string | undefined,
  opts: Opts & { dryRun?: boolean; days?: string; narrate?: boolean },
): Promise<void> {
  const { config, llm } = loadConfig(opts.config);
  const d = resolveDate(date, config.vault.timezone);
  const index = new DendriteIndex(config.index.db_path);
  const days = Math.max(1, Number(opts.days ?? 1));
  const doNarrate = opts.narrate ?? config.digest.narrate;
  const chat = doNarrate ? createChatProvider(llm) : undefined;
  try {
    for (let i = 0; i < (opts.week ? 1 : days); i++) {
      await writeDigest(index, config, addDays(d, -i), {
        week: opts.week,
        stream: opts.stream?.split(","),
        dryRun: opts.dryRun,
        narrate: doNarrate,
        chat,
      });
    }
  } finally {
    index.close();
  }
}
