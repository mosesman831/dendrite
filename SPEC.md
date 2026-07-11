# Dendrite — Feature Specification (SPEC.md)

> **Status:** proposal / planning document.
> **Scope:** concrete, technically-grounded feature specs that extend the current
> v0.1 codebase toward the [ROADMAP.md](ROADMAP.md) vision — *"the default memory
> layer for personal AI."*
> **Audience:** maintainers and AI agents contributing to Dendrite. Read
> [AGENTS.md](AGENTS.md) first for pipeline rules and safe/danger zones.

This document is the detailed design counterpart to the high-level `ROADMAP.md`.
Where the roadmap says *what* and *when*, this spec says *how*: data-model
changes, config knobs, CLI/MCP/HTTP surface, acceptance criteria, and risks.

---

## 1. Guiding principles

These constrain every feature below. A proposal that violates one is rejected.

1. **The vault is the source of truth.** Every derived artifact (SQLite index,
   embeddings, graph edges, caches) must be fully rebuildable from Markdown via
   `dendrite reindex`. No feature may store canonical state only in SQLite.
2. **Plain files, forever.** Output stays Obsidian-native Markdown + YAML
   frontmatter. No proprietary formats, no lock-in.
3. **Write path vs read path stays separated.** Dendrite ingests and organizes;
   agents reason. Write tools are opt-in and gated (see §5.2).
4. **Provider-agnostic.** Anything calling an LLM/STT/embedding endpoint goes
   through the existing OpenAI-compatible provider abstraction. No hard SDK
   dependencies on a single vendor.
5. **Safe by default.** Batch/destructive operations require `--dry-run` parity,
   archive originals, and are idempotent. Nothing silently rewrites user notes.
6. **Local-first & offline-capable.** Every feature must degrade gracefully
   without network (e.g. FTS when embeddings are off; heuristics when the LLM is
   unreachable).
7. **Cheap to run.** Token spend is tracked and bounded; batch jobs are
   resumable; nothing re-embeds or re-classifies unchanged content.

---

## 2. Current state (baseline)

Implemented today (do **not** re-spec these; features below build on them):

- **Pipeline:** classify → multi-split (+ laundry-list heuristic) → resolve →
  near-dup guard → crosslink → write, with a durable SQLite ingest queue
  (`ingest_queue`) and idempotency by `dump.id` / `split_group`.
- **Inputs:** Telegram (text/voice/corrections/`/sort`/`/undo`), HTTP webhook,
  CLI, daily-prompt cron, weekly pattern engine.
- **Index:** SQLite FTS5 (`notes`, `notes_fts`, `dumps`, `corrections`,
  `embeddings`) + optional hybrid embeddings search.
- **Agent interface:** MCP read-server with 8 tools; read-only.
- **Maintenance:** `sort`, `backfill`, `repair`, `migrate`, `embed`, `remove`,
  `reindex`.
- **Web dashboard:** stats, inbox triage (approve/reclassify/reject), compartment
  browser, recent captures, corrections history (`src/inputs/dashboard.ts`).

Data-model anchors this spec reuses: `Dump`, `Classification`, `PipelineResult`,
`NoteRecord`, `Correction`, `FRONTMATTER_CONTRACT` (`src/types.ts`); the
`DendriteIndex` SQLite schema (`src/pipeline/index.ts`).

---

## 3. Roadmap → spec mapping

| Roadmap item | Spec section | Delta vs roadmap |
|--------------|-------------|------------------|
| Per-compartment templates | §6.1 | Full template engine + variables |
| Golden eval set / CI gate | §7.1 | Dataset format + accuracy gate + drift report |
| Doctor improvements | §7.3 | Cost, coverage, guardrails, `--json` |
| Email input | §4.1 | Parser + threading + auth |
| Browser extension | §4.2 | Bookmarklet fallback + read-later importers |
| Obsidian plugin (read-only) | §4.4 | Status panel + inbox triage via local API |
| MCP `capture_note` (gated) | §5.2 | Capability tokens + write audit log |
| Remote MCP transport | §5.1 | HTTP/SSE + bearer auth + CORS |
| Merge-back correction | §6.4 | Physical merge + backlink rewrite |
| Family / multi-user | §8 | Identity model + per-compartment visibility |
| Note growth cap + auto-summary | §6.2 | Section cap → summarize/split policy |
| Flat organization mode | §6.5 | `organization: flat` |
| Tasks plugin format | §6.6 | `- [ ]` rendering + due dates |
| npm publish / hosted | §9 | Distribution matrix |

**New, not in roadmap:** entity registry & knowledge graph (§6.3), vault-wide RAG
Q&A (§5.3), resurfacing / spaced review (§6.7), observability & cost governance
(§7.2), backup / git auto-commit / encryption (§7.4), plugin/hook architecture
(§10), additional inputs (§4.3, §4.5).

---

## 4. Epic A — Capture everywhere (inputs)

Goal: remove every excuse not to capture. Each input normalizes to a `Dump` and
flows through the **existing** pipeline unchanged.

### 4.1 Email-to-ingest `[P1]`

**Problem:** the fastest capture for many people is "forward this email."

**Proposal:** an inbound-email adapter that turns a forwarded message into a
`Dump{ source: "email" }` (the enum value already exists in `DumpSourceSchema`).

**Design**
- Two ingestion modes, config-selected:
  - `imap`: poll a dedicated mailbox (folder `Dendrite`) via IMAP IDLE.
  - `webhook`: accept provider callbacks (AgentMail / SES / Mailgun / Postmark)
    at `POST /ingest/email`.
- Parsing (`src/inputs/email.ts`): MIME decode → strip quoted replies and
  signatures (`talon`-style heuristics) → prefer `text/plain`, fall back to
  sanitized HTML → attachments: `.txt/.md` inlined; audio → STT; others ignored
  with a note.
- `subject` becomes a title hint; sender/recipient captured in `dump.meta`.
- Auth: allowlist of sender addresses (`inputs.email.allowed_senders`) + optional
  `+token` plus-addressing secret; unknown senders dropped and logged.

**Config**
```yaml
inputs:
  email:
    enabled: false
    mode: imap            # imap | webhook
    imap: { host: "", port: 993, userEnv: EMAIL_USER, passEnv: EMAIL_PASS, folder: Dendrite }
    allowed_senders: []
    strip_signatures: true
    default_compartment: reads   # hint, not forced
```

**Acceptance criteria**
- Forwarding a newsletter files it under `reads/` (or `inbox/` if low confidence),
  signature stripped, original archived to `brain/_dendrite/imported/`.
- Replaying the same message id is a no-op (idempotent via `dump.id = email:<Message-ID>`).
- Malformed MIME never crashes the daemon; it dead-letters to `ingest_queue`.

**Risk/effort:** medium. Risk: HTML-to-text noise; mitigate with eval samples.

### 4.2 Browser capture: extension + bookmarklet `[P1]`

**Problem:** most learnings start in the browser (articles, docs, tweets).

**Proposal:** a minimal MV3 extension (`packages/browser-extension/`) and a
zero-install bookmarklet fallback, both POSTing to the webhook.

**Design**
- Capture payload: `{ text: selection || page.title, url, title, source: "webhook", meta: { via: "browser" } }`.
- Extension: context-menu "Send to Dendrite", toolbar popup with editable text +
  compartment hint, options page for endpoint URL + bearer token.
- Bookmarklet: single `javascript:` snippet documented in `DOCS.md` that prompts
  for optional note text and POSTs the selection.
- Server: extend webhook to accept `url`/`title` and thread them into
  `extracted.resources` so `reads/` notes get a proper source link.

**Acceptance criteria**
- Highlighting text on any page and clicking the extension files a `reads/` note
  with the page URL in frontmatter `resources` and a `[[source]]`-style link.
- Works offline against a self-hosted webhook; no third-party calls from the
  extension itself.

**Risk/effort:** medium (extension review/store optional; bookmarklet is trivial).

### 4.3 Chat platforms: Slack & Discord `[P2]`

**Problem:** teams and communities live in Slack/Discord, not Telegram.

**Proposal:** adapters mirroring the Telegram feature set (text, `/inbox`,
`/recent`, corrections via buttons) built on the same command handlers.

**Design**
- Factor Telegram's command logic (`src/inputs/telegram.ts`) into a
  transport-agnostic `ChatController` (compartment listing, inbox, undo,
  correction capture). Telegram/Slack/Discord become thin transport adapters.
- Slack: Bolt Socket Mode (no public URL needed); slash commands + Block Kit
  buttons for corrections.
- Discord: slash commands + message components.
- Per-adapter user allowlist mirroring `allowed_user_ids`.

**Acceptance criteria**
- A Slack DM captures like a Telegram text message and returns the same
  silent/confirm/inbox tiering.
- Corrections recorded through Slack land in the shared `corrections` table and
  feed few-shot examples identically.

**Risk/effort:** medium. Depends on the `ChatController` refactor (also unblocks §4.5).

### 4.4 Obsidian plugin (read-only status + triage) `[P2]`

**Problem:** users live in Obsidian; they shouldn't context-switch to a browser
to see inbox count or triage.

**Proposal:** a community plugin (`packages/obsidian-plugin/`) that talks to the
**local dashboard API** (`/api/*`), not the vault DB directly.

**Design**
- Status bar item: today's capture count, inbox count, last-capture time.
- Side panel: inbox triage (approve / reclassify / reject) via
  `/api/triage/*`; "reveal note" opens the file in Obsidian.
- Settings: dashboard base URL + bearer token.
- No writes to SQLite from the plugin; all mutations go through the audited HTTP
  endpoints so the index stays consistent.

**Acceptance criteria**
- Inbox count in the status bar matches `dendrite inbox`.
- Approving from the panel moves the note and updates the index without a manual
  `reindex`.

**Risk/effort:** medium (plugin packaging + review).

### 4.5 Quick-capture surfaces & read-later importers `[P3]`

- **Desktop quick-capture:** documented global-hotkey recipes (Raycast/Alfred/
  AutoHotkey) that POST to the webhook; a tiny `dendrite capture` TUI for a
  terminal quick-add.
- **iOS/Android Shortcuts:** ship signed recipe files + docs for text and voice
  capture (roadmap item, formalized here as downloadable `.shortcut`).
- **Read-later importers:** `dendrite import readwise|pocket|instapaper` pulling
  highlights/articles via API into `reads/`, deduped by URL. Batch, resumable,
  `--dry-run`, archives raw payloads.

**Acceptance criteria:** each importer is idempotent by source id/URL and never
double-files on re-run.

---

## 5. Epic B — Agent interface (retrieval & controlled write)

### 5.1 Remote MCP transport (HTTP/SSE) `[P1]`

**Problem:** MCP is stdio-only today, so agents must run on the same machine.

**Proposal:** an HTTP/SSE MCP transport so remote agents can read the brain.

**Design**
- New command `dendrite mcp --http --port 8899` using the MCP SDK's
  Streamable HTTP/SSE transport alongside the existing stdio server.
- Auth: bearer token (`MCP_TOKEN` env); configurable CORS allowlist; deny by
  default. Read tools only unless capability tokens grant writes (§5.2).
- Per-token rate limiting and structured request logging.
- Same tool set as stdio; transport is the only difference.

**Config**
```yaml
mcp:
  http: { enabled: false, port: 8899, tokenEnv: MCP_TOKEN, cors_origins: [] }
```

**Acceptance criteria**
- A remote agent authenticates with a bearer token and runs `search_vault` /
  `read_note` over HTTP.
- Missing/invalid token → 401; no vault data leaks in the error body.

**Risk/effort:** medium. Risk: exposing a read API over network → require auth,
document TLS termination via reverse proxy.

### 5.2 Gated MCP write tool `capture_note` `[P2]`

**Problem:** some sandboxed agents should be able to *propose* captures without
opening a full ingestion channel.

**Proposal:** an opt-in MCP write tool that funnels through the **same** pipeline
and queue as every other input — no bypass.

**Design**
- Disabled by default; enabled per-capability-token
  (`mcp.write.enabled: true` + token scope `capture`).
- `capture_note({ text, source_hint?, dry_run? })` enqueues a `Dump{ source:
  "webhook", meta: { via: "mcp", agent_id } }` and returns the `PipelineResult`
  (or preview when `dry_run`).
- **Write audit log** table `write_audit(id, agent_id, tool, dump_id, ts)` and a
  dashboard view. Every agent write is attributable.
- Optional human-in-the-loop: writes land in `inbox/` first when
  `mcp.write.require_review: true`.

**Acceptance criteria**
- With writes disabled, the tool is not advertised in `tools/list`.
- An agent capture is idempotent, audited, and indistinguishable downstream from
  a webhook capture.

**Risk/effort:** medium. Risk: prompt-injection-driven writes → mitigate with
review mode + audit + rate limits.

### 5.3 Vault-wide RAG Q&A `[P1]`

**Problem:** search returns notes; users often want an *answer* with citations.

**Proposal:** a synthesis layer over hybrid search: `dendrite ask "..."`,
Telegram `/ask`, dashboard search box, and MCP tool `answer_question`.

**Design**
- Retrieve top-k via existing `smartSearch` (FTS + embeddings) → build a context
  window with note titles/paths/snippets → LLM answers **with inline
  `[[wikilink]]` citations** to the notes used → returns `{ answer, sources[] }`.
- Read-only: never writes; refuses to answer beyond retrieved context ("I don't
  have a note about that") to avoid hallucinated memory.
- Config: `retrieval.k`, `retrieval.max_context_tokens`, citation style.

**Acceptance criteria**
- "Where does my sister work?" returns "Google, Zurich" citing
  `[[my-sister-s-job-at-google]]`.
- Asking about an absent topic yields an explicit "no note found," not a guess.

**Risk/effort:** medium. Reuses search + provider layer.

### 5.4 Saved searches, smart folders, timeline `[P3]`

- `saved_searches` config → materialized as `_dendrite/views/*.md` with Dataview
  blocks (regenerated on reindex).
- MCP `timeline({ from, to, compartment? })` returning captures chronologically
  from `dumps.received_at`.
- MCP `related({ path })` — notes sharing entities/tags or high cosine similarity
  (graph-aware, see §6.3).

---

## 6. Epic C — Knowledge quality & structure

### 6.1 Per-compartment templates `[P1]`

**Problem:** all notes share one body/frontmatter shape; users want compartment-
specific structure (e.g. `reads/` wants author/url/rating; `tasks/` wants
status/priority).

**Proposal:** a template engine keyed by compartment.

**Design**
- Templates in `templates/<compartment>.md` with a mustache-ish variable set:
  `{{title}} {{summary}} {{entities}} {{tags}} {{date}} {{source}}
  {{extracted.tasks}} {{extracted.resources}} {{body}}` plus custom frontmatter
  passthrough.
- `write.ts` selects the template by resolved compartment; falls back to the
  current default when none exists.
- Template validation at load; `dendrite doctor` flags unknown variables.
- Migration-safe: templates affect *new* sections only; existing notes untouched
  unless `dendrite migrate` is run with a `--retemplate` flag (guarded).

**Config**
```yaml
templates:
  enabled: true
  dir: templates
```

**Acceptance criteria**
- A `reads/` capture with a URL renders the `reads` template with a populated
  `source_url` field; a compartment without a template renders exactly as today.

**Risk/effort:** low-medium. Risk: template errors → strict validation + fallback.

### 6.2 Note growth cap + auto-summary/split `[P1]`

**Problem:** append-heavy notes become junk drawers; `repair` handles the extreme
case but there's no proactive cap.

**Proposal:** a per-note policy: when a note exceeds `N` capture sections or `T`
tokens, either **summarize** (collapse old sections into a rolling summary block)
or **split** (spin sections into linked child notes), configurable.

**Design**
- On write, `write.ts` checks section count/token budget (reuses
  `parseCaptureSections`).
- `summarize`: LLM produces a `## Summary (auto)` block; original sections move to
  a collapsible `> [!note]- Archive` callout or a linked `-archive.md`.
- `split`: reuse `repair` machinery to file overflow sections, adding sibling
  links and `split_group`.
- Always archives pre-change copy to `_dendrite/repaired/`; `--dry-run` parity.

**Config**
```yaml
growth:
  max_sections: 25
  max_tokens: 6000
  policy: summarize     # summarize | split | off
```

**Acceptance criteria**
- A note crossing `max_sections` triggers the configured policy exactly once and
  remains valid Markdown with intact backlinks.

**Risk/effort:** medium. Risk: destructive → dry-run + archive + tests.

### 6.3 Entity registry & knowledge graph `[P2]`

**Problem:** entities are free-text strings scattered across frontmatter; there's
no canonical "person/place/project" object, so the graph is implicit and noisy.

**Proposal:** a canonical entity layer + graph edges, both rebuildable from the
vault.

**Design**
- New SQLite tables (derived, rebuilt on reindex):
  - `entities(id, canonical_name, kind, aliases_json, note_path?)` —
    `kind ∈ {person, place, org, project, tool, concept}`.
  - `edges(src_note, dst_note, kind, weight)` — `kind ∈ {mentions, related,
    sibling, backlink}`.
- **Entity resolution:** normalize + alias-match ("my parents"/"parents",
  "OpenAI"/"Open AI"); optional embedding-based clustering with a manual
  `aliases.yaml` override.
- **Entity pages:** optional `brain/_dendrite/entities/<slug>.md` auto-generated
  MOCs (map-of-content) listing notes mentioning the entity (Dataview-friendly).
- **MCP tools:** `get_entity`, `list_entities`, `related` (graph traversal),
  augmenting existing `get_backlinks`.
- Crosslinking (`crosslink.ts`) prefers canonical entity links over raw FTS hits,
  improving link precision.

**Acceptance criteria**
- "parents" and "my parents" resolve to one entity; its MOC lists all mentioning
  notes; `reindex` reproduces identical entities/edges from Markdown alone.

**Risk/effort:** high. Highest-value structural upgrade; gate behind
`graph.enabled`.

### 6.4 Merge-back correction `[P2]`

**Problem:** an over-split capture (two notes that were really one thought) can't
be re-joined.

**Proposal:** `dendrite merge <pathA> <pathB> [--into A]` and a dashboard/Telegram
action.

**Design**
- Merge bodies (dedup sections by timestamp), union frontmatter arrays
  (entities/tags/links), keep earliest `created`, latest `updated`.
- Rewrite backlinks: every note linking the absorbed slug is updated to the
  surviving slug; absorbed note becomes a stub or is archived.
- Record a `merge` correction so future splitting learns.
- `--dry-run` prints the merged preview + backlink rewrite list.

**Acceptance criteria**
- After merge, no dangling `[[absorbed-slug]]` remains; index and siblings are
  consistent; operation is reversible via `remove`/archive.

**Risk/effort:** medium-high (backlink rewrite correctness → thorough tests).

### 6.5 Flat organization mode `[P2]`

**Proposal:** `organization: flat` (schema value already reserved) — all notes in
one folder, compartment expressed via frontmatter/tag only.

**Design:** `resolve.ts` returns flat paths (`brain/<slug>.md`) with
`compartment` in frontmatter; `reindex`/`inferCompartment` read compartment from
frontmatter instead of folder. Provide `dendrite migrate --to-flat` /
`--to-folders` converters (guarded, archived).

**Acceptance criteria:** switching modes and running the converter relocates notes
losslessly and keeps search/backlinks intact.

### 6.6 First-class tasks `[P2]`

**Problem:** tasks are frontmatter-only; users want actionable, dated tasks.

**Proposal:** optional Obsidian-Tasks-compatible rendering + due dates +
agenda queries.

**Design**
- `tasks.render: checkbox` emits `- [ ] {text} 📅 {due} 🔼 {priority}` lines and
  keeps a frontmatter mirror for querying.
- Parse `extracted.dates` into due dates; natural-language dates ("Friday") via a
  date parser at classify time.
- `dendrite today` / Telegram `/today`: agenda of open tasks due ≤ today; overdue
  rollover flagged.
- Completion sync: checking a box in Obsidian is picked up on reindex → task
  marked done in index.

**Acceptance criteria**
- "book dentist before Friday" creates a task with a correct due date, appears in
  `/today` on//before Friday, and drops off when checked.

**Risk/effort:** medium.

### 6.7 Resurfacing & spaced review `[P3]`

**Proposal:** proactive recall so the brain is *used*, not just filled.
- **On this day:** daily digest of notes created N years/months ago.
- **Weekly review:** extend the pattern engine with a review queue (stale
  `tasks/`, un-triaged `inbox/`, high-value `learnings/`).
- **Spaced repetition (opt-in):** SM-2-style schedule stored in frontmatter
  (`review_due`, `review_interval`); `/review` serves due items with a
  remember/forget response that reschedules.

**Acceptance criteria:** review items are selected deterministically and their
schedule state round-trips through Markdown (source-of-truth principle).

### 6.8 Multilingual + PII controls `[P3]`

- **Language:** detect language per dump; classify in-language; optional
  translation of `summary` to a configured base language for consistent search.
- **PII/redaction (opt-in):** detect secrets/PII (emails, keys, card numbers);
  either refuse, redact, or route to an encrypted compartment (§7.4). Never log
  raw PII.

---

## 7. Epic D — Quality, evaluation & operations

### 7.1 Golden eval set + CI accuracy gate `[P1]`

**Problem:** classification quality can silently regress with prompt/model
changes.

**Proposal:** a labeled dataset + offline eval harness + CI gate.

**Design**
- `eval/dataset.jsonl`: `{ text, expected_compartment, expected_min_segments?,
  notes? }`, ≥ 50 cases spanning every compartment, laundry-list, multi-topic,
  and hard negatives (inbox).
- `dendrite eval` (or `scripts/eval.mjs`): runs dumps in `--dry-run`, computes
  per-compartment precision/recall, split accuracy, over/under-split rate; emits
  a Markdown/JSON report.
- CI: gate merges on `accuracy ≥ threshold` (configurable) using a deterministic
  model (temp 0) or a recorded-fixture provider so CI needs no live keys.
- Track scores over time in `eval/history.csv` for drift visibility.

**Acceptance criteria**
- `npm run eval` prints a report and exits non-zero below threshold; CI blocks
  regressions.

**Risk/effort:** medium. Enables safe iteration on prompts/models.

### 7.2 Observability & cost governance `[P1]`

**Problem:** no visibility into token spend, latency, or failures; costs can
surprise.

**Proposal:** structured logging, metrics, and a token/cost ledger with budgets.

**Design**
- **Cost ledger:** `usage(ts, dump_id, provider, model, prompt_tokens,
  completion_tokens, est_cost)` populated from provider responses; price table in
  config. `dendrite doctor --stats` and the dashboard show $/day, $/dump,
  tokens/dump.
- **Budgets:** `budget.daily_usd` / `monthly_usd`; on breach, degrade
  (heuristics-only classify, or queue for later) and alert via Telegram.
- **Structured logs:** JSON logs with `dump_id` correlation; log levels via
  `LOG_LEVEL`.
- **Metrics:** optional `/metrics` Prometheus endpoint (queue depth, dead-letter
  count, classify latency, embedding coverage) + optional OpenTelemetry export.

**Acceptance criteria**
- Every LLM call is recorded with token counts; exceeding the daily budget
  triggers the configured degrade path and a single alert (not a storm).

**Risk/effort:** medium.

### 7.3 `doctor` upgrades `[P2]`

Extend the existing health check:
- Embedding coverage % (embedded vs total notes), stale-embedding count.
- Avg segments/dump guardrail (flags over-splitting).
- Queue health: pending/dead-letter counts, oldest pending age.
- Per-dump cost estimate (from §7.2 price table).
- Link integrity: count of dangling `[[wikilinks]]`.
- `--json` output for scripting; non-zero exit on critical issues only.

**Acceptance criteria:** `dendrite doctor --json` returns a machine-readable
health object consumed by the dashboard and CI.

### 7.4 Backup, versioning & encryption `[P2]`

**Problem:** the vault is precious; there's no built-in safety net.

**Proposal**
- **Git auto-commit (opt-in):** after each capture batch, commit the vault repo
  with a templated message; optional push. Gives free version history + undo.
- **Snapshots/export:** `dendrite export --zip` (vault + index) and
  `dendrite backup` to a configured dir with rotation.
- **Encryption at rest (opt-in):** mark compartments `encrypted: true`; note
  bodies stored age/gpg-encrypted; MCP/search return metadata only unless a
  passphrase is provided. Clearly documented trade-offs (breaks plain-file
  readability for those notes).

**Config**
```yaml
backup:
  git_autocommit: false
  git_push: false
  export_dir: ~/dendrite-backups
security:
  encrypted_compartments: []   # e.g. [finance, health]
```

**Acceptance criteria:** with git auto-commit on, each capture batch produces one
commit; disabling it leaves no git side effects.

### 7.5 Reliability hardening `[P2]`

- Graceful shutdown (drain queue, close DB) on SIGTERM/SIGINT.
- Health/readiness endpoints for the daemon (`/health` exists; add `/ready`).
- Backoff/jitter on provider retries (queue has retries; add jitter + circuit
  breaker on repeated provider failure → degrade to heuristics).
- Input size limits + payload validation on webhook/email (DoS guard).
- Concurrency safety: single-writer lock on the vault to avoid interleaved writes
  from multiple inputs.

---

## 8. Epic E — Multi-user & privacy `[P3]`

**Problem:** families/teams want a shared brain with boundaries.

**Proposal:** a lightweight identity + visibility model, vault-expressed.

**Design**
- Each capture carries an `owner` (from input identity: Telegram user id, email
  sender, MCP token subject) recorded in frontmatter + `dumps`.
- Per-compartment visibility: `visibility: private|shared` in `compartments.yaml`;
  `private` compartments are owner-scoped.
- MCP/search/dashboard filter by the authenticated identity; `shared` content is
  visible to all allowed users.
- **Profiles / multiple vaults:** `--profile <name>` selects a config+vault+index
  triple so one install serves several brains.

**Acceptance criteria**
- User A cannot retrieve User B's `private` memories over MCP; `shared` learnings
  are visible to both; `reindex` reconstructs ownership from frontmatter.

**Risk/effort:** high. This is authorization — design carefully; default stays
single-user.

---

## 9. Epic F — Distribution & DX `[P2]`

- **npm publish:** `npm i -g dendrite` (bin already declared); add `prepublish`
  build, `files` allowlist, and a smoke-tested tarball in CI.
- **Docker image:** publish a multi-arch image (compose file exists); document
  vault mount + env.
- **Homebrew tap (optional):** formula wrapping the npm global install.
- **`dendrite init` upgrades:** provider presets picker (from
  `provider-presets.yaml`), model reachability test, Telegram enable, optional
  embeddings bootstrap — all non-interactive-flag capable for scripting.
- **Docs:** cookbook (per-input walkthroughs), architecture diagram refresh,
  troubleshooting matrix, and an `examples/` folder.

**Acceptance criteria:** a new user runs `npm i -g dendrite && dendrite init &&
dendrite ingest "..."` end-to-end without cloning.

---

## 10. Epic G — Extensibility (plugin/hook architecture) `[P3]`

**Problem:** every new input/step currently means core changes.

**Proposal:** stable extension points so third parties add inputs, pipeline
steps, and outputs without forking.

**Design**
- **Input plugins:** register an adapter that produces `Dump`s (the
  `ChatController` refactor in §4.3 is the first step).
- **Pipeline hooks:** ordered `pre-classify`, `post-classify`, `pre-write`,
  `post-write` hooks receiving typed context; e.g. a PII redactor or custom tagger
  plugs in without touching `pipeline.ts`.
- **Output/sink plugins:** mirror writes to external stores (e.g. push `tasks/` to
  a task manager) — read models stay in the vault.
- Plugins declared in config; loaded from a `plugins/` dir or npm packages;
  sandboxed error handling so a bad plugin can't crash ingestion.

**Acceptance criteria:** a sample "uppercase-tagger" plugin loads via config,
runs at `post-classify`, and is covered by a test; disabling it fully removes its
effect.

**Risk/effort:** high; do after §4.3 refactor lands.

---

## 11. Consolidated surface changes

New/changed **CLI** (all support `-c` and, where relevant, `--dry-run`):
`ask`, `today`, `review`, `merge`, `import <readwise|pocket|instapaper>`,
`eval`, `export`, `backup`, `capture` (TUI), `doctor --json`,
`migrate --to-flat|--to-folders|--retemplate`.

New/changed **MCP tools:** `answer_question`, `get_entity`, `list_entities`,
`related`, `timeline`, and gated `capture_note`. Existing 8 tools unchanged.

New/changed **HTTP:** `POST /ingest/email`, MCP-over-HTTP (`/mcp`),
`/metrics`, `/ready`; dashboard: graph view, search/ask box, cost panel.

New **SQLite tables** (all derived, rebuildable): `entities`, `edges`, `usage`,
`write_audit`. Existing tables unchanged except additive columns
(`dumps.owner`).

New **frontmatter fields** (additive; bump `dendrite_version` + `migrate`):
`owner`, `visibility`, `review_due`, `review_interval`, `source_url`,
`task_status`, `due`.

---

## 12. Cross-cutting config additions (summary)

```yaml
inputs:
  email: { ... }          # §4.1
mcp:
  http: { ... }           # §5.1
  write: { enabled: false, require_review: true }   # §5.2
retrieval: { k: 8, max_context_tokens: 4000 }        # §5.3
templates: { enabled: true, dir: templates }         # §6.1
growth: { max_sections: 25, policy: summarize }      # §6.2
graph: { enabled: false }                            # §6.3
tasks: { render: frontmatter }                       # §6.6 (extend existing)
review: { spaced_repetition: false }                 # §6.7
budget: { daily_usd: 1.0 }                           # §7.2
observability: { metrics: false, otel: false }       # §7.2
backup: { git_autocommit: false }                    # §7.4
security: { encrypted_compartments: [] }             # §7.4
profiles: { active: default }                        # §8
plugins: []                                          # §10
```

All new keys are **optional with safe defaults**; an existing `dendrite.config.yaml`
keeps working unchanged.

---

## 13. Testing & quality strategy

- **Unit:** heuristics (laundry-list, near-dup, growth cap, date parsing), entity
  resolution, template rendering, merge/backlink rewrite.
- **Integration:** each input adapter → pipeline → vault write (mock provider /
  recorded fixtures so CI needs no keys, mirroring `scripts/ci-smoke.mjs`).
- **Eval gate:** §7.1 golden set blocks classification regressions.
- **Idempotency:** every new input/importer re-run must be a no-op (assert on
  `dumps`/source ids).
- **Migration tests:** each `dendrite_version` bump has a round-trip fixture.
- **Determinism:** derived state (index, entities, edges) must be byte-stable
  across `reindex` runs on a fixed vault.
- Keep the existing `npm test` (31 checks) green; add suites per epic. Reference
  the local-LLM/offline setup in [AGENTS.md](AGENTS.md) → *Cursor Cloud specific
  instructions* for running the full suite without API keys.

---

## 14. Phased delivery (maps to ROADMAP versions)

- **v0.3 (quality & visibility):** §6.1 templates, §7.1 eval gate, §7.3 doctor,
  §5.3 RAG `ask`, §7.2 cost/observability (core). Distribution: §9 npm publish.
- **v0.4 (inputs):** §4.1 email, §4.2 browser, §4.5 importers/shortcuts,
  §4.3 chat adapters (+ `ChatController` refactor), §4.4 Obsidian plugin.
- **v0.5 (agent ecosystem & structure):** §5.1 remote MCP, §5.2 `capture_note`,
  §6.3 entity/graph, §6.4 merge-back, §6.6 tasks.
- **v1.0 (hardening & scale):** §6.2 growth cap, §6.5 flat mode, §7.4 backup/
  encryption, §7.5 reliability, §8 multi-user, §10 plugin architecture.

---

## 15. Open questions

1. **Graph store:** stay in SQLite (`edges`) or emit Obsidian-canvas/JSON for
   external graph tools? (Leaning SQLite + optional export.)
2. **Encryption vs plain-file principle:** encrypted compartments break
   readability by other agents — opt-in only, or out of scope for v1?
3. **Multi-user auth:** is per-token identity enough, or do we need real accounts?
   (Prefer token identity; avoid becoming an auth server.)
4. **RAG guardrails:** how strict should "refuse if not in vault" be vs. allowing
   general reasoning over retrieved notes?
5. **Plugin trust model:** first-party-only registry vs. arbitrary npm packages?

---

*This spec is intentionally additive and backward-compatible. Implement features
behind config flags, keep the vault authoritative, and land an eval/test suite
with each epic. Feedback and reprioritization welcome — open an issue with the
`[spec]` label referencing the section number.*
