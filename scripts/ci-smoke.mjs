#!/usr/bin/env node
/**
 * CI smoke tests — no API keys required.
 * Full LLM integration: npm test (local or with GitHub secrets).
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

  console.log("\n=== DUMP TEXT ROUNDTRIP ===");
  try {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join: pathJoin } = await import("node:path");
    const { DendriteIndex } = await import(join(ROOT, "dist", "pipeline", "index.js"));
    const tmpDir = mkdtempSync(pathJoin(tmpdir(), "dendrite-smoke-"));
    const dbPath = pathJoin(tmpDir, "test.db");
    const index = new DendriteIndex(dbPath);
    const parentId = "smoke-parent-1";
    const transcript = "Original capture transcript for sibling reconstruction";
    index.recordDump(
      parentId,
      "cli",
      new Date().toISOString(),
      "brain/inbox/smoke-test.md",
      "inbox",
      0.85,
      transcript,
    );
    const siblings = index.getCaptureSiblings(parentId);
    index.close();
    rmSync(tmpDir, { recursive: true, force: true });
    if (siblings.length === 1 && siblings[0].transcript === transcript)
      pass("recordDump+getCaptureSiblings text", "transcript roundtrip");
    else
      fail(
        "recordDump+getCaptureSiblings text",
        `transcript=${JSON.stringify(siblings[0]?.transcript)}`,
      );
  } catch (e) {
    fail("dump text roundtrip", e.message);
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

  console.log("\n=== MERGE NOTES (unit) ===");
  try {
    const {
      mergeFrontmatter,
      mergeNoteBodies,
      rewriteWikilinks,
      noteSlugFromPath,
    } = await import(join(ROOT, "dist", "pipeline", "merge-notes.js"));

    const fm = mergeFrontmatter(
      { title: "A", compartment: "tasks", created: "2026-02-01T00:00:00.000Z", entities: ["x"] },
      { title: "B", compartment: "reads", created: "2026-01-01T00:00:00.000Z", updated: "2026-03-01T00:00:00.000Z", entities: ["y"], tags: ["t"] },
    );
    if (
      fm.title === "A" &&
      fm.compartment === "tasks" &&
      fm.created === "2026-01-01T00:00:00.000Z" &&
      fm.updated === "2026-03-01T00:00:00.000Z" &&
      JSON.stringify(fm.entities) === JSON.stringify(["x", "y"]) &&
      JSON.stringify(fm.tags) === JSON.stringify(["t"])
    ) {
      pass("mergeFrontmatter");
    } else fail("mergeFrontmatter", JSON.stringify(fm));

    const sampleA =
      "# One\n\n## 2026-07-07 12:00 · via cli\nFirst.\n\n## 2026-07-07 12:01 · via telegram-text\nShared.";
    const sampleB =
      "# Two\n\n## 2026-07-07 12:01 · via telegram-text\nShared.\n\n## 2026-07-08 09:00 · via cli\nOnly B.";
    const merged = mergeNoteBodies(sampleA, sampleB);
    if (merged.mergedSectionCount === 3 && merged.survivorSectionCount === 2) {
      pass("mergeNoteBodies dedupe", `${merged.mergedSectionCount} sections`);
    } else {
      fail("mergeNoteBodies dedupe", `got ${merged.mergedSectionCount}`);
    }

    const { text, count } = rewriteWikilinks(
      "See [[foo]] and [[foo|alias]] plus [[bar]].",
      "foo",
      "baz",
    );
    if (count === 2 && text.includes("[[baz]]") && text.includes("[[baz|alias]]")) {
      pass("rewriteWikilinks");
    } else fail("rewriteWikilinks", `count=${count} text=${text}`);

    if (noteSlugFromPath("brain/tasks/my-note.md") === "my-note") pass("noteSlugFromPath");
    else fail("noteSlugFromPath");
  } catch (e) {
    fail("merge notes", e.message);
  }

  console.log("\n=== CLI SMOKE ===");
  for (const [label, args] of [
    ["migrate dry-run", ["dist/cli.js", "migrate", "--dry-run"]],
    ["repair dry-run", ["dist/cli.js", "repair", "--dry-run"]],
    ["merge dry-run", ["dist/cli.js", "merge", "brain/memories/parents-live-in-germany.md", "brain/learnings/agent-orchestration-uses-dag-instead-of-chain.md", "--dry-run"]],
    ["inbox", ["dist/cli.js", "inbox"]],
  ]) {
    const { code } = await run("node", args);
    if (code === 0) pass(label);
    else fail(label, `exit ${code}`);
  }

  console.log("\n=== VAULT PATH (flat org) ===");
  try {
    const { resolveBrainNotePath } = await import(join(ROOT, "dist", "util", "vault-path.js"));
    const flat = resolveBrainNotePath("flat", "brain/learnings", "my-note");
    const folder = resolveBrainNotePath("folders", "brain/learnings", "my-note");
    const journal = resolveBrainNotePath("flat", "brain/journal", "2026-07-16", true);
    if (flat === "brain/my-note.md" && folder === "brain/learnings/my-note.md" && journal === "brain/journal/2026-07-16.md")
      pass("resolveBrainNotePath");
    else fail("resolveBrainNotePath", `flat=${flat} folder=${folder} journal=${journal}`);
  } catch (e) {
    fail("resolveBrainNotePath", e.message);
  }

  console.log("\n=== TASK CHECKBOX RENDER ===");
  try {
    const { renderTaskCheckboxLines } = await import(join(ROOT, "dist", "pipeline", "write.js"));
    const one = renderTaskCheckboxLines(["buy groceries"], ["2026-07-20"]);
    const many = renderTaskCheckboxLines(["a", "b"], ["2026-07-20"]);
    if (one === "- [ ] buy groceries 📅 2026-07-20" && many === "- [ ] a\n- [ ] b")
      pass("renderTaskCheckboxLines");
    else fail("renderTaskCheckboxLines", `one=${JSON.stringify(one)} many=${JSON.stringify(many)}`);
  } catch (e) {
    fail("renderTaskCheckboxLines", e.message);
  }

  console.log("\n=== CONFIG DEFAULTS ===");
  try {
    const { loadConfig } = await import(join(ROOT, "dist", "config.js"));
    const { config } = loadConfig();
    const k = config.retrieval?.k;
    const templatesEnabled = config.templates?.enabled;
    const maxCtx = config.retrieval?.max_context_chars;
    const org = config.organization;
    const taskRender = config.tasks?.render;
    if (k === 8 && templatesEnabled === true && maxCtx === 6000 && org === "folders" && taskRender === "frontmatter")
      pass("config: retrieval+templates+org defaults");
    else
      fail(
        "config: retrieval+templates+org defaults",
        `retrieval.k=${k} templates.enabled=${templatesEnabled} retrieval.max_context_chars=${maxCtx} organization=${org} tasks.render=${taskRender}`,
      );
  } catch (e) {
    fail("config defaults", e.message);
  }

  console.log("\n=== TEMPLATE RENDER (unit) ===");
  try {
    const { renderVars, renderTemplateBody } = await import(
      join(ROOT, "dist", "pipeline", "template.js")
    );
    const vars = {
      title: "T",
      summary: "S",
      source: "cli",
      date: "2026-01-01 00:00",
      compartment: "reads",
      entities: "a, b",
      tags: "x",
      links: "",
      capture: "## SECTION\nbody",
    };

    const a = renderVars("# {{title}} — {{summary}}", vars);
    if (a === "# T — S") pass("template render A");
    else fail("template render A", `got ${JSON.stringify(a)}`);

    const b = renderTemplateBody({ frontmatter: {}, body: "# {{title}}", hasCapture: false }, vars);
    if (b.includes("# T") && b.includes("## SECTION")) pass("template render B");
    else fail("template render B", `got ${JSON.stringify(b)}`);

    const c = renderTemplateBody({ frontmatter: {}, body: "{{capture}}", hasCapture: true }, vars);
    if (c === vars.capture) pass("template render C");
    else fail("template render C", `got ${JSON.stringify(c)}`);
  } catch (e) {
    fail("template render", e.message);
  }

  console.log("\n=== EVAL DATASET ===");
  try {
    const datasetPath = join(ROOT, "eval", "dataset.jsonl");
    if (!existsSync(datasetPath)) {
      fail("eval dataset present", "eval/dataset.jsonl missing");
    } else {
      const raw = readFileSync(datasetPath, "utf8");
      const lines = raw
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith("#"));
      let badLine = null;
      let n = 0;
      for (const line of lines) {
        let obj;
        try {
          obj = JSON.parse(line);
        } catch (err) {
          badLine = `invalid JSON: ${line.slice(0, 80)}`;
          break;
        }
        const hasExpected =
          typeof obj.expected === "string" || typeof obj.expected_min_segments === "number";
        const hasText = typeof obj.text === "string" && obj.text.length > 0;
        if (!hasExpected || !hasText) {
          badLine = `missing fields: ${line.slice(0, 80)}`;
          break;
        }
        n++;
      }
      if (badLine) fail("eval dataset valid", badLine);
      else if (n >= 10) pass("eval dataset valid", `${n} cases`);
      else fail("eval dataset valid", `only ${n} cases`);
    }
  } catch (e) {
    fail("eval dataset", e.message);
  }

  console.log("\n=== GROWTH CAP (unit) ===");
  try {
    const { mkdtempSync, writeFileSync, readFileSync: readFs, existsSync: existsFs, mkdirSync } =
      await import("node:fs");
    const { join: joinPath } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const matter = (await import("gray-matter")).default;
    const { estimateTokens, countCaptureSections } = await import(
      join(ROOT, "dist", "util", "note-sections.js")
    );
    const { applyGrowthCap, noteExceedsGrowthCap } = await import(
      join(ROOT, "dist", "pipeline", "growth.js")
    );

    const sampleBody =
      "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi";
    const tok = estimateTokens(sampleBody);
    if (tok >= 10) pass("estimateTokens", `~${tok}`);
    else fail("estimateTokens", `got ${tok}`);

    const sectionSample = [
      "# Growth test",
      "",
      "## 2026-01-01 10:00 · via cli",
      "First capture line here.",
      "",
      "## 2026-01-02 10:00 · via cli",
      "Second capture line here.",
    ].join("\n");
    if (countCaptureSections(sectionSample) === 2) pass("countCaptureSections");
    else fail("countCaptureSections");

    const vaultTmp = mkdtempSync(joinPath(tmpdir(), "dendrite-growth-"));
    const noteRel = "brain/memories/growth-smoke.md";
    mkdirSync(joinPath(vaultTmp, "brain/memories"), { recursive: true });
    const sections = [];
    for (let i = 0; i < 8; i++) {
      sections.push(
        `## 2026-01-${String(i + 1).padStart(2, "0")} 10:00 · via cli`,
        `Capture body number ${i} with enough text to be distinct.`,
      );
    }
    const noteRaw = matter.stringify(
      ["# Growth smoke", "", ...sections].join("\n"),
      { compartment: "memories", title: "Growth smoke", dendrite_version: 1 },
    );
    writeFileSync(joinPath(vaultTmp, noteRel), noteRaw, "utf8");

    const offConfig = {
      growth: { max_sections: 3, max_tokens: 100, policy: "off" },
    };
    const offResult = applyGrowthCap(vaultTmp, noteRel, offConfig);
    const offAfter = matter(readFs(joinPath(vaultTmp, noteRel), "utf8"));
    if (!offResult.applied && !offAfter.content.includes("Summary (auto)"))
      pass("growth policy off no-op");
    else fail("growth policy off no-op");

    const sumConfig = {
      growth: { max_sections: 3, max_tokens: 6000, policy: "summarize" },
      organization: "folders",
    };
    const sumResult = applyGrowthCap(vaultTmp, noteRel, sumConfig, { keepRecent: 2 });
    const sumAfter = matter(readFs(joinPath(vaultTmp, noteRel), "utf8"));
    const sumSections = countCaptureSections(sumAfter.content);
    if (
      sumResult.applied &&
      sumResult.policy === "summarize" &&
      sumAfter.content.includes("## Summary (auto)") &&
      sumSections === 2
    )
      pass("growth summarize stub", `kept ${sumSections} sections`);
    else
      fail(
        "growth summarize stub",
        `applied=${sumResult.applied} sections=${sumSections}`,
      );

    const repairedDir = joinPath(vaultTmp, "brain/_dendrite/repaired");
    if (existsFs(repairedDir)) pass("growth archive created");
    else fail("growth archive created");

    const cap = noteExceedsGrowthCap(sectionSample, {
      growth: { max_sections: 1, max_tokens: 10, policy: "summarize" },
    });
    if (cap.exceeds && cap.sections === 2) pass("noteExceedsGrowthCap");
    else fail("noteExceedsGrowthCap");
  } catch (e) {
    fail("growth cap", e.message);
  }

  console.log("\n=== DOCTOR JSON ===");
  try {
    const doc = await run("node", ["dist/cli.js", "doctor", "--json"]);
    const trimmed = doc.stdout.trim();
    const parsed = trimmed ? JSON.parse(trimmed) : null;
    const hasSegment =
      typeof parsed?.segment_stats?.avg_segments_per_dump === "number";
    const hasCost =
      typeof parsed?.cost_estimate?.estimated_cost_usd_per_dump === "number" &&
      typeof parsed?.cost_estimate?.estimated_cost_usd_last_7d === "number";
    const hasWarnings = Array.isArray(parsed?.warnings);
    if (hasSegment && hasCost && hasWarnings) pass("doctor --json guardrail fields");
    else
      fail(
        "doctor --json guardrail fields",
        `segment=${hasSegment} cost=${hasCost} warnings=${hasWarnings}`,
      );
  } catch (e) {
    fail("doctor --json guardrail fields", e.message);
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
