import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { CompartmentDef, CompartmentsFile } from "./types.js";
import { LlmBlockSchema, SttBlockSchema, parseLlmBlock, type LlmEndpoints, type SttConfig } from "./providers/types.js";

export type { LlmEndpoints, SttConfig };

export const ConfigSchema = z.object({
  vault: z.object({
    path: z.string(),
    compartments_file: z.string().default("compartments.yaml"),
    timezone: z.string().default("UTC"),
  }),
  providers: z.object({
    llm: LlmBlockSchema,
    stt: SttBlockSchema,
  }),
  classification: z.object({
    temperature: z.number().default(0),
    strong_match_threshold: z.number().default(0.72),
    weak_match_threshold: z.number().default(0.45),
    confidence: z.object({
      silent_above: z.number().default(0.75),
      confirm_below: z.number().default(0.5),
    }),
    split: z
      .object({
        enabled: z.boolean().default(true),
        bias: z.enum(["conservative", "aggressive"]).default("conservative"),
        max_segments: z.number().default(5),
        min_segment_confidence: z.number().default(0.5),
        short_circuit_chars: z.number().default(140),
        min_coverage: z.number().default(0.7),
      })
      .default({}),
  }),
  inputs: z.object({
    telegram: z
      .object({
        enabled: z.boolean().default(false),
        tokenEnv: z.string().default("TELEGRAM_BOT_TOKEN"),
        allowed_user_ids: z.array(z.number()).default([]),
        /** Mirror Telegram captures (text + voice transcripts) into the event log; see events.mirror_captures. */
        log_events: z.boolean().default(true),
      })
      .default({}),
    webhook: z
      .object({
        enabled: z.boolean().default(false),
        port: z.number().default(8787),
        tokenEnv: z.string().default("DENDRITE_WEBHOOK_TOKEN"),
      })
      .default({}),
    drop_folder: z
      .object({
        enabled: z.boolean().default(false),
        path: z.string().default("./inbox-drop"),
        poll_seconds: z.number().int().min(1).default(30),
      })
      .default({}),
    daily_prompt: z
      .object({
        enabled: z.boolean().default(false),
        cron: z.string().default("0 21 * * *"),
        skip_if_dumps_gte: z.number().default(3),
      })
      .default({}),
  }),
  pattern_engine: z
    .object({
      cron: z.string().default("0 9 * * MON"),
      recurrence_min_count: z.number().default(4),
    })
    .default({}),
  index: z.object({
    db_path: z.string(),
    sync_mode: z.enum(["scheduled", "watch"]).default("scheduled"),
    reindex_cron: z.string().default("0 4 * * *"),
    embeddings: z
      .object({
        enabled: z.boolean().default(false),
        baseURL: z.string().url().optional(),
        model: z.string().default("text-embedding-3-small"),
        apiKeyEnv: z.string().default("OPENAI_API_KEY"),
        hybrid_weight: z.number().min(0).max(1).default(0.4),
        /** Also embed event-log text for semantic recall (normal-privacy only unless events_include_sensitive). */
        events: z.boolean().default(true),
        events_include_sensitive: z.boolean().default(false),
        events_cron: z.string().default("*/10 * * * *"),
      })
      .default({}),
  }),
  repair: z
    .object({
      min_sections: z.number().default(3),
      max_title_relevance: z.number().default(0.34),
    })
    .default({}),
  retrieval: z
    .object({
      k: z.number().int().positive().default(8),
      max_context_chars: z.number().int().positive().default(6000),
      min_score: z.number().min(0).default(0),
    })
    .default({}),
  templates: z
    .object({
      enabled: z.boolean().default(true),
      dir: z.string().default("templates"),
    })
    .default({}),
  organization: z.enum(["folders", "flat"]).default("folders"),
  tasks: z.object({ render: z.enum(["frontmatter"]).default("frontmatter") }).default({}),
  dashboard: z
    .object({
      enabled: z.boolean().default(true),
      port: z.number().default(8788),
    })
    .default({}),
  queue: z
    .object({
      durable: z.boolean().default(true),
      max_concurrency: z.number().default(2),
      max_retries: z.number().default(5),
    })
    .default({}),
  events: z
    .object({
      enabled: z.boolean().default(true),
      max_batch: z.number().int().positive().default(1000),
      default_source: z.string().default("api"),
      /** Record every pipeline capture (Telegram, voice transcripts, /ingest webhook) in the event log before LLM processing. */
      mirror_captures: z.boolean().default(true),
      stream_weights: z.record(z.number().min(0).max(1)).default({}),
    })
    .default({}),
  privacy: z
    .object({
      redact_at_rest: z.boolean().default(true),
      rules: z.array(z.string()).default(["api_key", "bearer", "private_key", "credit_card"]),
      custom_rules: z.array(z.object({ name: z.string(), pattern: z.string() })).default([]),
      streams: z.record(z.enum(["normal", "sensitive", "secret"])).default({ health: "sensitive" }),
    })
    .default({}),
  digest: z
    .object({
      folder: z.string().default("journal/digests"),
      write_empty: z.boolean().default(false),
      narrate: z.boolean().default(false),
      narrate_sensitive: z.boolean().default(false),
      max_prompt_events: z.number().int().min(10).max(2000).default(300),
      /** If set, `serve` writes yesterday's digest on this schedule (e.g. "15 0 * * *"). */
      cron: z.string().default(""),
    })
    .default({}),
  brief: z
    .object({
      /** If set, `serve` sends the briefing to Telegram (allowed_user_ids) on this schedule, e.g. "0 7 * * *". */
      cron: z.string().default(""),
      agenda_streams: z.array(z.string()).default(["calendar"]),
      soon_days: z.number().int().min(0).max(30).default(3),
      lookback_years: z.number().int().min(0).max(30).default(5),
      include_sensitive: z.boolean().default(false),
    })
    .default({}),
  /** Recurring things to keep up; matched by full-text `query` (default: name). */
  habits: z
    .array(z.object({ name: z.string().min(1), query: z.string().optional(), stream: z.string().optional(), every_days: z.number().int().min(1).default(7) }))
    .default([]),
  /** Canonical entity → alternate spellings/nicknames, merged at ingest (`dendrite aliases --apply` backfills). */
  aliases: z.record(z.array(z.string())).default({}),
  /** Named geofences: geo events inside one gain the place as an entity + `at:<slug>` tag. */
  places: z
    .array(
      z.object({
        name: z.string().min(1),
        lat: z.number().min(-90).max(90),
        lon: z.number().min(-180).max(180),
        radius_m: z.number().positive().default(150),
        privacy: z.enum(["normal", "sensitive", "secret"]).optional(),
      }),
    )
    .default([]),
  /** Derive location/stay events from streamed points while `serve` runs. */
  stays: z
    .object({
      live: z.boolean().default(true),
      interval_min: z.number().int().min(1).default(15),
      lookback_hours: z.number().int().min(1).max(168).default(24),
      radius_m: z.number().positive().default(150),
      min_minutes: z.number().int().min(1).default(10),
    })
    .default({}),
  insights: z
    .object({
      /** If set, `serve` sends a period-over-period review to Telegram on this schedule, e.g. "0 18 * * 0" (Sunday 18:00). */
      cron: z.string().default(""),
      days: z.number().int().min(1).max(366).default(7),
      include_sensitive: z.boolean().default(false),
    })
    .default({}),
  retention: z
    .object({
      streams: z.record(z.string()).default({}),
      prune_cron: z.string().default("30 3 * * *"),
    })
    .default({}),
  loops: z
    .object({
      enabled: z.boolean().default(true),
      exclude_streams: z.array(z.string()).default(["browser", "location", "movement", "health", "fitness", "git"]),
      auto_resolve: z.boolean().default(true),
    })
    .default({}),
  triggers: z
    .array(
      z.object({
        name: z.string().regex(/^[\w.-]{1,64}$/),
        enabled: z.boolean().default(true),
        match: z
          .object({
            stream: z.array(z.string()).optional(),
            kind: z.array(z.string()).optional(),
            source: z.array(z.string()).optional(),
            entity: z.array(z.string()).optional(),
            text: z.string().optional(),
            min_importance: z.number().min(0).max(1).optional(),
          })
          .default({}),
        include_sensitive: z.boolean().default(false),
        cooldown_sec: z.number().int().nonnegative().default(0),
        webhook: z
          .object({
            url: z.string().url(),
            secret_env: z.string().optional(),
            timeout_ms: z.number().int().positive().default(10_000),
            retries: z.number().int().min(0).max(10).default(3),
          })
          .optional(),
        record: z
          .object({
            stream: z.string(),
            kind: z.string(),
            text: z.string().default("{{text}}"),
            tags: z.array(z.string()).default([]),
          })
          .optional(),
      }),
    )
    .default([]),
  mcp: z
    .object({
      allow_writes: z.boolean().default(false),
      include_sensitive: z.boolean().default(false),
    })
    .default({}),
  http: z
    .object({
      max_body: z.string().default("5mb"),
      rate_limit_per_min: z.number().int().nonnegative().default(600),
      api_keys: z
        .array(
          z.object({
            name: z.string(),
            tokenEnv: z.string(),
            scopes: z.array(z.enum(["read", "write", "admin"])).min(1).default(["read"]),
          }),
        )
        .default([]),
    })
    .default({}),
  voice: z.object({ keep_audio: z.boolean().default(false) }).default({}),
  replies: z.object({ mode: z.enum(["silent_high", "always", "digest"]).default("silent_high") }).default({}),
});

export type DendriteConfig = z.infer<typeof ConfigSchema>;

export type EmbeddingsConfig = {
  enabled: boolean;
  baseURL: string;
  model: string;
  apiKeyEnv: string;
  hybrid_weight: number;
};

export function resolveEmbeddingsConfig(
  config: DendriteConfig,
  llmPrimaryBaseUrl: string,
): EmbeddingsConfig {
  const emb = config.index.embeddings;
  return {
    enabled: emb.enabled,
    baseURL: emb.baseURL ?? llmPrimaryBaseUrl,
    model: emb.model,
    apiKeyEnv: emb.apiKeyEnv,
    hybrid_weight: emb.hybrid_weight,
  };
}

export interface ResolvedConfig {
  config: DendriteConfig;
  configDir: string;
  llm: LlmEndpoints;
}

function expandPath(p: string, baseDir: string): string {
  let out = p.replace(/^~(?=\/|$)/, homedir());
  if (!isAbsolute(out)) {
    out = resolve(baseDir, out);
  }
  return out;
}

/** Load .env into process.env (does not override existing vars). */
function loadDotEnv(dir: string): void {
  const envPath = join(dir, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

export function findConfigPath(explicit?: string): string {
  if (explicit) return resolve(explicit);
  const candidates = [
    join(process.cwd(), "dendrite.config.yaml"),
    join(homedir(), ".config", "dendrite", "dendrite.config.yaml"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0];
}

export function loadConfig(configPath?: string): ResolvedConfig {
  const resolved = findConfigPath(configPath);
  const configDir = dirname(resolved);
  loadDotEnv(configDir);
  loadDotEnv(process.cwd());
  if (!existsSync(resolved)) {
    throw new Error(`Config not found: ${resolved}. Run 'dendrite init' first.`);
  }
  const raw = parseYaml(readFileSync(resolved, "utf8"));
  const config = ConfigSchema.parse(raw);
  config.vault.path = expandPath(config.vault.path, configDir);
  config.inputs.drop_folder.path = expandPath(config.inputs.drop_folder.path, configDir);
  config.index.db_path = expandPath(config.index.db_path, configDir);
  const llm = parseLlmBlock(config.providers.llm);
  return { config, configDir, llm };
}

export function loadCompartments(config: DendriteConfig, configDir: string): CompartmentsFile {
  const compPath = isAbsolute(config.vault.compartments_file)
    ? config.vault.compartments_file
    : resolve(configDir, config.vault.compartments_file);
  if (!existsSync(compPath)) {
    throw new Error(`Compartments file not found: ${compPath}`);
  }
  const raw = parseYaml(readFileSync(compPath, "utf8")) as CompartmentsFile;
  if (!raw.compartments || !raw.inbox) {
    throw new Error("Invalid compartments.yaml: missing compartments or inbox");
  }
  return raw;
}

/** Resolve API key from env var name. Throws if env name is set but empty. */
export function resolveApiKey(envName?: string, required = true): string {
  if (!envName || envName === "NONE") return "";
  const key = process.env[envName];
  if (!key) {
    if (required) throw new Error(`Missing API key env var: ${envName}`);
    return "";
  }
  return key;
}

export function getCompartmentPath(
  compartments: CompartmentsFile,
  name: string,
): CompartmentDefWithName | null {
  if (name === "inbox") {
    return { name: "inbox", ...compartments.inbox };
  }
  const def = compartments.compartments[name];
  if (!def) return null;
  return { name, ...def };
}

export interface CompartmentDefWithName {
  name: string;
  path: string;
  description: string;
  examples?: string[];
  subdivide_by?: "entity";
  append_only?: boolean;
}

export function listCompartmentNames(compartments: CompartmentsFile): string[] {
  return [...Object.keys(compartments.compartments), "inbox"];
}
