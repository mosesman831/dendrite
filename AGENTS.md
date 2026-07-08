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

dendrite doctor [--stats]
dendrite ingest "text" [--dry-run]
dendrite sort [--dry-run]            # inbox + unfiled imports → brain/
dendrite repair [--dry-run]          # split junk-drawer notes
dendrite migrate [--dry-run]         # upgrade frontmatter schema
dendrite embed [--force]             # build semantic vectors (hybrid search)
dendrite remove --last
dendrite reindex
dendrite mcp
dendrite serve
```

### Telegram (`dendrite serve`)

`/start` `/help` `/inbox` `/recent` `/compartments` `/sort` `/undo`

- **`/sort`** — dry-run preview with ✅ Confirm / ❌ Cancel buttons (10 min expiry).

## MCP tools (`dendrite mcp`)

| Tool | Use when |
|------|----------|
| `describe_schema` | **Call first** — compartments + frontmatter contract |
| `search_vault` | Keyword + hybrid semantic search (if embeddings enabled) |
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

Per-compartment templates, email input, MCP `capture_note`, merge-back correction. See [ROADMAP.md](ROADMAP.md).
