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
import { startMcpServer } from "./mcp/server.js";
import { runRecord } from "./commands/record.js";
import { runTimeline, runDigest } from "./commands/timeline.js";
import { runImport } from "./commands/import.js";
import { runRecall, runWho } from "./commands/recall.js";
import { runPrune, runExport, runBackup } from "./commands/ops.js";

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

const collect = (v: string, prev: string[] = []) => [...prev, v];

program
  .command("record [text]")
  .description("Append a raw life event to the event log (no LLM; lossless)")
  .option("-c, --config <path>", "Config file path")
  .option("-s, --stream <name>", "Stream, e.g. note, location, health, chat", "note")
  .option("-k, --kind <name>", "Event kind within the stream", "entry")
  .option("--source <name>", "Source/device id", "cli")
  .option("--at <time>", "When it happened (ISO, epoch, or 'YYYY-MM-DD HH:MM')")
  .option("--end <time>", "End time for spans")
  .option("--data <json>", "JSON payload")
  .option("--tag <tag>", "Tag (repeatable)", collect)
  .option("--entity <name>", "Entity (repeatable)", collect)
  .option("--importance <0-1>", "Override salience score")
  .option("--privacy <level>", "normal | sensitive | secret")
  .option("--id <externalId>", "External id for idempotent re-sends")
  .option("--json", "Output machine-readable JSON")
  .action(runRecord);

program
  .command("import <path>")
  .description("Bulk-import history: json, ndjson, ics (calendar), gpx (location), csv (any metrics), or a git repo dir")
  .option("-c, --config <path>", "Config file path")
  .option("-f, --format <fmt>", "json|ndjson|ics|gpx|csv|git (default: auto-detect)")
  .option("-s, --stream <name>", "Override stream")
  .option("-k, --kind <name>", "Override kind")
  .option("--source <name>", "Override source")
  .option("--limit <n>", "git: max commits")
  .option("--json", "Machine-readable output")
  .action(runImport);

program
  .command("recall [query]")
  .description("Agent-ready context pack: matching events (+ surrounding moments), or everything --at a time")
  .option("-c, --config <path>", "Config file path")
  .option("-e, --entity <name>", "Filter by person/place/thing")
  .option("--at <time>", "Center time: show what happened around it")
  .option("-w, --window <min>", "--at window in minutes (default 60)")
  .option("--from <time>", "Start")
  .option("--to <time>", "End")
  .option("-s, --stream <names>", "Comma-separated streams")
  .option("-n, --limit <n>", "Max hits (default 20)")
  .option("--context <min>", "Neighbour window per hit in minutes (default 30, 0 = off)")
  .option("--json", "Machine-readable output")
  .action(runRecall);

program
  .command("who <entity>")
  .description("Profile a person/place/thing: activity span, streams, co-mentions, recent events")
  .option("-c, --config <path>", "Config file path")
  .option("--json", "Machine-readable output")
  .action(runWho);

program
  .command("export")
  .description("Export events as portable NDJSON (re-importable with `dendrite import`)")
  .option("-c, --config <path>", "Config file path")
  .option("-o, --out <file>", "Output file (default stdout)")
  .option("--from <time>", "Start (inclusive)")
  .option("--to <time>", "End (exclusive)")
  .option("-s, --stream <names>", "Comma-separated streams")
  .option("--include-secret", "Include secret-privacy events")
  .action(runExport);

program
  .command("prune")
  .description("Apply retention.streams policy (e.g. browser: 90d, '*': 5y)")
  .option("-c, --config <path>", "Config file path")
  .option("--dry-run", "Report without deleting")
  .option("--json", "Machine-readable output")
  .action(runPrune);

program
  .command("backup <file>")
  .description("Online, consistent SQLite backup of the index + event log")
  .option("-c, --config <path>", "Config file path")
  .action(runBackup);

program
  .command("timeline [date]")
  .description("Show what happened on a day (or week) from the event log")
  .option("-c, --config <path>", "Config file path")
  .option("-w, --week", "Whole ISO week containing the date")
  .option("-s, --stream <names>", "Comma-separated streams")
  .option("--no-include-sensitive", "Hide sensitive events")
  .option("--json", "Machine-readable output")
  .action(runTimeline);

program
  .command("digest [date]")
  .description("Write a deterministic daily/weekly digest note into the vault")
  .option("-c, --config <path>", "Config file path")
  .option("-w, --week", "Weekly digest")
  .option("-d, --days <n>", "Backfill N days ending at date", "1")
  .option("-s, --stream <names>", "Comma-separated streams")
  .option("--narrate", "Add an LLM-written summary + open loops (falls back to deterministic on failure)")
  .option("--no-narrate", "Disable narration even if digest.narrate is set")
  .option("--dry-run", "Print instead of writing")
  .action(runDigest);

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
  .action(async (opts: { config?: string; dryRun?: boolean }) => {
    await runMigrate({ config: opts.config, dryRun: opts.dryRun });
  });

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

program.parse();
