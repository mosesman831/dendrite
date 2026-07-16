#!/usr/bin/env node
import { Command } from "commander";
import { runDoctor } from "./commands/doctor.js";
import { runInit } from "./commands/init.js";
import { runIngest } from "./commands/ingest.js";
import { runServe } from "./commands/serve.js";
import { runReindex } from "./commands/reindex.js";
import { runInbox } from "./commands/inbox.js";
import { runPatternScan } from "./commands/pattern.js";
import { runBackfill } from "./commands/backfill.js";
import { runSort } from "./commands/sort.js";
import { runRemove } from "./commands/remove.js";
import { runMigrate } from "./commands/migrate.js";
import { runRepair } from "./commands/repair.js";
import { runEmbed } from "./commands/embed.js";
import { runAsk } from "./commands/ask.js";
import { runEval } from "./commands/eval.js";
import { runMerge } from "./commands/merge.js";
import { startMcpServer } from "./mcp/server.js";

const program = new Command();

program
  .name("dendrite")
  .description("Knowledge ingestion daemon for Obsidian vaults")
  .version("0.1.0");

program
  .command("init")
  .description("Interactive first-run setup wizard")
  .action(runInit);

program
  .command("doctor")
  .option("--stats", "Show local metrics")
  .option("--json", "Output machine-readable health JSON")
  .option("-c, --config <path>", "Config file path")
  .action(runDoctor);

program
  .command("ingest [text]")
  .description("Push a dump through the full pipeline")
  .option("-c, --config <path>", "Config file path")
  .option("-f, --file <path>", "Audio file to transcribe and ingest")
  .option("--dry-run", "Show target without writing")
  .action(runIngest);

program
  .command("serve")
  .description("Run all enabled input adapters and schedulers")
  .option("-c, --config <path>", "Config file path")
  .action(runServe);

program
  .command("ask [question]")
  .description("Answer a question using only your vault notes (read-only RAG)")
  .option("-c, --config <path>", "Config file path")
  .option("--compartment <name>", "Restrict retrieval to one compartment")
  .option("-k, --k <n>", "Number of notes to retrieve")
  .option("--json", "Output machine-readable JSON")
  .action(runAsk);

program
  .command("eval")
  .description("Run the golden classification dataset and report routing accuracy")
  .option("-c, --config <path>", "Config file path")
  .option("--limit <n>", "Only run the first N cases")
  .option("--min <ratio>", "Exit non-zero if accuracy is below this ratio (e.g. 0.7)")
  .option("--dataset <path>", "Path to a JSONL dataset (default: eval/dataset.jsonl)")
  .option("--json", "Output machine-readable JSON")
  .action(runEval);

program
  .command("mcp")
  .description("Run the MCP read-server (stdio)")
  .option("-c, --config <path>", "Config file path")
  .action((opts: { config?: string }) => startMcpServer(opts.config));

program
  .command("reindex")
  .description("Rebuild SQLite index from the vault")
  .option("-c, --config <path>", "Config file path")
  .action(runReindex);

program
  .command("inbox")
  .description("List unfiled inbox items")
  .option("-c, --config <path>", "Config file path")
  .action(runInbox);

program
  .command("backfill")
  .description("Classify and file existing vault notes that Dendrite did not create")
  .option("-c, --config <path>", "Config file path")
  .option("--dry-run", "Preview targets without writing")
  .option("--keep-source", "Do not archive original files after filing")
  .action(async (opts: { config?: string; dryRun?: boolean; keepSource?: boolean }) => {
    await runBackfill({ config: opts.config, dryRun: opts.dryRun, move: !opts.keepSource });
  });

program
  .command("sort")
  .description("LLM-sort inbox + unfiled notes into dendrite-ready brain compartments")
  .option("-c, --config <path>", "Config file path")
  .option("--dry-run", "Preview targets without writing")
  .option("--keep-source", "Do not archive originals after filing")
  .option("--inbox-only", "Only re-file notes in brain/inbox/")
  .option("--imports-only", "Only file vault-root / scratch notes (skip inbox)")
  .action(
    async (opts: {
      config?: string;
      dryRun?: boolean;
      keepSource?: boolean;
      inboxOnly?: boolean;
      importsOnly?: boolean;
    }) => {
      const scope = opts.inboxOnly ? "inbox" : opts.importsOnly ? "imports" : "all";
      await runSort({
        config: opts.config,
        dryRun: opts.dryRun,
        keepSource: opts.keepSource,
        scope,
      });
    },
  );

program
  .command("remove")
  .description("Undo a capture (soft: remove section or move note to inbox)")
  .option("-c, --config <path>", "Config file path")
  .option("--last", "Undo the most recent capture")
  .option("--id <dumpId>", "Undo a specific dump id (or parent id)")
  .option("--note <path>", "Undo the last dump that wrote to this note path")
  .action(async (opts: { config?: string; last?: boolean; id?: string; note?: string }) => {
    if (!opts.last && !opts.id && !opts.note) {
      console.error("Specify --last, --id <dumpId>, or --note <path>");
      process.exit(1);
    }
    await runRemove(opts);
  });

program
  .command("pattern-scan")
  .description("Run the weekly pattern engine now")
  .option("-c, --config <path>", "Config file path")
  .action(runPatternScan);

program
  .command("migrate")
  .description("Upgrade note frontmatter to current dendrite_version (idempotent)")
  .option("-c, --config <path>", "Config file path")
  .option("--dry-run", "Preview migrations without writing")
  .option("--to-flat", "Relocate compartment notes to brain/<slug>.md (flat layout)")
  .option("--to-folders", "Relocate flat brain/*.md notes into compartment folders")
  .action(
    async (opts: { config?: string; dryRun?: boolean; toFlat?: boolean; toFolders?: boolean }) => {
      await runMigrate({
        config: opts.config,
        dryRun: opts.dryRun,
        toFlat: opts.toFlat,
        toFolders: opts.toFolders,
      });
    },
  );

program
  .command("repair")
  .description("Detect and split junk-drawer notes with unrelated appended sections")
  .option("-c, --config <path>", "Config file path")
  .option("--dry-run", "Preview repairs without writing")
  .option("--note <path>", "Repair a specific note path only")
  .option("--min-sections <n>", "Minimum capture sections to flag", "3")
  .action(
    async (opts: { config?: string; dryRun?: boolean; note?: string; minSections?: string }) => {
      await runRepair({
        config: opts.config,
        dryRun: opts.dryRun,
        notePath: opts.note,
        minSections: opts.minSections ? Number(opts.minSections) : undefined,
      });
    },
  );

program
  .command("embed")
  .description("Build embedding vectors for hybrid semantic search")
  .option("-c, --config <path>", "Config file path")
  .option("--force", "Rebuild all embeddings")
  .action(async (opts: { config?: string; force?: boolean }) => {
    await runEmbed({ config: opts.config, force: opts.force });
  });

program
  .command("merge <pathA> <pathB>")
  .description("Merge two notes into one (merge-back correction)")
  .option("-c, --config <path>", "Config file path")
  .option("--into <target>", "Survivor note: A or B", "A")
  .option("--dry-run", "Preview merge without writing")
  .action(
    async (
      pathA: string,
      pathB: string,
      opts: { config?: string; into?: string; dryRun?: boolean },
    ) => {
      const into = opts.into?.toUpperCase() === "B" ? "B" : "A";
      await runMerge({
        config: opts.config,
        pathA,
        pathB,
        into,
        dryRun: opts.dryRun,
      });
    },
  );

program.parse();
