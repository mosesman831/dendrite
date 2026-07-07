import { z } from "zod";

export const DumpSourceSchema = z.enum([
  "telegram-text",
  "telegram-voice",
  "webhook",
  "email",
  "daily-cron",
  "cli",
]);
export type DumpSource = z.infer<typeof DumpSourceSchema>;

export interface Dump {
  id: string;
  source: DumpSource;
  receivedAt: string;
  text?: string;
  audioPath?: string;
  raw?: unknown;
  meta?: Record<string, unknown>;
}

export const ClassificationSchema = z.object({
  compartment: z.string(),
  durability: z.enum(["durable", "ephemeral"]).default("durable"),
  confidence: z.number().min(0).max(1),
  entities: z.array(z.string()),
  note_action: z.enum(["create_new", "append_existing"]),
  target_note: z.string().nullable(),
  links: z.array(z.string()).default([]),
  extracted: z.object({
    tasks: z.array(z.string()).default([]),
    dates: z.array(z.string()).default([]),
    people: z.array(z.string()).default([]),
    resources: z.array(z.string()).default([]),
  }),
  summary: z.string(),
  title: z.string(),
  tags: z.array(z.string()).default([]),
});
export type Classification = z.infer<typeof ClassificationSchema>;

export const SegmentSchema = ClassificationSchema.extend({
  text: z.string().min(1),
});
export type Segment = z.infer<typeof SegmentSchema>;

export const MultiClassificationSchema = z.object({
  segments: z.array(SegmentSchema).min(1),
});
export type MultiClassification = z.infer<typeof MultiClassificationSchema>;

export interface CompartmentDef {
  path: string;
  description: string;
  examples?: string[];
  subdivide_by?: "entity";
  append_only?: boolean;
}

export interface CompartmentsFile {
  version: number;
  compartments: Record<string, CompartmentDef>;
  inbox: CompartmentDef;
}

export interface ResolvedTarget {
  compartment: string;
  notePath: string;
  slug: string;
  action: "create_new" | "append_existing";
}

export interface PipelineResult {
  dumpId: string;
  notePath: string;
  compartment: string;
  confidence: number;
  tier: "silent" | "confirm" | "inbox";
  summary: string;
  transcript?: string;
  links: string[];
  created: boolean;
  duplicate?: boolean;
  parentDumpId?: string;
  segmentIndex?: number;
  siblingCount?: number;
}

export interface Correction {
  id: number;
  dump_id: string | null;
  text_excerpt: string;
  predicted_compartment: string;
  corrected_compartment: string;
  created_at: string;
}

export interface NoteRecord {
  path: string;
  compartment: string;
  title: string;
  entities: string[];
  tags: string[];
  summary: string;
  updated_at: string;
}

export interface SearchHit {
  path: string;
  title: string;
  snippet: string;
  score: number;
}

export const FRONTMATTER_CONTRACT = {
  version: 1,
  fields: {
    compartment: "string — routing target",
    title: "string — human-readable note title",
    created: "ISO8601 UTC",
    updated: "ISO8601 UTC",
    source: "dump source channel",
    confidence: "0.0-1.0 classifier confidence",
    entities: "string[] key nouns/concepts",
    tags: "string[] obsidian tags",
    links: 'string[] wikilink targets e.g. "[[note-slug]]"',
    dendrite_version: "schema version integer",
    tasks: "string[] extracted tasks (frontmatter only)",
    dates: "string[] ISO dates",
    people: "string[] @handles",
    resources: "string[] urls or titles",
    split_group: "string — parent dump id when capture was split into multiple notes",
  },
} as const;
