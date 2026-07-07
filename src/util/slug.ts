export function slugify(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "note";
}

export function wikilink(slug: string): string {
  const clean = slug.replace(/\.md$/i, "").replace(/^\[\[|\]\]$/g, "");
  return `[[${clean}]]`;
}

export function parseWikilink(link: string): string {
  return link.replace(/^\[\[/, "").replace(/\]\]$/, "").replace(/\.md$/i, "");
}

export function hashId(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (Math.imul(31, h) + input.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}
