import type { EventInput, PrivacyLevel } from "./types.js";

export interface RedactRule {
  name: string;
  pattern: RegExp;
}

export const BUILTIN_REDACT_RULES: Record<string, RegExp> = {
  api_key:
    /\b(?:sk-[A-Za-z0-9_-]{16,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{30,}|gh[osu]_[A-Za-z0-9]{30,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|nvapi-[A-Za-z0-9_-]{20,})\b/g,
  bearer: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g,
  private_key: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  credit_card: /\b(?:\d[ -]?){13,19}\b/g,
  email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  phone: /(?<![\w])\+?\d{1,3}[ .-]?\(?\d{2,4}\)?[ .-]?\d{3,4}[ .-]?\d{3,4}(?![\w])/g,
  ip: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
};

function luhnValid(digits: string): boolean {
  const d = digits.replace(/\D/g, "");
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = d.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export function compileRedactRules(names: string[], custom: Array<{ name: string; pattern: string }> = []): RedactRule[] {
  const rules: RedactRule[] = [];
  for (const n of names) {
    const p = BUILTIN_REDACT_RULES[n];
    if (p) rules.push({ name: n, pattern: new RegExp(p.source, p.flags) });
  }
  for (const c of custom) {
    try {
      rules.push({ name: c.name, pattern: new RegExp(c.pattern, "g") });
    } catch {
      /* invalid custom regex — skip */
    }
  }
  return rules;
}

export function redactText(text: string, rules: RedactRule[]): { text: string; redactions: number } {
  let out = text;
  let count = 0;
  for (const rule of rules) {
    out = out.replace(rule.pattern, (match) => {
      if (rule.name === "credit_card" && !luhnValid(match)) return match;
      count++;
      return `[REDACTED:${rule.name}]`;
    });
  }
  return { text: out, redactions: count };
}

/** Recursively redact string leaves of a JSON value. */
export function redactValue(value: unknown, rules: RedactRule[]): { value: unknown; redactions: number } {
  let total = 0;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const r = redactText(v, rules);
      total += r.redactions;
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  const value2 = walk(value);
  return { value: value2, redactions: total };
}

const STOP_CAPS = new Set([
  "I", "The", "A", "An", "And", "But", "Or", "So", "Then", "Today", "Tomorrow", "Yesterday",
  "This", "That", "These", "Those", "It", "We", "You", "He", "She", "They", "My", "Our",
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
  "January", "February", "March", "April", "May", "June", "July", "August", "September",
  "October", "November", "December", "TIL", "OK", "Ok", "Also", "Just", "If", "When", "What",
  "Why", "How", "Where", "Who", "Remember", "Note", "Hi", "Hey", "Yes", "No", "In", "On", "At",
  "Met", "See", "Saw", "Got", "Had", "Went", "Called", "Told", "Asked", "Spoke", "Talked", "After",
  "Before", "Later", "Now", "Please", "Thanks", "Lunch", "Dinner", "Breakfast", "With", "For", "From",
  "Good", "Great", "Bad", "Live", "Remind", "Stayed", "TODO", "Todo", "FIXME", "Need", "Finally", "Done", "Booked", "Finished", "Call", "Called", "Calling", "Met", "Meeting", "Lunch", "Dinner", "Breakfast", "Coffee", "Chat", "Talked", "Spoke", "Sent", "Emailed", "Texted", "Weekly", "Daily",
  "Don", "Didn", "Can", "Will", "Should", "Must", "Let", "Maybe", "Still", "Back", "Left", "Arrived", "Started",
]);

/** Cheap deterministic entity extraction: @handles, #tags, URLs → domains, proper-noun runs. */
export function extractEntities(text: string): { entities: string[]; tags: string[] } {
  const entities = new Set<string>();
  const tags = new Set<string>();
  for (const m of text.matchAll(/(?<![\w@])@([A-Za-z0-9_]{2,32})/g)) entities.add(`@${m[1]}`);
  for (const m of text.matchAll(/(?<![\w#&])#([A-Za-z][\w/-]{1,40})/g)) tags.add(m[1].toLowerCase());
  for (const m of text.matchAll(/https?:\/\/([^/\s?#]+)/gi)) {
    entities.add(m[1].toLowerCase().replace(/^www\./, ""));
  }
  const stripped = text.replace(/https?:\/\/\S+/gi, " ");
  for (const sentence of stripped.split(/(?<=[.!?\n])\s+/)) {
    const words = sentence.split(/\s+/);
    let run: string[] = [];
    const flush = () => {
      while (run.length && STOP_CAPS.has(run[0])) run.shift();
      if (run.length) {
        const name = run.join(" ").replace(/[^\p{L}\p{N} .'&-]/gu, "").trim();
        if (name.length >= 3 && !STOP_CAPS.has(name)) entities.add(name);
      }
      run = [];
    };
    words.forEach((raw, i) => {
      const w = raw.replace(/^[("'[]+|[)"'\],.;:!?]+$/g, "");
      const isCap = /^\p{Lu}[\p{L}\p{N}'&.-]*$/u.test(w) && !/^[\p{Lu}]{1}$/u.test(w);
      if (isCap && !(i === 0 && STOP_CAPS.has(w))) run.push(w);
      else flush();
      if (/[,.;:!?)]$/.test(raw)) flush();
    });
    flush();
  }
  return { entities: [...entities].slice(0, 50), tags: [...tags].slice(0, 50) };
}

const SALIENT = /\b(decided|decision|remember|important|deadline|promise[ds]?|never|always|diagnos\w*|born|died|married|engaged|hired|fired|quit|moved|signed|launched|shipped|accepted|rejected|birthday|anniversary|password|urgent|todo|must)\b/i;

export const DEFAULT_STREAM_WEIGHTS: Record<string, number> = {
  note: 0.7,
  chat: 0.5,
  email: 0.45,
  calendar: 0.55,
  git: 0.45,
  health: 0.3,
  location: 0.25,
  browser: 0.2,
  sensor: 0.15,
  files: 0.35,
  feed: 0.25,
};

/** 0..1 salience estimate used for promotion/digests. */
export function scoreImportance(e: Pick<EventInput, "stream" | "text" | "importance">, weights = DEFAULT_STREAM_WEIGHTS): number {
  if (typeof e.importance === "number") return clamp01(e.importance);
  const base = weights[e.stream] ?? weights[e.stream.split(":")[0]] ?? 0.4;
  let score = base;
  const text = e.text ?? "";
  if (SALIENT.test(text)) score += 0.2;
  if (text.length > 280) score += 0.05;
  if (text.length > 1200) score += 0.05;
  if (/!{2,}/.test(text)) score += 0.05;
  return clamp01(Math.round(score * 100) / 100);
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

const PRIVACY_RANK: Record<PrivacyLevel, number> = { normal: 0, sensitive: 1, secret: 2 };

export function privacyRank(p: PrivacyLevel): number {
  return PRIVACY_RANK[p] ?? 0;
}

export function maxPrivacy(a: PrivacyLevel, b: PrivacyLevel): PrivacyLevel {
  return privacyRank(a) >= privacyRank(b) ? a : b;
}
