import { z } from "zod";

export const PRIVACY_LEVELS = ["normal", "sensitive", "secret"] as const;
export type PrivacyLevel = (typeof PRIVACY_LEVELS)[number];

export const MAX_TEXT_BYTES = 64 * 1024;
export const MAX_DATA_BYTES = 256 * 1024;

const TimeInput = z.union([z.string(), z.number()]);

/** Producers (and our own export) often send explicit nulls; treat them as absent. */
const stripNulls = (v: unknown) =>
  v && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(
        Object.entries(v as Record<string, unknown>).filter(
          ([, x]) => x !== null,
        ),
      )
    : v;

export const EventInputSchema = z.preprocess(
  stripNulls,
  z
    .object({
      stream: z
        .string()
        .min(1)
        .max(64)
        .regex(
          /^[a-z0-9][a-z0-9_.:-]*$/i,
          "stream must be alphanumeric with _ . : -",
        ),
      kind: z
        .string()
        .min(1)
        .max(64)
        .regex(
          /^[a-z0-9][a-z0-9_.:-]*$/i,
          "kind must be alphanumeric with _ . : -",
        ),
      source: z.string().min(1).max(128).optional(),
      occurred_at: TimeInput.optional(),
      ended_at: TimeInput.optional(),
      external_id: z.string().min(1).max(256).optional(),
      text: z.string().optional(),
      data: z.unknown().optional(),
      entities: z.array(z.string().max(200)).max(100).optional(),
      tags: z.array(z.string().max(100)).max(100).optional(),
      lat: z.number().min(-90).max(90).optional(),
      lon: z.number().min(-180).max(180).optional(),
      importance: z.number().min(0).max(1).optional(),
      privacy: z.enum(PRIVACY_LEVELS).optional(),
    })
    .refine(
      (e) => (e.text && e.text.trim().length > 0) || e.data !== undefined,
      {
        message: "event requires text or data",
      },
    ),
);

export type EventInput = z.infer<typeof EventInputSchema>;

export interface EventRecord {
  id: string;
  stream: string;
  source: string;
  kind: string;
  occurred_at: string;
  ended_at: string | null;
  received_at: string;
  external_id: string | null;
  content_hash: string;
  text: string | null;
  data: unknown;
  entities: string[];
  tags: string[];
  lat: number | null;
  lon: number | null;
  importance: number;
  privacy: PrivacyLevel;
  distilled_at: string | null;
  note_path: string | null;
}

export interface IngestReport {
  accepted: number;
  duplicates: number;
  /** Existing events rewritten in place (only with `IngestOptions.upsert`). */
  updated?: number;
  rejected: Array<{ index: number; error: string }>;
  ids: string[];
}

export interface EventQuery {
  from?: string;
  to?: string;
  stream?: string | string[];
  kind?: string;
  source?: string;
  entity?: string;
  q?: string;
  minImportance?: number;
  maxPrivacy?: PrivacyLevel;
  limit?: number;
  cursor?: string;
  order?: "asc" | "desc";
}

export interface EventPage {
  events: EventRecord[];
  next_cursor: string | null;
}

export interface StreamSummary {
  stream: string;
  count: number;
  first_at: string;
  last_at: string;
  kinds: string[];
}
