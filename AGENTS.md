# AGENTS.md — Dendrite

Guidance for AI agents **using** or **working on** Dendrite — the knowledge ingestion daemon in this repo.

## What Dendrite is

Dendrite receives raw captures (Telegram, webhook, CLI), classifies them with an LLM, and writes structured Markdown into an Obsidian vault under `brain/<compartment>/`. It maintains a SQLite FTS5 index (+ optional embedding vectors) and exposes an MCP read-server.

**Docs:** [DOCS.md](DOCS.md) · **Human quick start:** [README.md](README.md)

## Repo layout

| Path | Purpose |
|------|---------|
| `src/cli.ts` | All CLI commands |
| `src/pipeline/` | classify → resolve → crosslink → write |
| `src/pipeline/multi-classify.ts` | Multi-topic + laundry-list splitting |
| `src/pipeline/migrations.ts` | Frontmatter version migrations |
| `src/pipeline/repair-detect.ts` | Junk-drawer detection |
| `src/pipeline/search.ts` | Hybrid FTS + embeddings search |
| `src/commands/sort.ts` | Vault sort + Telegram preview helpers |
| `src/commands/migrate.ts` | `dendrite migrate` |
| `src/commands/repair.ts` | `dendrite repair` |
| `src/commands/embed.ts` | `dendrite embed` |
| `src/inputs/telegram.ts` | Bot, `/sort`, `/undo`, corrections |
| `src/mcp/server.ts` | MCP read tools |
| `dendrite.config.yaml` | Runtime config |

## CLI commands

```bash
npm run build && npm test          # 31 checks — run before/after changes

dendrite doctor [--stats] [--json]   # + embedding coverage, queue health, dangling links
dendrite ingest "text" [--dry-run]
dendrite ask "question"              # RAG answer over the vault, with [[wikilink]] citations
dendrite sort [--dry-run]            # inbox + unfiled imports → brain/
dendrite repair [--dry-run]          # split junk-drawer notes
dendrite migrate [--dry-run]         # upgrade frontmatter schema
dendrite embed [--force]             # build semantic vectors (hybrid search)
dendrite eval                        # classifier accuracy on golden dataset (dry-run)
dendrite remove --last
dendrite reindex
dendrite mcp
dendrite serve
```

### Telegram (`dendrite serve`)

`/start` `/help` `/inbox` `/recent` `/compartments` `/ask` `/sort` `/undo`

- **`/sort`** — dry-run preview with ✅ Confirm / ❌ Cancel buttons (10 min expiry).

## MCP tools (`dendrite mcp`)

| Tool | Use when |
|------|----------|
| `describe_schema` | **Call first** — compartments + frontmatter contract |
| `search_vault` | Keyword + hybrid semantic search (if embeddings enabled) |
| `answer_question` | RAG answer from the vault with `[[wikilink]]` citations |
| `read_note` | Read note by vault-relative path |
| `vault_catalog` | Full index snapshot |
| `list_compartments` | Compartment list + counts |
| `recent_notes` | Recently updated notes |
| `get_backlinks` | Notes linking to a path |
| `get_capture_siblings` | Reconstruct a split capture by `split_group` / parent dump id |

**Read-only.** Ingestion via CLI/Telegram/webhook only.

```json
{
  "mcpServers": {
    "dendrite": {
      "command": "node",
      "args": ["/absolute/path/to/dendrite/dist/cli.js", "mcp"]
    }
  }
}
```

## Vault maintenance workflows

```bash
# New vault / messy imports
dendrite sort --dry-run && dendrite sort

# Old notes missing frontmatter
dendrite migrate --dry-run && dendrite migrate

# Junk drawer (unrelated sections in one note)
dendrite repair --dry-run && dendrite repair

# Enable semantic search
# 1. Set index.embeddings.enabled: true in config
# 2. dendrite embed
```

Archives: `brain/_dendrite/imported/` (sort), `brain/_dendrite/repaired/` (repair).

## Pipeline rules

1. **Multi-topic splitting:** unrelated thoughts → multiple notes + sibling links.
2. **Laundry-list heuristic:** `"my son… and my daughter… and I like…"` → rule-split.
3. **`create_new` honored** on splits — no FTS junk-drawer appends.
4. **Near-dup guard:** title keywords must appear in new text to append.
5. **Hybrid search:** when `index.embeddings.enabled` + vectors exist, crosslink and MCP search blend FTS + cosine similarity (`hybrid_weight`).
6. **Per-compartment templates:** optional `templates/<compartment>.md` files customize frontmatter + body of newly created notes (dynamic core frontmatter still wins).

## Config knobs

```yaml
classification.split:
  enabled: true
  bias: conservative
  max_segments: 5

repair:
  min_sections: 3
  max_title_relevance: 0.34

index.embeddings:
  enabled: false
  model: text-embedding-3-small
  hybrid_weight: 0.4
```

## Safe vs danger zones

**Safe:** prompt tuning, heuristics with tests, new read-only MCP tools, dry-run batch commands.

**Ask first:** mass vault writes without dry-run, lowering near-dup thresholds, MCP write tools, deleting user notes.

## Test status

```
npm test → 31/31 passed
```

Covers: classification, laundry-list, multi-split, idempotency, sort/migrate/repair dry-run, capture siblings, embedding utils, webhook, reindex.

## Not yet built (v0.3+)

Email input, MCP `capture_note`, merge-back correction. See [ROADMAP.md](ROADMAP.md) and [SPEC.md](SPEC.md).

## Cursor Cloud specific instructions

Startup runs `npm install` automatically (the update script). Everything below is durable, non-obvious context — see `README.md` / `package.json` scripts for the standard commands.

- **Build before running anything.** The `dendrite` bin points at `dist/cli.js`, so `npm run build` (tsc) must be run before `doctor`/`ingest`/`serve`/`mcp`/`npm test`. There is no ts-runtime; rebuild after any `src/` change. Build is intentionally kept out of the update script.
- **`better-sqlite3`** is a native module compiled during `npm install`; a normal reinstall rebuilds it.
- **No-key checks:** `npm run test:ci` (smoke) and `npm run build` need no API keys and always work here.
- **LLM is required for real work.** `ingest`, `serve`, `mcp` and the full `npm test` (31 checks) call an OpenAI-compatible chat endpoint. No `OPENAI_API_KEY`/`NVIDIA_API_KEY` is set by default. Two ways to get a working LLM:
  1. Add `OPENAI_API_KEY` and/or `NVIDIA_API_KEY` as secrets (default `dendrite.config.yaml` uses NVIDIA primary + OpenAI fallback).
  2. **Offline (no keys):** run [Ollama] serving a small model and point Dendrite at it. Use `dendrite.config.local.yaml` (already in repo) via `-c dendrite.config.local.yaml`; it targets `http://127.0.0.1:11434/v1`, model `llama3.2:3b`, `apiKeyEnv: NONE`.
- **Ollama gotcha:** the newest Ollama (0.31.x) **segfaults during model warmup on this CPU**. Install a stable older build instead: `curl -fsSL https://ollama.com/install.sh | OLLAMA_VERSION=0.6.8 sh`, then `ollama serve` (systemd isn't running, so start it manually, e.g. in tmux) and `ollama pull llama3.2:3b`. Ollama is deliberately NOT in the update script (too heavy).
- **Index db** lives at `~/.local/share/dendrite/index.db` (outside the repo); delete it to reset local state. `dendrite reindex` rebuilds it from the vault.
- With a small local model, `npm test` may fail only the data-dependent `FTS search` assertion (weak-model routing writes fewer notes); use API keys or a stronger model for a clean 31/31.

[Ollama]: https://ollama.com
