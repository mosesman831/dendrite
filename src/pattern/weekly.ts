import type { DendriteConfig } from "../config.js";
import type { PipelineContext } from "../pipeline/pipeline.js";
import { loadCompartments } from "../config.js";

export function runPatternScan(
  ctx: PipelineContext,
  config: DendriteConfig,
): string | null {
  const since = new Date();
  since.setDate(since.getDate() - 7);
  const sinceIso = since.toISOString();

  const entities = ctx.index.topEntitiesSince(sinceIso, 10);
  const minCount = config.pattern_engine.recurrence_min_count;
  const recurring = entities.filter((e) => e.count >= minCount);

  const recent = ctx.index.recentNotes(undefined, sinceIso, 50);
  const byCompartment = new Map<string, number>();
  for (const n of recent) {
    byCompartment.set(n.compartment, (byCompartment.get(n.compartment) ?? 0) + 1);
  }

  const lastDump = ctx.index.db
    .prepare(`SELECT received_at FROM dumps ORDER BY received_at DESC LIMIT 1`)
    .get() as { received_at: string } | undefined;

  const parts: string[] = ["**Weekly brain digest**\n"];

  if (recent.length === 0) {
    parts.push("You didn't log anything this week. What's happened since?");
    return parts.join("\n");
  }

  parts.push(`Logged **${recent.length}** notes this week:\n`);
  for (const [comp, count] of byCompartment) {
    parts.push(`- ${comp}: ${count}`);
  }

  if (recurring.length > 0) {
    parts.push("\n**Recurring topics:**");
    for (const r of recurring.slice(0, 5)) {
      parts.push(
        `- \`${r.entity}\` mentioned ${r.count}× — worth a dedicated note?`,
      );
    }
  }

  if (lastDump) {
    const daysSince =
      (Date.now() - new Date(lastDump.received_at).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince >= 3) {
      parts.push(`\nYou last dumped ${Math.floor(daysSince)} days ago.`);
    }
  }

  const { configDir } = ctx;
  if (configDir) {
    const compartments = loadCompartments(config, configDir);
    const compNames = new Set(Object.keys(compartments.compartments));
    for (const r of recurring) {
      if (!compNames.has(r.entity.toLowerCase().replace(/\s+/g, "-"))) {
        parts.push(
          `\nProposal: create a \`${r.entity}\` compartment? (You've logged it ${r.count}×)`,
        );
        break;
      }
    }
  }

  return parts.join("\n");
}
