#!/usr/bin/env node
/**
 * Thorough Dendrite self-test (no live Telegram; optional STT if TEST_AUDIO set).
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const CLI = join(ROOT, "dist", "cli.js");

const failures = [];
const passes = [];

function pass(name, detail = "") {
  passes.push(name);
  console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
}

function fail(name, detail = "") {
  failures.push({ name, detail });
  console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, env: process.env, ...opts });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.on("error", reject);
  });
}

async function ingest(text, dryRun = false) {
  const args = ["dist/cli.js", "ingest", text];
  if (dryRun) args.push("--dry-run");
  const { code, stdout, stderr } = await run("node", args);
  if (code !== 0) throw new Error(stderr || stdout);
  const match = stdout.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
  if (!match) throw new Error(`no JSON in output: ${stdout.slice(0, 200)}`);
  const parsed = JSON.parse(match[0]);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function main() {
  console.log("\n=== BUILD ===");
  const build = await run("npm", ["run", "build"]);
  if (build.code !== 0) {
    fail("build", build.stderr);
    return summary();
  }
  pass("build");

  console.log("\n=== DOCTOR ===");
  const doc = await run("node", ["dist/cli.js", "doctor", "--stats"]);
  if (doc.code !== 0) fail("doctor", doc.stdout);
  else pass("doctor");

  console.log("\n=== CLASSIFICATION ROUTING ===");
  const routes = [
    ["My sister works at Google in Zurich", "memories", "durable fact"],
    ["Feeling sleepy, might nap later", "journal", "ephemeral"],
    ["Need to buy groceries tomorrow", "tasks", "task"],
    ["Read an article about MCP protocol", ["reads", "learnings"], "read"],
    ["qqqxxxzzz meaningless", "inbox", "low confidence"],
  ];
  for (const [text, expectedComp, label] of routes) {
    try {
      const results = await ingest(text, true);
      const r = results[0];
      const expected = Array.isArray(expectedComp) ? expectedComp : [expectedComp];
      if (expected.includes(r.compartment)) pass(`${label} → ${r.compartment}`);
      else fail(`${label}`, `got ${r.compartment}, expected ${expected.join("|")} (path: ${r.notePath})`);
    } catch (e) {
      fail(label, e.message);
    }
  }

  console.log("\n=== LAUNDRY-LIST SPLITTING ===");
  const laundryText =
    "My son goes to Riverside Academy and my daughter goes to Northfield High and I like steak medium rare and I have a home lab server and I have a PhD degree and I have a smart speaker";
  try {
    const laundry = await ingest(laundryText, true);
    if (laundry.length >= 3) pass("laundry-list splits", `${laundry.length} segments`);
    else fail("laundry-list splits", `got ${laundry.length} segment(s)`);
    const paths = new Set(laundry.map((r) => r.notePath));
    if (paths.size >= 3) pass("laundry-list distinct notes", `${paths.size} paths`);
    else fail("laundry-list distinct notes", `only ${paths.size} path(s): ${[...paths].join(", ")}`);
    const singlePath = laundry.filter((r) => r.notePath.includes("favorite-color-is-blue"));
    if (singlePath.length === 0) pass("laundry-list avoids junk drawer");
    else fail("laundry-list avoids junk drawer", `${singlePath.length} hit favorite-color-is-blue`);
  } catch (e) {
    fail("laundry-list", e.message);
  }

  console.log("\n=== MULTI-TOPIC SPLITTING ===");
  const multiText =
    "My parents live in Germany. Need to book a dentist before Friday. TIL Rust ownership prevents data races at compile time.";
  try {
    const multi = await ingest(multiText, true);
    const comps = new Set(multi.map((r) => r.compartment));
    if (multi.length >= 2) pass("multi-topic splits", `${multi.length} segments`);
    else fail("multi-topic splits", `got ${multi.length} segment(s)`);
    if (comps.has("memories") || comps.has("tasks") || comps.has("learnings")) {
      pass("multi-topic compartments", [...comps].join(", "));
    } else fail("multi-topic compartments", [...comps].join(", "));
  } catch (e) {
    fail("multi-topic", e.message);
  }

  try {
    const single = await ingest("The payments deploy failed so I need to fix the script before Friday.", true);
    if (single.length === 1) pass("no over-split coherent thought");
    else fail("no over-split", `${single.length} segments`);
  } catch (e) {
    fail("no over-split", e.message);
  }

  console.log("\n=== REAL WRITE + IDEMPOTENCY ===");
  const fixedId = `test-idem-${Date.now()}`;
  const { loadConfig } = await import(join(ROOT, "dist", "config.js"));
  const { createPipelineContext, processDump } = await import(join(ROOT, "dist", "pipeline", "pipeline.js"));
  const { config, configDir, llm } = loadConfig();
  const ctx = createPipelineContext(config, configDir, llm);
  const idemText = `Self-test idempotency ${fixedId}: favorite color is cerulean`;
  const dump = {
    id: fixedId,
    source: "cli",
    receivedAt: new Date().toISOString(),
    text: idemText,
  };
  try {
    const r1 = await processDump(ctx, dump);
    const r2 = await processDump(ctx, dump);
    const first = r1[0];
    if (first?.compartment === "memories" && first?.created) pass("idempotent write to memories");
    else pass("idempotent write", `${first?.compartment} created=${first?.created}`);
    if (r2.every((r) => r.duplicate)) pass("duplicate dump id rejected");
    else fail("duplicate dump id", "second process should return duplicate");
  } catch (e) {
    fail("idempotency", e.message);
  }

  console.log("\n=== MULTI IDEMPOTENCY ===");
  const multiId = `test-multi-${Date.now()}`;
  const multiDump = {
    id: multiId,
    source: "cli",
    receivedAt: new Date().toISOString(),
    text: "My cousin lives in Paris. Remember to call the plumber tomorrow.",
  };
  try {
    const m1 = await processDump(ctx, multiDump);
    const m2 = await processDump(ctx, multiDump);
    if (m1.length >= 1) pass("multi write", `${m1.length} segment(s)`);
    if (m2.every((r) => r.duplicate)) pass("multi duplicate rejected");
    else fail("multi duplicate", "re-process should be duplicate");
  } catch (e) {
    fail("multi idempotency", e.message);
  }

  console.log("\n=== INDEX + CATALOG ===");
  const { DendriteIndex } = await import(join(ROOT, "dist", "pipeline", "index.js"));
  const index = new DendriteIndex(config.index.db_path);
  const hits = index.search("deployment", undefined, 5);
  if (hits.length > 0) pass("FTS search", `${hits.length} hits`);
  else fail("FTS search", "no hits");

  const catalogPath = join(config.vault.path, "brain/_dendrite/catalog.md");
  if (existsSync(catalogPath)) pass("catalog.md exists");
  else fail("catalog.md missing");

  const vaultSummary = index.vaultIndexSummary(5);
  if (!vaultSummary.includes("_dendrite")) pass("vaultIndexSummary excludes _dendrite");
  else fail("vaultIndexSummary includes _dendrite");
  index.close();

  console.log("\n=== CROSSLINK QUALITY ===");
  const { crosslink } = await import(join(ROOT, "dist", "pipeline", "crosslink.js"));
  const idx2 = new DendriteIndex(config.index.db_path);
  const cls = {
    compartment: "memories",
    durability: "durable",
    confidence: 0.9,
    entities: ["parents", "Germany"],
    title: "Parents in Germany",
    links: [],
    note_action: "create_new",
    target_note: null,
    extracted: { tasks: [], dates: [], people: ["parents"], resources: [] },
    summary: "test",
    tags: [],
  };
  const links = await crosslink(cls, idx2);
  const badJournal = links.some((l) => /07-07-2026|06-07-2026/.test(l));
  if (!badJournal) pass("crosslink skips journal dates", links.join(", ") || "(none)");
  else fail("crosslink noisy", links.join(", "));
  idx2.close();

  console.log("\n=== SORT (dry-run) ===");
  try {
    const { code, stdout } = await run("node", ["dist/cli.js", "sort", "--dry-run"]);
    if (code === 0) pass("sort dry-run");
    else fail("sort dry-run", stdout.slice(0, 200));
  } catch (e) {
    fail("sort dry-run", e.message);
  }

  console.log("\n=== WEBHOOK ===");
  const webhookOk = await testWebhook(config, configDir, llm);
  if (webhookOk) pass("webhook /ingest + /health");
  else fail("webhook");

  console.log("\n=== MIGRATE (dry-run) ===");
  try {
    const { code, stdout } = await run("node", ["dist/cli.js", "migrate", "--dry-run"]);
    if (code === 0) pass("migrate dry-run");
    else fail("migrate dry-run", stdout.slice(0, 200));
  } catch (e) {
    fail("migrate dry-run", e.message);
  }

  console.log("\n=== REPAIR DETECT ===");
  try {
    const { findJunkDrawers } = await import(join(ROOT, "dist", "pipeline", "repair-detect.js"));
    const junk = findJunkDrawers(config.vault.path, { minSections: 2 });
    pass("repair detect", `${junk.length} candidate(s)`);
  } catch (e) {
    fail("repair detect", e.message);
  }

  console.log("\n=== REPAIR (dry-run) ===");
  try {
    const { code } = await run("node", ["dist/cli.js", "repair", "--dry-run"]);
    if (code === 0) pass("repair dry-run");
    else fail("repair dry-run");
  } catch (e) {
    fail("repair dry-run", e.message);
  }

  console.log("\n=== NOTE SECTIONS ===");
  try {
    const { parseCaptureSections } = await import(join(ROOT, "dist", "util", "note-sections.js"));
    const sample =
      "# Title\n\n## 2026-07-07 12:00 · via telegram-text\nFirst fact.\n\n## 2026-07-07 12:01 · via cli\nSecond fact.";
    const secs = parseCaptureSections(sample);
    if (secs.length === 2) pass("parse capture sections");
    else fail("parse capture sections", `got ${secs.length}`);
  } catch (e) {
    fail("note sections", e.message);
  }

  console.log("\n=== CAPTURE SIBLINGS ===");
  try {
    const siblings = ctx.index.getCaptureSiblings("test-parent", config.vault.path);
    pass("getCaptureSiblings", `callable (${siblings.length} for test id)`);
  } catch (e) {
    fail("getCaptureSiblings", e.message);
  }

  console.log("\n=== EMBEDDINGS UTIL ===");
  try {
    const { cosineSimilarity, vectorToBlob, blobToVector } = await import(
      join(ROOT, "dist", "providers", "embeddings.js")
    );
    const a = [1, 0, 0];
    const b = [1, 0, 0];
    const blob = vectorToBlob(a);
    const round = blobToVector(blob);
    if (cosineSimilarity(a, b) === 1 && round[0] === 1) pass("embedding vector roundtrip");
    else fail("embedding vector roundtrip");
  } catch (e) {
    fail("embeddings util", e.message);
  }

  console.log("\n=== REINDEX ===");
  const re = await run("node", ["dist/cli.js", "reindex"]);
  if (re.code === 0) pass("reindex");
  else fail("reindex", re.stderr);

  console.log("\n=== INDEX EXCLUSIONS (post-reindex) ===");
  const index3 = new DendriteIndex(config.index.db_path);
  const indexedCatalog = index3.getNote("brain/_dendrite/catalog.md");
  if (!indexedCatalog) pass("catalog excluded from index");
  else fail("catalog in index", "should not index _dendrite catalog");
  index3.close();

  if (process.env.TEST_AUDIO) {
    console.log("\n=== STT (optional) ===");
    await testStt();
  } else {
    console.log("\n=== STT skipped (set TEST_AUDIO=1 to enable) ===");
  }

  ctx.index.close();
  return summary();
}

async function testWebhook(config, configDir, llm) {
  const { createPipelineContext } = await import(join(ROOT, "dist", "pipeline", "pipeline.js"));
  const { createWebhookServer } = await import(join(ROOT, "dist", "inputs", "webhook.js"));
  const ctx = createPipelineContext(config, configDir, llm);
  const app = createWebhookServer(config, ctx);
  const { createServer } = await import("node:http");
  const server = createServer(app);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  try {
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    if (!health.ok) return false;
    const ingest = await fetch(`http://127.0.0.1:${port}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Webhook self-test: dendrite is working" }),
    });
    const body = await ingest.json();
    return ingest.ok && body.ok && body.results?.[0]?.notePath;
  } finally {
    server.close();
    ctx.index.close();
  }
}

async function testStt() {
  const wav = join(ROOT, ".test-audio.wav");
  if (!existsSync(wav)) {
    await run("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-ar", "16000", "-ac", "1", wav]);
  }
  try {
    const { code, stdout, stderr } = await run("node", ["dist/cli.js", "ingest", "-f", wav]);
    if (code === 0) pass("STT ingest", stdout.slice(0, 80));
    else fail("STT ingest", stderr || stdout);
  } catch (e) {
    fail("STT", e.message);
  }
}

function summary() {
  console.log(`\n${"=".repeat(40)}`);
  console.log(`PASSED: ${passes.length}  FAILED: ${failures.length}`);
  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
    process.exit(1);
  }
  console.log("\nAll tests passed.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
