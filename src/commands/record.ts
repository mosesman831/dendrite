import { loadConfig } from "../config.js";
import { DendriteIndex } from "../pipeline/index.js";
import { ingestEvents, ingestOptionsFromConfig } from "../events/ingest.js";

export interface RecordOpts {
  config?: string;
  stream?: string;
  kind?: string;
  source?: string;
  at?: string;
  end?: string;
  data?: string;
  tag?: string[];
  entity?: string[];
  importance?: string;
  privacy?: "normal" | "sensitive" | "secret";
  id?: string;
  json?: boolean;
}

export async function runRecord(text: string | undefined, opts: RecordOpts): Promise<void> {
  const { config } = loadConfig(opts.config);
  const index = new DendriteIndex(config.index.db_path);
  let data: unknown;
  if (opts.data) {
    try {
      data = JSON.parse(opts.data);
    } catch {
      console.error("--data must be valid JSON");
      process.exit(1);
    }
  }
  const raw = {
    stream: opts.stream ?? "note",
    kind: opts.kind ?? "entry",
    source: opts.source ?? "cli",
    occurred_at: opts.at,
    ended_at: opts.end,
    external_id: opts.id,
    text,
    data,
    tags: opts.tag,
    entities: opts.entity,
    importance: opts.importance !== undefined ? Number(opts.importance) : undefined,
    privacy: opts.privacy,
  };
  const report = ingestEvents(index.events, [raw], ingestOptionsFromConfig(config));
  index.close();
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.accepted) {
    console.log(`Recorded ${raw.stream}/${raw.kind} → ${report.ids[0]}`);
  } else if (report.duplicates) {
    console.log("Duplicate — already recorded.");
  } else {
    console.error(`Rejected: ${report.rejected.map((r) => r.error).join("; ")}`);
  }
  if (report.rejected.length) process.exitCode = 1;
}
