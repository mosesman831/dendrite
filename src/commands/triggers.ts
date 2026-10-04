import { loadConfig } from "../config.js";
import { DendriteIndex } from "../pipeline/index.js";
import { compileTriggers, matchTrigger } from "../events/triggers.js";
import { parseDuration } from "../events/retention.js";

/** Dry-run every configured trigger against recent history — nothing is sent or recorded. */
export async function runTriggersTest(opts: { config?: string; since?: string; limit?: string; json?: boolean }): Promise<void> {
  const { config } = loadConfig(opts.config);
  const triggers = compileTriggers(config.triggers);
  if (!triggers.length) {
    console.log("No enabled triggers (add `triggers:` to your config).");
    return;
  }
  const index = new DendriteIndex(config.index.db_path);
  try {
    const ms = parseDuration(opts.since ?? "7d");
    const from = ms ? new Date(Date.now() - ms).toISOString() : opts.since;
    const limit = Math.min(Number(opts.limit ?? 5000), 50_000);
    const hits: Record<string, Array<{ id: string; occurred_at: string; text: string | null }>> = {};
    let cursor: string | undefined;
    let seen = 0;
    do {
      const page = index.events.query({ from, maxPrivacy: "sensitive", limit: 500, cursor, order: "asc" });
      for (const e of page.events) {
        seen++;
        for (const t of triggers) if (matchTrigger(t, e)) (hits[t.cfg.name] ??= []).push({ id: e.id, occurred_at: e.occurred_at, text: e.text });
      }
      cursor = page.next_cursor ?? undefined;
    } while (cursor && seen < limit);
    if (opts.json) {
      console.log(JSON.stringify({ scanned: seen, hits }, null, 2));
      return;
    }
    console.log(`Scanned ${seen} event(s) since ${from}`);
    for (const t of triggers) {
      const h = hits[t.cfg.name] ?? [];
      const acts = [t.cfg.webhook && "webhook", t.cfg.record && "record"].filter(Boolean).join("+");
      console.log(`\n${t.cfg.name} (${acts}): ${h.length} match(es)`);
      for (const x of h.slice(0, 10)) console.log(`  ${x.occurred_at}  ${(x.text ?? "").slice(0, 100)}`);
      if (h.length > 10) console.log(`  … ${h.length - 10} more`);
    }
  } finally {
    index.close();
  }
}
