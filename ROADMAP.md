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
| 1 | **Web dashboard** ✅ | Inbox triage, Ask tab, health strip, compartment browser (`dendrite serve`). |
| 2 | **Per-compartment templates** ✅ | `templates/<compartment>.md` with `{{vars}}`. |
| 3 | **npm publish** 📋 | `npm install -g dendrite` without cloning. |
| 4 | **Golden eval set** ✅ | `dendrite eval` + `eval/dataset.jsonl` (expand toward ~50 + CI gate). |
| 5 | **Doctor improvements** ✅ | Coverage, queue, dangling links, avg segments/dump, cost estimate, `--json`. |

### v0.3.1 polish wave ✅

Merge-back, growth cap, flat org, tasks checkbox render, gated MCP `capture_note`,
siblings transcript, bookmarklet + iOS Shortcuts docs. See [SPEC.md](SPEC.md) §2.1
and [CHANGELOG.md](CHANGELOG.md).

---

## v0.4 — More inputs

| Priority | Feature | Notes |
|----------|---------|-------|
| 1 | **Email input** 📋 | Forward-to-ingest (AgentMail / SES). Strip signatures → classify → `reads/` or `inbox/`. |
| 2 | **Browser extension capture** 💡 | Highlight → webhook (bookmarklet shipped as interim). |
| 3 | **Obsidian plugin (read-only)** 💡 | In-vault status: last capture, inbox count, link to dendrite doctor. |
| 4 | **iOS Shortcuts recipe** ✅ | Documented webhook + audio payload in DOCS.md. |

---

## v0.5 — Agent ecosystem

| Priority | Feature | Notes |
|----------|---------|-------|
| 1 | **MCP `capture_note` (gated)** ✅ | Opt-in `mcp.write.enabled`; audit log; `require_review` → inbox. |
| 2 | **Remote MCP transport** 💡 | HTTP/SSE with bearer auth for agents on other machines. |
| 3 | **Merge-back correction** ✅ | `dendrite merge <a> <b> [--into A\|B] [--dry-run]`. |
| 4 | **`get_capture_siblings` enrichment** ✅ | Original transcript from `dumps.text`. |
| 5 | **Family / multi-user visibility** 💡 | Per-compartment `private` / `shared`; MCP filters by identity. |

---

## v1.0 — Production hardening

| Priority | Feature | Notes |
|----------|---------|-------|
| 1 | **Stable vault schema** 📋 | `dendrite_version` migration path documented; no breaking changes without migrate. |
| 2 | **Note growth cap + auto-summary** ✅ | `growth.policy: summarize\|split\|off` (LLM summarize still heuristic stubs). |
| 3 | **Flat organization mode** ✅ | `organization: flat` + migrate converters. |
| 4 | **Hosted option** 💡 | Managed daemon + phone app for non-technical users (future business model). |
| 5 | **Tasks plugin format** ✅ | `tasks.render: checkbox\|both` with optional `📅` date. |

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

- [DOCS.md](DOCS.md) — usage guide
- [CHANGELOG.md](CHANGELOG.md) — release history
