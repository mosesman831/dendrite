import { execFileSync } from "node:child_process";
import { extname } from "node:path";
import { parseNdjson } from "./ingest.js";
import { isTakeoutLocation, parseTakeoutLocation } from "./importers-life.js";

export const IMPORT_FORMATS = ["json", "ndjson", "ics", "gpx", "csv", "git", "apple-health", "takeout-location"] as const;
export type ImportFormat = (typeof IMPORT_FORMATS)[number];

export interface ImportOptions {
  /** gpx/takeout: also emit location/stay events derived from points. */
  stays?: boolean;
  stream?: string;
  kind?: string;
  source?: string;
  /** GPX: minimum seconds between kept trackpoints. */
  minIntervalSec?: number;
  /** git: max commits. */
  limit?: number;
}

export interface ParsedImport {
  items: unknown[];
  errors: Array<{ index: number; error: string }>;
}

export function detectFormat(path: string, content?: string): ImportFormat {
  const ext = extname(path).toLowerCase();
  if (ext === ".ics" || ext === ".ical") return "ics";
  if (ext === ".gpx") return "gpx";
  if (ext === ".csv") return "csv";
  if (ext === ".xml" && (content === undefined || /<HealthData\b/.test(content.slice(0, 4096)))) return "apple-health";
  if (ext === ".ndjson" || ext === ".jsonl") return "ndjson";
  if (ext === ".json") return "json";
  if (!ext && content === undefined) return "git";
  const head = content?.trimStart().slice(0, 200) ?? "";
  if (head.startsWith("BEGIN:VCALENDAR")) return "ics";
  if (/<HealthData\b/.test(content?.slice(0, 4096) ?? "")) return "apple-health";
  if (head.startsWith("<?xml") || head.startsWith("<gpx")) return "gpx";
  if (head.startsWith("[") || (head.startsWith("{") && !head.includes("}\n{"))) return "json";
  return "ndjson";
}

// ---------- JSON ----------
export function parseJsonImport(text: string): ParsedImport {
  const parsed = JSON.parse(text) as unknown;
  const items = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { events?: unknown[] }).events)
      ? (parsed as { events: unknown[] }).events
      : [parsed];
  return { items, errors: [] };
}

// ---------- ICS ----------
function unfoldIcs(text: string): string[] {
  return text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
}

function unescapeIcs(v: string): string {
  return v.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
}

/** ICS date/time → ISO. Floating/TZID times are treated as UTC (best effort, documented). */
export function icsTime(value: string): string | null {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h = "00", mi = "00", s = "00"] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}.000Z`;
}

export function parseIcs(text: string, opts: ImportOptions = {}): ParsedImport {
  const items: unknown[] = [];
  const errors: ParsedImport["errors"] = [];
  let cur: Record<string, { value: string; params: string }> | null = null;
  let n = 0;
  for (const line of unfoldIcs(text)) {
    if (line === "BEGIN:VEVENT") {
      cur = {};
      continue;
    }
    if (line === "END:VEVENT" && cur) {
      const idx = n++;
      const start = cur.DTSTART ? icsTime(cur.DTSTART.value) : null;
      if (!start) {
        errors.push({ index: idx, error: "VEVENT missing/invalid DTSTART" });
        cur = null;
        continue;
      }
      const end = cur.DTEND ? icsTime(cur.DTEND.value) : null;
      const summary = cur.SUMMARY ? unescapeIcs(cur.SUMMARY.value) : "(untitled event)";
      const location = cur.LOCATION ? unescapeIcs(cur.LOCATION.value) : undefined;
      const description = cur.DESCRIPTION ? unescapeIcs(cur.DESCRIPTION.value) : undefined;
      const allDay = /VALUE=DATE(?!-)/.test(cur.DTSTART.params) || /^\d{8}$/.test(cur.DTSTART.value);
      items.push({
        stream: opts.stream ?? "calendar",
        kind: opts.kind ?? "event",
        source: opts.source ?? "ics",
        occurred_at: start,
        ended_at: end && end >= start ? end : undefined,
        external_id: cur.UID?.value ? `${cur.UID.value}${cur["RECURRENCE-ID"] ? `@${cur["RECURRENCE-ID"].value}` : ""}` : undefined,
        text: [summary, location ? `@ ${location}` : "", description ?? ""].filter(Boolean).join(" — ").slice(0, 4000),
        data: {
          summary,
          location,
          all_day: allDay || undefined,
          status: cur.STATUS?.value,
          organizer: cur.ORGANIZER?.value?.replace(/^mailto:/i, ""),
          rrule: cur.RRULE?.value,
        },
      });
      cur = null;
      continue;
    }
    if (!cur) continue;
    const m = line.match(/^([A-Z-]+)((?:;[^:]*)?):(.*)$/);
    if (m && !(m[1] in cur)) cur[m[1]] = { params: m[2], value: m[3] };
  }
  return { items, errors };
}

// ---------- GPX ----------
function attr(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`))?.[1];
}
function child(body: string, name: string): string | undefined {
  return body.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim();
}

export function parseGpx(text: string, opts: ImportOptions = {}): ParsedImport {
  const items: unknown[] = [];
  const errors: ParsedImport["errors"] = [];
  const minMs = (opts.minIntervalSec ?? 60) * 1000;
  let lastKept = -Infinity;
  let i = 0;
  const re = /<(trkpt|wpt|rtept)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g;
  for (const m of text.matchAll(re)) {
    const idx = i++;
    const [, tag, attrs, body = ""] = m;
    const lat = Number(attr(attrs, "lat"));
    const lon = Number(attr(attrs, "lon"));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      errors.push({ index: idx, error: `${tag}: invalid lat/lon` });
      continue;
    }
    const time = child(body, "time");
    if (tag === "trkpt") {
      if (!time) continue;
      const t = Date.parse(time);
      if (!Number.isFinite(t) || t - lastKept < minMs) continue;
      lastKept = t;
    }
    const ele = child(body, "ele");
    const name = child(body, "name");
    items.push({
      stream: opts.stream ?? "location",
      kind: opts.kind ?? (tag === "trkpt" ? "point" : "waypoint"),
      source: opts.source ?? "gpx",
      occurred_at: time,
      lat,
      lon,
      text: name,
      data: { lat, lon, ele: ele !== undefined ? Number(ele) : undefined },
    });
  }
  return { items, errors };
}

// ---------- CSV ----------
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}

const TIME_COLS = ["occurred_at", "timestamp", "time", "datetime", "date", "start", "start_time", "startdate"];
const TEXT_COLS = ["text", "note", "description", "message", "title", "summary"];

export function parseCsv(text: string, opts: ImportOptions = {}): ParsedImport {
  const rows = parseCsvRows(text.replace(/^\uFEFF/, ""));
  const items: unknown[] = [];
  const errors: ParsedImport["errors"] = [];
  if (!rows.length) return { items, errors };
  const header = rows[0].map((h) => h.trim());
  const lower = header.map((h) => h.toLowerCase().replace(/\s+/g, "_"));
  const ti = lower.findIndex((h) => TIME_COLS.includes(h));
  if (ti < 0) return { items, errors: [{ index: 0, error: `no time column (one of ${TIME_COLS.join(", ")})` }] };
  const endI = lower.findIndex((h) => ["ended_at", "end", "end_time", "enddate"].includes(h));
  const textI = lower.findIndex((h) => TEXT_COLS.includes(h));
  const idI = lower.findIndex((h) => ["id", "external_id", "uuid"].includes(h));
  const streamI = lower.indexOf("stream");
  const kindI = lower.findIndex((h) => h === "kind" || h === "type");
  const latI = lower.findIndex((h) => h === "lat" || h === "latitude");
  const lonI = lower.findIndex((h) => h === "lon" || h === "lng" || h === "longitude");
  const reserved = new Set([ti, endI, textI, idI, streamI, kindI].filter((x) => x >= 0));
  rows.slice(1).forEach((r, k) => {
    const data: Record<string, unknown> = {};
    lower.forEach((h, j) => {
      if (reserved.has(j) || r[j] === undefined || r[j] === "") return;
      const v = r[j].trim();
      const num = Number(v);
      data[h] = v !== "" && Number.isFinite(num) && /^-?[\d.]+(e-?\d+)?$/i.test(v) ? num : v;
    });
    const textVal = textI >= 0 ? r[textI]?.trim() : undefined;
    if (!textVal && !Object.keys(data).length) {
      errors.push({ index: k + 1, error: "empty row" });
      return;
    }
    const lat = latI >= 0 ? Number(r[latI]) : NaN;
    const lon = lonI >= 0 ? Number(r[lonI]) : NaN;
    items.push({
      stream: (streamI >= 0 && r[streamI]?.trim()) || opts.stream || "csv",
      kind: (kindI >= 0 && r[kindI]?.trim()) || opts.kind || "row",
      source: opts.source ?? "csv",
      occurred_at: r[ti]?.trim(),
      ended_at: endI >= 0 && r[endI]?.trim() ? r[endI].trim() : undefined,
      external_id: idI >= 0 && r[idI]?.trim() ? r[idI].trim() : undefined,
      text: textVal || undefined,
      data: Object.keys(data).length ? data : undefined,
      lat: Number.isFinite(lat) ? lat : undefined,
      lon: Number.isFinite(lon) ? lon : undefined,
    });
  });
  return { items, errors };
}

// ---------- git ----------
const SEP = "\u001f";
const REC = "\u001e";

export function parseGitLog(out: string, repoName: string, opts: ImportOptions = {}): ParsedImport {
  const items: unknown[] = [];
  for (const rec of out.split(REC)) {
    const t = rec.replace(/^\s+/, "");
    if (!t) continue;
    const [sha, author, email, date, subject, body = ""] = t.split(SEP);
    if (!sha || !date) continue;
    items.push({
      stream: opts.stream ?? "git",
      kind: opts.kind ?? "commit",
      source: opts.source ?? `git:${repoName}`,
      occurred_at: date,
      external_id: sha,
      text: `${repoName}: ${subject}${body.trim() ? `\n\n${body.trim()}` : ""}`.slice(0, 8000),
      data: { repo: repoName, sha, author, email, subject },
      entities: [repoName],
    });
  }
  return { items, errors: [] };
}

export function readGitLog(repoPath: string, opts: ImportOptions = {}): ParsedImport {
  const out = execFileSync(
    "git",
    ["-C", repoPath, "log", `--max-count=${opts.limit ?? 5000}`, `--format=${REC}%H${SEP}%an${SEP}%ae${SEP}%aI${SEP}%s${SEP}%b`],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  const name =
    execFileSync("git", ["-C", repoPath, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim().split(/[\\/]/).pop() ??
    "repo";
  return parseGitLog(out, name, opts);
}

export function parseImport(format: ImportFormat, content: string, opts: ImportOptions = {}): ParsedImport {
  switch (format) {
    case "json": {
      const j = JSON.parse(content) as unknown;
      if (isTakeoutLocation(j)) return parseTakeoutLocation(j, opts);
      return parseJsonImport(content);
    }
    case "takeout-location":
      return parseTakeoutLocation(JSON.parse(content), opts);
    case "apple-health":
      throw new Error("apple-health is streamed; use importPath");
    case "ndjson": {
      const r = parseNdjson(content);
      return { items: r.items, errors: r.errors };
    }
    case "ics":
      return parseIcs(content, opts);
    case "gpx":
      return parseGpx(content, opts);
    case "csv":
      return parseCsv(content, opts);
    case "git":
      throw new Error("git format reads a repository path; use readGitLog");
  }
}
