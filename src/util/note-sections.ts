/** Split note body on level-2 headings (## …). */
export function splitNoteSections(content: string): string[] {
  const parts = content.split(/\n(?=## )/);
  if (parts.length === 1) return [content];
  return parts;
}

export interface ParsedCaptureSection {
  header: string;
  source: string;
  receivedAt: string | null;
  body: string;
  raw: string;
}

const SECTION_RE =
  /^## (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) · via ([\w-]+)\n([\s\S]*)$/;

/** Parse dendrite capture sections (`## YYYY-MM-DD HH:MM · via source`). */
export function parseCaptureSections(content: string): ParsedCaptureSection[] {
  const sections = splitNoteSections(content);
  const out: ParsedCaptureSection[] = [];

  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed.startsWith("## ")) continue;
    const match = trimmed.match(SECTION_RE);
    if (!match) continue;
    const [, ts, source, body] = match;
    out.push({
      header: `## ${ts} · via ${source}`,
      source,
      receivedAt: ts ? new Date(ts.replace(" ", "T") + ":00Z").toISOString() : null,
      body: body.trim(),
      raw: section,
    });
  }
  return out;
}

export function countCaptureSections(content: string): number {
  return parseCaptureSections(content).length;
}

/** Rough token estimate: words × 1.3, or chars ÷ 4 when no word boundaries. */
export function estimateTokens(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length > 0) return Math.ceil(words.length * 1.3);
  return Math.ceil(trimmed.length / 4);
}

export const SUMMARY_AUTO_HEADING = "## Summary (auto)";

export function hasSummaryAutoBlock(content: string): boolean {
  return content.includes(SUMMARY_AUTO_HEADING);
}
