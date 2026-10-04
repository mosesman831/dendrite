import { EventInputSchema, MAX_DATA_BYTES, MAX_TEXT_BYTES, type EventInput, type EventRecord, type IngestReport, type PrivacyLevel } from "./types.js";
import { normalizeTime } from "./time.js";
import { contentHash, eventId } from "./ids.js";
import {
  DEFAULT_STREAM_WEIGHTS,
  compileRedactRules,
  extractEntities,
  maxPrivacy,
  redactText,
  redactValue,
  scoreImportance,
  type RedactRule,
} from "./enrich.js";
import type { EventStore } from "./store.js";
import type { DendriteConfig } from "../config.js";

export interface IngestOptions {
  defaultSource: string;
  redactAtRest: boolean;
  rules: RedactRule[];
  streamPrivacy: Record<string, PrivacyLevel>;
  streamWeights: Record<string, number>;
  maxBatch: number;
  now?: () => Date;
}

export function ingestOptionsFromConfig(config: DendriteConfig): IngestOptions {
  return {
    defaultSource: config.events.default_source,
    redactAtRest: config.privacy.redact_at_rest,
    rules: compileRedactRules(config.privacy.rules, config.privacy.custom_rules),
    streamPrivacy: config.privacy.streams,
    streamWeights: { ...DEFAULT_STREAM_WEIGHTS, ...config.events.stream_weights },
    maxBatch: config.events.max_batch,
  };
}

export const DEFAULT_INGEST_OPTIONS: IngestOptions = {
  defaultSource: "api",
  redactAtRest: true,
  rules: compileRedactRules(["api_key", "bearer", "private_key", "credit_card"]),
  streamPrivacy: { health: "sensitive" },
  streamWeights: DEFAULT_STREAM_WEIGHTS,
  maxBatch: 1000,
};

function uniq(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    const t = x.trim();
    const k = t.toLowerCase();
    if (t && !seen.has(k)) {
      seen.add(k);
      out.push(t);
    }
  }
  return out;
}

/** Validate + normalize + enrich one raw event. Throws with a readable message on invalid input. */
export function prepareEvent(raw: unknown, opts: IngestOptions = DEFAULT_INGEST_OPTIONS): Omit<EventRecord, "distilled_at" | "note_path"> {
  const parsed = EventInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((i) => `${i.path.join(".") || "event"}: ${i.message}`).join("; "));
  }
  const e: EventInput = parsed.data;
  const now = (opts.now ?? (() => new Date()))();
  const occurred = e.occurred_at === undefined ? now.toISOString() : normalizeTime(e.occurred_at);
  if (!occurred) throw new Error(`occurred_at: unparseable timestamp ${JSON.stringify(e.occurred_at)}`);
  let ended: string | null = null;
  if (e.ended_at !== undefined) {
    ended = normalizeTime(e.ended_at);
    if (!ended) throw new Error(`ended_at: unparseable timestamp ${JSON.stringify(e.ended_at)}`);
    if (ended < occurred) throw new Error("ended_at must not be before occurred_at");
  }
  let text = e.text?.trim() ? e.text.replace(/\r\n/g, "\n") : null;
  if (text && Buffer.byteLength(text) > MAX_TEXT_BYTES) throw new Error(`text exceeds ${MAX_TEXT_BYTES} bytes`);
  let data = e.data;
  if (data !== undefined) {
    const size = Buffer.byteLength(JSON.stringify(data) ?? "");
    if (size > MAX_DATA_BYTES) throw new Error(`data exceeds ${MAX_DATA_BYTES} bytes`);
  }
  if (opts.redactAtRest && opts.rules.length) {
    if (text) text = redactText(text, opts.rules).text;
    if (data !== undefined) data = redactValue(data, opts.rules).value;
  }
  const auto = text ? extractEntities(text) : { entities: [], tags: [] };
  const entities = uniq([...(e.entities ?? []), ...auto.entities]).slice(0, 100);
  const tags = uniq([...(e.tags ?? []), ...auto.tags].map((t) => t.replace(/^#/, "").toLowerCase())).slice(0, 100);
  const stream = e.stream.toLowerCase();
  const streamDefault = opts.streamPrivacy[stream] ?? opts.streamPrivacy[stream.split(":")[0]] ?? "normal";
  const privacy = maxPrivacy(e.privacy ?? "normal", streamDefault);
  const kind = e.kind.toLowerCase();
  return {
    id: eventId(Date.parse(occurred)),
    stream,
    source: e.source ?? opts.defaultSource,
    kind,
    occurred_at: occurred,
    ended_at: ended,
    received_at: now.toISOString(),
    external_id: e.external_id ?? null,
    content_hash: contentHash({ stream, kind, occurred_at: occurred, text, data }),
    text,
    data: data ?? null,
    entities,
    tags,
    lat: e.lat ?? null,
    lon: e.lon ?? null,
    importance: scoreImportance({ stream, text: text ?? undefined, importance: e.importance }, opts.streamWeights),
    privacy,
  };
}

/** Ingest a batch of raw events. Never throws for per-event errors; reports them instead. */
export function ingestEvents(store: EventStore, raws: unknown[], opts: IngestOptions = DEFAULT_INGEST_OPTIONS): IngestReport {
  const report: IngestReport = { accepted: 0, duplicates: 0, rejected: [], ids: [] };
  if (raws.length > opts.maxBatch) {
    report.rejected.push({ index: -1, error: `batch exceeds max_batch (${opts.maxBatch})` });
    return report;
  }
  const tx = store.db.transaction(() => {
    raws.forEach((raw, index) => {
      try {
        const rec = prepareEvent(raw, opts);
        if (store.insert(rec) === "duplicate") report.duplicates++;
        else {
          report.accepted++;
          report.ids.push(rec.id);
        }
      } catch (err) {
        report.rejected.push({ index, error: err instanceof Error ? err.message : String(err) });
      }
    });
  });
  tx();
  return report;
}

/** Parse NDJSON text into raw objects; bad lines are returned as errors with 0-based line index. */
export function parseNdjson(text: string): { items: unknown[]; errors: Array<{ index: number; error: string }>; lineIndex: number[] } {
  const items: unknown[] = [];
  const lineIndex: number[] = [];
  const errors: Array<{ index: number; error: string }> = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    if (!t) return;
    try {
      items.push(JSON.parse(t));
      lineIndex.push(i);
    } catch {
      errors.push({ index: i, error: "invalid JSON" });
    }
  });
  return { items, errors, lineIndex };
}
