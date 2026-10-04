import { createHash } from "node:crypto";
import type { EventStore } from "./store.js";
import type { EventRecord, PrivacyLevel } from "./types.js";
import { addDays, localDate } from "./time.js";

export interface LoopOptions {
  exclude?: string[];
  autoResolve?: boolean;
  timezone?: string;
}

export const LOOP_STATUSES = ["open", "snoozed", "done", "dropped"] as const;
export type LoopStatus = (typeof LOOP_STATUSES)[number];

export interface OpenLoop {
  id: string;
  event_id: string;
  text: string;
  due_date: string | null;
  status: LoopStatus;
  snooze_until: string | null;
  privacy: PrivacyLevel;
  stream: string;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
}

const CHECKBOX = /^\s*[-*]\s*\[ \]\s*(.{3,})$/gm;
const MARKER = /\b(?:todo|to-do|action item|task)\s*[:\-–]\s*([^\n.!?]{3,})/gi;
const PHRASE =
  /\b(remind me to|don'?t forget to|i need to|i have to|i must|i should|i'?ll|i will|gotta|need to|follow up (?:with|on))\s+([^\n.!?;]{3,})/gi;
// "I'll be there" / "I will see" — states, not commitments.
const NON_COMMIT = /^(be|see|let you know|try|probably|never|always|just|have a look)\b/i;
const DONE_WORD = /\b(done|finished|completed|did|sent|booked|paid|submitted|called|emailed|fixed|shipped)\b/i;

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function clean(t: string): string {
  return t.replace(/\s+/g, " ").replace(/[,\s]+$/, "").trim().slice(0, 200);
}

/** Resolve a relative due phrase inside `text` against the event's local date. */
export function parseDue(text: string, baseDate: string): string | null {
  const t = text.toLowerCase();
  const iso = t.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (iso) return iso[1]!;
  if (/\b(today|tonight|this evening)\b/.test(t)) return baseDate;
  if (/\btomorrow\b/.test(t)) return addDays(baseDate, 1);
  if (/\bnext week\b/.test(t)) return addDays(baseDate, 7);
  if (/\b(this|end of( the)?) week(end)?\b/.test(t)) {
    const dow = new Date(`${baseDate}T12:00:00Z`).getUTCDay();
    return addDays(baseDate, (5 - dow + 7) % 7);
  }
  const inN = t.match(/\bin (\d{1,3}) days?\b/);
  if (inN) return addDays(baseDate, Number(inN[1]));
  const wd = t.match(/\b(?:by|on|this|next|before)?\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (wd) {
    const target = WEEKDAYS.indexOf(wd[1]!);
    const dow = new Date(`${baseDate}T12:00:00Z`).getUTCDay();
    return addDays(baseDate, (target - dow + 7) % 7 || 7);
  }
  return null;
}

export function extractLoops(text: string | null, baseDate: string): Array<{ text: string; due: string | null }> {
  if (!text) return [];
  const out = new Map<string, { text: string; due: string | null }>();
  const add = (raw: string) => {
    const t = clean(raw);
    if (t.length < 3 || NON_COMMIT.test(t)) return;
    const k = t.toLowerCase();
    if (![...out.keys()].some((x) => x.includes(k) || k.includes(x))) out.set(k, { text: t, due: parseDue(t, baseDate) });
  };
  for (const m of text.matchAll(CHECKBOX)) add(m[1]!);
  for (const m of text.matchAll(MARKER)) add(m[1]!);
  for (const m of text.matchAll(PHRASE)) add(/^follow up/i.test(m[1]!) ? `${m[1]} ${m[2]}` : m[2]!);
  return [...out.values()];
}

const STOP = new Set(["today", "tonight", "tomorrow", "week", "next", "days", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "before", "the", "a", "an", "to", "and", "or", "of", "for", "with", "on", "in", "at", "my", "it", "this", "that", "by", "about", "i", "me", "just"]);
const tokens = (t: string) =>
  new Set(
    t
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );

const rowToLoop = (r: unknown) => r as OpenLoop;

export function trackLoops(store: EventStore, events: EventRecord[], o: LoopOptions): { created: number; resolved: number } {
  const exclude = new Set((o.exclude ?? []).map((s) => s.toLowerCase()));
  const ins = store.db.prepare(
    `INSERT OR IGNORE INTO open_loops(id, event_id, text, due_date, status, privacy, stream, created_at) VALUES (?, ?, ?, ?, 'open', ?, ?, ?)`,
  );
  let created = 0;
  let resolved = 0;
  for (const e of events) {
    if (e.privacy === "secret" || exclude.has(e.stream) || e.source.startsWith("trigger:")) continue;
    const base = localDate(e.occurred_at, o.timezone ?? "UTC");
    const found = extractLoops(e.text, base);
    for (const l of found) {
      const id = createHash("sha256").update(`${e.id}|${l.text.toLowerCase()}`).digest("hex").slice(0, 12);
      created += ins.run(id, e.id, l.text, l.due, e.privacy, e.stream, e.occurred_at).changes;
    }
    if (o.autoResolve !== false && !found.length && e.text && DONE_WORD.test(e.text)) resolved += autoResolve(store, e);
  }
  return { created, resolved };
}

/** Close the best-matching earlier open loop when an event reports it done. */
function autoResolve(store: EventStore, e: EventRecord): number {
  const said = tokens(e.text!);
  const open = store.db
    .prepare(`SELECT * FROM open_loops WHERE status IN ('open','snoozed') AND created_at <= ? AND event_id != ? ORDER BY created_at DESC LIMIT 200`)
    .all(e.occurred_at, e.id)
    .map(rowToLoop);
  let best: { id: string; score: number } | null = null;
  for (const l of open) {
    const lt = tokens(l.text);
    if (!lt.size) continue;
    let hit = 0;
    for (const w of lt) if (said.has(w) || [...said].some((x) => x.length > 3 && (x.startsWith(w) || w.startsWith(x)))) hit++;
    const score = hit / lt.size;
    if (hit >= Math.min(2, lt.size) && score >= 0.6 && (!best || score > best.score)) best = { id: l.id, score };
  }
  if (!best) return 0;
  return store.db
    .prepare(`UPDATE open_loops SET status = 'done', resolved_at = ?, resolved_by = ? WHERE id = ?`)
    .run(e.occurred_at, e.id, best.id).changes;
}

export function listLoops(
  store: EventStore,
  o: { status?: LoopStatus | "all" | "active"; maxPrivacy?: PrivacyLevel; limit?: number; now?: string } = {},
): OpenLoop[] {
  const now = o.now ?? new Date().toISOString();
  const lv = o.maxPrivacy === "normal" ? ["normal"] : ["normal", "sensitive"];
  const st = o.status ?? "active";
  const where = [`privacy IN (${lv.map(() => "?").join(",")})`];
  const args: unknown[] = [...lv];
  if (st === "active") (where.push(`(status = 'open' OR (status = 'snoozed' AND snooze_until <= ?))`), args.push(now));
  else if (st !== "all") (where.push(`status = ?`), args.push(st));
  return store.db
    .prepare(
      `SELECT * FROM open_loops WHERE ${where.join(" AND ")}
       ORDER BY CASE WHEN due_date IS NULL THEN 1 ELSE 0 END, due_date, created_at DESC LIMIT ?`,
    )
    .all(...args, Math.min(o.limit ?? 100, 1000))
    .map(rowToLoop);
}

export function getLoop(store: EventStore, id: string): OpenLoop | null {
  const r = store.db.prepare(`SELECT * FROM open_loops WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return r ? rowToLoop(r) : null;
}

export function setLoopStatus(store: EventStore, id: string, status: LoopStatus, snoozeUntil?: string): OpenLoop | null {
  if (status === "snoozed" && !snoozeUntil) throw new Error("snooze needs an until time");
  const done = status === "done" || status === "dropped";
  store.db
    .prepare(`UPDATE open_loops SET status = ?, snooze_until = ?, resolved_at = ?, resolved_by = ? WHERE id = ?`)
    .run(status, status === "snoozed" ? snoozeUntil : null, done ? new Date().toISOString() : null, done ? "manual" : null, id);
  return getLoop(store, id);
}

export function renderLoops(loops: OpenLoop[], today: string): string {
  if (!loops.length) return "_No open loops._";
  return loops
    .map((l) => {
      const box = l.status === "done" ? "[x]" : l.status === "dropped" ? "[-]" : "[ ]";
      const due = l.due_date ? ` (due ${l.due_date}${l.status === "open" && l.due_date < today ? ", **overdue**" : ""})` : "";
      return `- ${box} ${l.text}${due} · ${l.stream} ${l.created_at.slice(0, 10)} · \`${l.id}\``;
    })
    .join("\n");
}
