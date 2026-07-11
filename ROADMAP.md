# Roadmap

> **Current release:** [v0.1.0](https://github.com/mosesman831/dendrite/releases/tag/v0.1.0) (public beta)  
> **Status key:** ✅ shipped · 🚧 in progress · 📋 planned · 💡 exploring

---

## Vision

Dendrite becomes the **default memory layer** for personal AI: capture from anywhere,
file automatically, and let every agent read the same structured Obsidian vault.

Write path = Dendrite. Read/reason path = your agent (Hermes, Cursor, Claude Code, etc.).

---

## Shipped (v0.1 / v0.2)

| Feature | Version |
|---------|---------|
| LLM classification into 9 compartments + inbox | v0.1 |
| Multi-topic splitting + laundry-list heuristic | v0.1 |
| Telegram (text, voice, corrections, `/undo`) | v0.1 |
| HTTP webhook ingest | v0.1 |
| MCP read-server (8 tools) | v0.1 |
| `sort`, `backfill`, `remove`, `reindex` | v0.1 |
| `migrate` — frontmatter version upgrades | v0.2 |
| `repair` — junk-drawer detection + re-file | v0.2 |
| Telegram `/sort` with confirm/cancel | v0.2 |
| `get_capture_siblings` MCP tool | v0.2 |
| Hybrid embeddings search (`embed` + FTS blend) | v0.2 |
| Daily prompt + weekly pattern engine cron | v0.1 |

---

## v0.3 — Polish & visibility

| Priority | Feature | Notes |
|----------|---------|-------|
| 1 | **Web dashboard** 📋 | Inbox triage queue, compartment browser, brain health stats, correction history. Thin UI over existing index + MCP. |
| 2 | **Per-compartment templates** 📋 | Custom note headers/callouts per compartment so output matches your Obsidian aesthetic. |
| 3 | **npm publish** 📋 | `npm install -g dendrite` without cloning. |
| 4 | **Golden eval set** 📋 | ~50 labeled dumps, CI accuracy gate on classification routing. |
| 5 | **Doctor improvements** 📋 | Embedding coverage %, avg segments/dump guardrail, cost estimate per dump. |

---

## v0.4 — More inputs

| Priority | Feature | Notes |
|----------|---------|-------|
| 1 | **Email input** 📋 | Forward-to-ingest (AgentMail / SES). Strip signatures → classify → `reads/` or `inbox/`. |
| 2 | **Browser extension capture** 💡 | Highlight → webhook. |
| 3 | **Obsidian plugin (read-only)** 💡 | In-vault status: last capture, inbox count, link to dendrite doctor. |
| 4 | **iOS Shortcuts recipe** 📋 | Documented webhook + audio payload for voice capture without Telegram. |

---

## v0.5 — Agent ecosystem

| Priority | Feature | Notes |
|----------|---------|-------|
| 1 | **MCP `capture_note` (gated)** 💡 | Optional write tool for sandboxed agents. Ingestion stays CLI/Telegram/webhook by default. |
| 2 | **Remote MCP transport** 💡 | HTTP/SSE with bearer auth for agents on other machines. |
| 3 | **Merge-back correction** 📋 | User says two notes were one thought → physical merge (§50.12). |
| 4 | **`get_capture_siblings` enrichment** 📋 | Include original transcript from dumps table in MCP response. |
| 5 | **Family / multi-user visibility** 💡 | Per-compartment `private` / `shared`; MCP filters by identity. |

---

## v1.0 — Production hardening

| Priority | Feature | Notes |
|----------|---------|-------|
| 1 | **Stable vault schema** 📋 | `dendrite_version` migration path documented; no breaking changes without migrate. |
| 2 | **Note growth cap + auto-summary** 📋 | Split or summarize notes that exceed N sections / tokens. |
| 3 | **Flat organization mode** 📋 | `organization: flat` — single folder, compartment as tag/frontmatter only. |
| 4 | **Hosted option** 💡 | Managed daemon + phone app for non-technical users (future business model). |
| 5 | **Tasks plugin format** 📋 | Optional `- [ ] task ➕ date` rendering instead of frontmatter-only tasks. |

---

## Explicitly out of scope (for now)

- Replacing Obsidian or becoming a notes app
- Real-time collaborative editing
- Proprietary cloud vault lock-in
- Fine-tuning / training custom classification models
- Built-in chat UI (use your agent)

---

## How to influence the roadmap

1. **Open an issue** with the `[feature]` label and your use case.
2. **Vote** on existing issues with 👍.
3. **PRs welcome** for docs, tests, and isolated features — check [AGENTS.md](AGENTS.md) first.

---

## Related

- [SPEC.md](SPEC.md) — detailed feature specification (the *how* behind this roadmap)
- [DOCS.md](DOCS.md) — usage guide
- [CHANGELOG.md](CHANGELOG.md) — release history
