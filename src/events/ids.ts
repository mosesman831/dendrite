import { createHash, randomBytes } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Time-sortable unique id (ULID-compatible layout: 10 time chars + 16 random). */
export function eventId(atMs = Date.now()): string {
  let t = Math.max(0, Math.floor(atMs));
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const rand = randomBytes(16);
  let r = "";
  for (let i = 0; i < 16; i++) r += CROCKFORD[rand[i] % 32];
  return time + r;
}

/** Deterministic JSON (sorted keys) for hashing. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function contentHash(parts: {
  stream: string;
  kind: string;
  occurred_at: string;
  text?: string | null;
  data?: unknown;
}): string {
  return sha256(
    canonicalJson({
      stream: parts.stream,
      kind: parts.kind,
      occurred_at: parts.occurred_at,
      text: parts.text ?? null,
      data: parts.data ?? null,
    }),
  );
}
