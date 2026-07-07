# Dendrite — Usage Guide

Complete guide to installing, configuring, capturing, maintaining, and querying your
second brain with Dendrite.

**Quick links:** [Install](#installation) · [First capture](#first-capture) ·
[Telegram](#telegram-bot) · [CLI](#cli-reference) · [Vault](#vault-layout) ·
[MCP](#mcp-for-agents) · [Maintenance](#vault-maintenance) ·
[Troubleshooting](#troubleshooting)

---

## What you get

After setup, every thought you capture becomes a Markdown file like:

```
vault/brain/learnings/agent-orchestration-uses-dag-instead-of-chain.md
```

With YAML frontmatter (`compartment`, `confidence`, `entities`, `tags`, `links`),
timestamped body sections, and automatic `[[wikilinks]]` to related notes.

---

## Installation

### Requirements

- **Node.js 20+**
- **ffmpeg** (for Telegram voice notes)
- An **OpenAI-compatible LLM** API key (OpenAI, NVIDIA NIM, Groq, Ollama, etc.)
- Optional: **STT** key for voice (OpenAI Whisper, NVIDIA Riva, or local whisper.cpp)

### Steps

```bash
git clone https://github.com/mosesman831/dendrite.git
cd dendrite
npm install
npm run build

cp dendrite.config.example.yaml dendrite.config.yaml
cp .env.example .env
# Edit .env — add at least one LLM API key
```

Verify:

```bash
npx dendrite doctor
```

### Interactive wizard (alternative)

```bash
npx dendrite init
```

Creates config, prompts for providers, and can enable Telegram in one pass.

### Docker

```bash
docker compose up
```

Mount your vault at `/vault`. Set env vars in `.env`.

### Link globally (optional)

```bash
npm link
dendrite doctor   # now available everywhere
```

---

## First capture

```bash
# Preview where it would go (no write)
dendrite ingest --dry-run "TIL Rust ownership prevents data races at compile time"

# Actually file it
dendrite ingest "TIL Rust ownership prevents data races at compile time"
```

Check the vault:

```bash
ls vault/brain/learnings/
```

Reindex if needed:

```bash
dendrite reindex
```

---

## Configuration

Main file: `dendrite.config.yaml` (copy from `dendrite.config.example.yaml`).

### Vault

```yaml
vault:
  path: ./vault              # or /path/to/your/obsidian/vault
  compartments_file: compartments.yaml
  timezone: UTC              # used in note timestamps
```

Point `path` at an existing Obsidian vault — Dendrite only writes under `brain/`.

### LLM providers

```yaml
providers:
  llm:
    primary:
      baseURL: https://integrate.api.nvidia.com/v1
      model: meta/llama-3.1-8b-instruct
      apiKeyEnv: NVIDIA_API_KEY
    fallback:                  # optional — used if primary fails
      baseURL: https://api.openai.com/v1
      model: gpt-4o-mini
      apiKeyEnv: OPENAI_API_KEY
```

Keys live in `.env`, never in the vault:

```bash
NVIDIA_API_KEY=nvapi-...
OPENAI_API_KEY=sk-...
```

See [`provider-presets.yaml`](provider-presets.yaml) for Ollama, Groq, and Riva examples.

### Voice (STT)

```yaml
providers:
  stt:
    provider: openai-audio     # simplest default
    baseURL: https://api.openai.com/v1
    model: whisper-1
    apiKeyEnv: OPENAI_API_KEY
```

For NVIDIA Riva gRPC, also run: `pip3 install -r requirements-stt.txt`

### Classification tuning

```yaml
classification:
  strong_match_threshold: 0.72   # FTS score to append to existing note
  weak_match_threshold: 0.45       # triggers disambiguation LLM call
  confidence:
    silent_above: 0.75             # no Telegram reply when confident
    confirm_below: 0.5             # routes to inbox when below
  split:
    enabled: true
    bias: conservative             # or aggressive
    max_segments: 5
```

### Embeddings (optional semantic search)

```yaml
index:
  embeddings:
    enabled: true
    model: text-embedding-3-small
    apiKeyEnv: OPENAI_API_KEY
    hybrid_weight: 0.4             # 0 = FTS only, 1 = semantic only
```

Then build vectors:

```bash
dendrite embed
```

---

## Brain compartments

Defined in [`compartments.yaml`](compartments.yaml). Edit descriptions and examples
to steer the classifier toward your workflow.

| Compartment | Use for |
|-------------|---------|
| `learnings` | Facts, techniques, TILs |
| `projects` | Per-project notes (one file per entity) |
| `memories` | Durable personal facts — people, places, preferences |
| `tasks` | To-dos and follow-ups |
| `ideas` | Half-formed thoughts |
| `reads` | Articles, books, resources |
| `reflections` | Growth insights, team dynamics |
| `journal` | Ephemeral daily logs (append-only, dated files) |
| `rants` | Raw thought streams |
| `inbox` | Low-confidence — needs your review |

---

## Running the daemon

```bash
dendrite serve
```

Starts everything enabled in config:

- Telegram bot (if `inputs.telegram.enabled: true`)
- HTTP webhook (if `inputs.webhook.enabled: true`)
- Daily prompt cron
- Weekly pattern engine
- Scheduled reindex

Run in background with pm2, systemd, or `docker compose`.

---

## Telegram bot

### Setup

1. Create a bot via [@BotFather](https://t.me/BotFather) → get token.
2. Get your Telegram user ID (e.g. [@userinfobot](https://t.me/userinfobot)).
3. Configure:

```yaml
inputs:
  telegram:
    enabled: true
    tokenEnv: TELEGRAM_BOT_TOKEN
    allowed_user_ids: [123456789]
```

```bash
# .env
TELEGRAM_BOT_TOKEN=123456:ABC...
```

4. `dendrite serve`

### Commands

| Command | What it does |
|---------|--------------|
| `/start` | Welcome message |
| `/help` | List commands |
| `/inbox` | Show unfiled items |
| `/recent` | Last 5 updated notes |
| `/compartments` | List brain compartments |
| `/sort` | Preview vault sort → Confirm/Cancel buttons |
| `/undo` | Undo your last capture |

### Capturing

- **Text** — send any message (not starting with `/`).
- **Voice** — send a voice note; Dendrite transcribes then classifies.
- **Corrections** — when confidence is low, tap inline buttons to teach future routing.

### Multi-topic messages

One message like *"call plumber + TIL Rust + parents live in Germany"* becomes
multiple notes with sibling cross-links. You'll get one reply per segment.

---

## HTTP webhook

Enable in config:

```yaml
inputs:
  webhook:
    enabled: true
    port: 8787
    tokenEnv: DENDRITE_WEBHOOK_TOKEN
```

```bash
# .env
DENDRITE_WEBHOOK_TOKEN=your-secret-token
```

### Ingest

```bash
curl -X POST http://localhost:8787/ingest \
  -H "Authorization: Bearer your-secret-token" \
  -H "Content-Type: application/json" \
  -d '{"text": "Remember to review the Q3 budget", "source": "shortcuts"}'
```

### Health check

```bash
curl http://localhost:8787/health
```

---

## CLI reference

| Command | Description |
|---------|-------------|
| `dendrite init` | Interactive setup wizard |
| `dendrite doctor [--stats]` | Health check + metrics |
| `dendrite ingest "text"` | Classify and write one capture |
| `dendrite ingest --dry-run "text"` | Preview without writing |
| `dendrite ingest --file audio.ogg` | Transcribe + ingest audio |
| `dendrite serve` | Run daemon |
| `dendrite mcp` | MCP read-server (stdio) |
| `dendrite reindex` | Rebuild search index from vault |
| `dendrite inbox` | List inbox notes |
| `dendrite sort [--dry-run]` | LLM-sort inbox + unfiled imports |
| `dendrite sort --inbox-only` | Only re-file `brain/inbox/` |
| `dendrite sort --imports-only` | Only vault-root / scratch imports |
| `dendrite repair [--dry-run]` | Split junk-drawer notes |
| `dendrite migrate [--dry-run]` | Upgrade frontmatter schema |
| `dendrite embed [--force]` | Build embedding vectors |
| `dendrite remove --last` | Undo most recent capture |
| `dendrite remove --id <dumpId>` | Undo specific capture |
| `dendrite remove --note <path>` | Undo last write to a note |
| `dendrite backfill [--dry-run]` | Classify vault-root imports only |
| `dendrite pattern-scan` | Run weekly digest now |

Global flag: `-c /path/to/dendrite.config.yaml`

---

## Vault layout

```
vault/
├── brain/
│   ├── learnings/       # TILs, techniques
│   ├── memories/        # Personal facts
│   ├── tasks/           # To-dos
│   ├── projects/        # Per-project notes
│   ├── ideas/
│   ├── reads/
│   ├── reflections/
│   ├── rants/
│   ├── journal/         # Daily append-only (DD-MM-YYYY.md)
│   ├── inbox/           # Low-confidence triage
│   ├── scratch/         # Unprocessed imports (backfill source)
│   └── _dendrite/       # Runtime (catalog, archives) — don't edit
│       ├── catalog.md
│       ├── imported/    # Archived originals after sort/backfill
│       └── repaired/    # Archives before junk-drawer repair
```

### Note format

```markdown
---
compartment: learnings
title: Agent orchestration uses DAG not chain
confidence: 0.91
entities: [agent orchestration, DAG]
tags: [til]
links: ["[[related-note]]"]
dendrite_version: 1
summary: Technical learning about orchestration patterns.
created: 2026-07-07T14:30:00.000Z
updated: 2026-07-07T14:30:00.000Z
source: telegram-text
---

# Agent orchestration uses DAG not chain

## 2026-07-07 14:30 · via telegram-text

TIL agent orchestration uses a DAG not a chain. Related: [[related-note]].
```

---

## Vault maintenance

### Sort unfiled notes

```bash
dendrite sort --dry-run    # always preview first
dendrite sort
```

Processes `brain/inbox/` and notes outside `brain/` without `dendrite_version`.
Archives originals to `brain/_dendrite/imported/`.

### Repair junk drawers

Notes with many unrelated appended sections (misfiled near-duplicates):

```bash
dendrite repair --dry-run
dendrite repair
dendrite repair --note brain/memories/some-bloated-note.md
```

### Migrate frontmatter

After a `dendrite_version` bump:

```bash
dendrite migrate --dry-run
dendrite migrate
```

### Undo a capture

```bash
dendrite remove --last
# or in Telegram: /undo
```

Removes the capture section from the note, or moves a newly-created note to inbox.

---

## MCP for agents

Register in Cursor / Claude Code / Hermes:

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

### Recommended agent workflow

1. Call `describe_schema` first — learn compartments and frontmatter contract.
2. `search_vault` with a natural language query.
3. `read_note` for full content.
4. `get_capture_siblings` to reconstruct a multi-segment moment.
5. `vault_catalog` for a full brain snapshot.

### Tools

| Tool | Purpose |
|------|---------|
| `describe_schema` | Compartments + frontmatter contract |
| `search_vault` | Keyword + hybrid semantic search |
| `read_note` | Read note by path |
| `vault_catalog` | Full index grouped by compartment |
| `list_compartments` | Compartment list + counts |
| `recent_notes` | Recently updated |
| `get_backlinks` | What links to a note |
| `get_capture_siblings` | Reconstruct split capture |

**Read-only.** To add knowledge, use CLI/Telegram/webhook — not MCP.

See [AGENTS.md](AGENTS.md) for agent contribution rules.

---

## Using with Obsidian

1. Point `vault.path` at your Obsidian vault (or symlink `vault/` into it).
2. Open the vault in Obsidian — Dendrite notes appear instantly.
3. Use **Dataview** queries on frontmatter:

```dataview
TABLE compartment, confidence, summary
FROM "brain/learnings"
SORT updated DESC
LIMIT 10
```

4. Dendrite never force-renames your files. If you rename in Obsidian, run `dendrite reindex`.

---

## Troubleshooting

### `dendrite doctor` fails on LLM

- Check `.env` has the key named in `apiKeyEnv`.
- Test reachability: `curl` your `baseURL` or try the fallback provider.
- For Ollama: `apiKeyEnv: NONE` and `baseURL: http://localhost:11434/v1`.

### Captures go to inbox

- Confidence below `confirm_below` (default 0.5).
- Review with `dendrite inbox` or Telegram `/inbox`.
- Tap correction buttons to teach routing.
- Run `dendrite sort` to re-file.

### Voice notes fail

- Ensure `ffmpeg` is installed: `ffmpeg -version`.
- For Riva: `pip3 install -r requirements-stt.txt`.
- Check STT provider config matches your API.

### Duplicate / wrong note appends

- Run `dendrite repair --dry-run` for junk drawers.
- Laundry-list messages should split automatically; if not, file an issue.
- Lower `strong_match_threshold` cautiously — can cause more appends.

### Index out of sync

```bash
dendrite reindex
```

Vault is source of truth; index is always rebuildable.

### Tests

```bash
npm run build
npm test    # requires API keys in .env
```

---

## Further reading

| Doc | Contents |
|-----|----------|
| [README.md](README.md) | Overview + why Dendrite |
| [DOCS.md](DOCS.md) | Full usage guide |
| [ROADMAP.md](ROADMAP.md) | Future plans |
| [AGENTS.md](AGENTS.md) | Guide for AI agents |
| [CHANGELOG.md](CHANGELOG.md) | Release history |
