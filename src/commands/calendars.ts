import { loadConfig } from "../config.js";
import { DendriteIndex } from "../pipeline/index.js";
import { syncCalendar } from "../events/calendars.js";
import { ingestOptionsFromConfig } from "../events/ingest.js";

export async function runCalendarSync(opts: { config?: string; json?: boolean }): Promise<void> {
  const { config } = loadConfig(opts.config);
  if (!config.calendars.length) {
    console.log("No calendars configured. Add `calendars: [{ name, url_env }]` to the config.");
    return;
  }
  const index = new DendriteIndex(config.index.db_path);
  try {
    const out = [];
    for (const c of config.calendars) out.push(await syncCalendar(index.events, c, ingestOptionsFromConfig(config)));
    if (opts.json) console.log(JSON.stringify(out, null, 2));
    else for (const r of out) console.log(r.ok ? `${r.name}: ${r.events} events, +${r.accepted} new` : `${r.name}: FAILED — ${r.error}`);
    if (out.some((r) => !r.ok)) process.exitCode = 1;
  } finally {
    index.close();
  }
}
