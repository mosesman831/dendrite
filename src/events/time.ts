/**
 * Normalize user/adapter-supplied timestamps to ISO-8601 UTC.
 * Accepts ISO strings (with or without offset), epoch seconds, epoch ms,
 * and numeric strings. Returns null when unparseable.
 */
export function normalizeTime(input: string | number | undefined | null): string | null {
  if (input === undefined || input === null || input === "") return null;
  let ms: number;
  if (typeof input === "number" || /^-?\d+(\.\d+)?$/.test(String(input).trim())) {
    const n = Number(input);
    if (!Number.isFinite(n)) return null;
    // < 1e11 → seconds (covers dates up to year 5138); otherwise ms.
    ms = Math.abs(n) < 1e11 ? n * 1000 : n;
  } else {
    const s = String(input).trim();
    // Treat "YYYY-MM-DD HH:MM[:SS]" (no zone) as UTC instead of local time.
    const naive = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s);
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(s);
    ms = Date.parse(naive ? `${s.replace(" ", "T")}Z` : dateOnly ? `${s}T00:00:00Z` : s);
  }
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const year = d.getUTCFullYear();
  if (year < 1900 || year > 2200) return null;
  return d.toISOString();
}

/** Calendar date (YYYY-MM-DD) of an ISO instant in an IANA timezone. */
export function localDate(iso: string, timezone = "UTC"): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Local HH:MM of an ISO instant in an IANA timezone. */
export function localTime(iso: string, timezone = "UTC"): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

/** Offset (ms) of timezone vs UTC at the given instant. */
function tzOffsetMs(at: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** UTC ISO range [start, end) covering a local calendar date in a timezone. */
export function dayRange(date: string, timezone = "UTC"): { from: string; to: string } {
  const [y, m, d] = date.split("-").map(Number);
  const startGuess = new Date(Date.UTC(y, m - 1, d));
  const start = new Date(startGuess.getTime() - tzOffsetMs(startGuess, timezone));
  const endGuess = new Date(Date.UTC(y, m - 1, d + 1));
  const end = new Date(endGuess.getTime() - tzOffsetMs(endGuess, timezone));
  return { from: start.toISOString(), to: end.toISOString() };
}

/** Add N days to a YYYY-MM-DD calendar date. */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** ISO week label, e.g. 2026-W40, for a YYYY-MM-DD date. */
export function isoWeek(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
