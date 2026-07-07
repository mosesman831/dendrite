#!/usr/bin/env node
/**
 * CI smoke tests — no API keys required.
 * Full LLM integration: npm test (local or with GitHub secrets).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const failures = [];

function pass(name, detail = "") {
  console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
}

function fail(name, detail = "") {
  failures.push({ name, detail });
  console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
}

function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT, env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function main() {
  console.log("\n=== BUILD ===");
  const build = await run("npm", ["run", "build"]);
  if (build.code === 0) pass("build");
  else {
    fail("build", build.stderr.slice(0, 200));
    return summary();
  }

  console.log("\n=== LAUNDRY-LIST HEURISTIC (unit) ===");
  try {
    const { detectLaundryListClauses } = await import(
      join(ROOT, "dist", "pipeline", "multi-classify.js")
    );
    const clauses = detectLaundryListClauses(
      "My son goes to Riverside Academy and my daughter goes to Northfield High and I like steak medium rare",
    );
    if (clauses && clauses.length >= 2) pass("detectLaundryListClauses", `${clauses.length} clauses`);
    else fail("detectLaundryListClauses", `got ${clauses?.length ?? 0}`);
  } catch (e) {
    fail("laundry heuristic", e.message);
  }

  console.log("\n=== NOTE SECTIONS ===");
  try {
    const { parseCaptureSections } = await import(join(ROOT, "dist", "util", "note-sections.js"));
    const sample =
      "# Title\n\n## 2026-07-07 12:00 · via cli\nFirst.\n\n## 2026-07-07 12:01 · via telegram-text\nSecond.";
    const secs = parseCaptureSections(sample);
    if (secs.length === 2) pass("parseCaptureSections");
    else fail("parseCaptureSections", `got ${secs.length}`);
  } catch (e) {
    fail("note sections", e.message);
  }

  console.log("\n=== EMBEDDINGS UTIL ===");
  try {
    const { cosineSimilarity, vectorToBlob, blobToVector } = await import(
      join(ROOT, "dist", "providers", "embeddings.js")
    );
    const a = [1, 0, 0];
    const round = blobToVector(vectorToBlob(a));
    if (cosineSimilarity(a, a) === 1 && round[0] === 1) pass("embedding vector roundtrip");
    else fail("embedding vector roundtrip");
  } catch (e) {
    fail("embeddings util", e.message);
  }

  console.log("\n=== INDEX + REINDEX ===");
  try {
    const { loadConfig } = await import(join(ROOT, "dist", "config.js"));
    const { DendriteIndex } = await import(join(ROOT, "dist", "pipeline", "index.js"));
    const { config } = loadConfig();
    const index = new DendriteIndex(config.index.db_path);
    const count = index.reindexVault(config.vault.path);
    if (count >= 2) pass("reindex", `${count} notes`);
    else fail("reindex", `only ${count} notes`);
    const hits = index.search("Germany", undefined, 5);
    if (hits.length > 0) pass("FTS search", `${hits.length} hits`);
    else fail("FTS search", "no hits");
  } catch (e) {
    fail("index", e.message);
  }

  console.log("\n=== CLI SMOKE ===");
  for (const [label, args] of [
    ["migrate dry-run", ["dist/cli.js", "migrate", "--dry-run"]],
    ["repair dry-run", ["dist/cli.js", "repair", "--dry-run"]],
    ["inbox", ["dist/cli.js", "inbox"]],
  ]) {
    const { code } = await run("node", args);
    if (code === 0) pass(label);
    else fail(label, `exit ${code}`);
  }

  return summary();
}

function summary() {
  console.log("\n========================================");
  if (failures.length === 0) {
    console.log("PASSED (smoke)");
    console.log("\nSmoke tests passed (no API keys required).");
    process.exit(0);
  }
  console.log(`FAILED: ${failures.length}`);
  for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
  process.exit(1);
}

main();
