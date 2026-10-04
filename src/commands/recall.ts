import { loadConfig } from "../config.js";
import { DendriteIndex } from "../pipeline/index.js";
import { recall, entityProfile } from "../events/recall.js";
import { localDate } from "../events/time.js";
import { eventSummary } from "../events/timeline.js";

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
  },
): Promise<void> {
  const { config } = loadConfig(opts.config);
  const index = new DendriteIndex(config.index.db_path);
  try {
    const pack = recall(index.events, {
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
    });
    console.log(opts.json ? JSON.stringify(pack, null, 2) : pack.markdown);
  } finally {
    index.close();
  }
}

export async function runWho(name: string, opts: { config?: string; json?: boolean }): Promise<void> {
  const { config } = loadConfig(opts.config);
  const index = new DendriteIndex(config.index.db_path);
  try {
    const p = entityProfile(index.events, name);
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
