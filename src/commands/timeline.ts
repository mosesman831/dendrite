import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig } from "../config.js";
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

export async function runDigest(
  date: string | undefined,
  opts: Opts & { dryRun?: boolean; days?: string },
): Promise<void> {
  const { config } = loadConfig(opts.config);
  const tz = config.vault.timezone;
  const d = resolveDate(date, tz);
  const index = new DendriteIndex(config.index.db_path);
  const days = Math.max(1, Number(opts.days ?? 1));
  const so = { timezone: tz, stream: opts.stream?.split(",") };
  try {
    for (let i = 0; i < (opts.week ? 1 : days); i++) {
      const day = addDays(d, -i);
      const s = opts.week ? summarizeWeek(index.events, day, so) : summarizeDay(index.events, day, so);
      const rel = join(config.digest.folder, `${s.label}.md`);
      const md = renderDigestMarkdown(s);
      if (opts.dryRun) {
        console.log(md);
        continue;
      }
      if (!s.total && !config.digest.write_empty) {
        console.log(`${s.label}: no events, skipped`);
        continue;
      }
      const abs = join(config.vault.path, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, md);
      if (s.period === "day") index.events.markDistilled(s.event_ids, rel);
      console.log(`${s.label}: ${s.total} events → ${rel}`);
    }
  } finally {
    index.close();
  }
}
