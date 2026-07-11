# Changelog

## 0.3.0 — Unreleased

### Features

- RAG question-answering: `dendrite ask "..."` answers from vault notes only via hybrid FTS + embeddings retrieval, cites sources as `[[wikilinks]]`, is read-only, and refuses (without calling the LLM) when nothing relevant is found. Also `/ask` (Telegram) and `answer_question` (MCP). Flags: `--compartment`, `-k`, `--json`.
- Per-compartment templates: optional `templates/<compartment>.md` customize frontmatter + body of newly created notes with `{{variable}}` placeholders; existing notes are never rewritten. Config: `templates.enabled`, `templates.dir`.
- `dendrite doctor` upgrades: reports embedding coverage, ingest-queue health (pending/processing/dead), and dangling `[[wikilink]]` count; new `--json` flag exits non-zero on critical issues.
- Classification eval harness: `dendrite eval` runs a golden `eval/dataset.jsonl` through the classifier in dry-run and reports routing accuracy + per-compartment breakdown. Flags: `--limit`, `--min`, `--json`, `--dataset`.

## 0.1.0 — 2026-07-07

First public beta.

### Features

- LLM classification pipeline with 9 brain compartments + inbox
- Multi-topic splitting and laundry-list heuristic
- Telegram bot (text, voice, `/sort`, `/undo`, corrections)
- HTTP webhook ingest
- MCP read-server (search, read, catalog, siblings, schema)
- CLI: `init`, `ingest`, `serve`, `sort`, `backfill`, `repair`, `migrate`, `embed`, `remove`, `reindex`
- Hybrid FTS + embeddings search (opt-in)
- Daily prompt + weekly pattern engine cron
- Near-duplicate detection with title relevance guard
- Soft undo (`remove` / `/undo`)

### Docs

- `DOCS.md` — usage guide
- `ROADMAP.md` — future plans
- `AGENTS.md` — guide for AI agents
