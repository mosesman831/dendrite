import type { Express, Request, Response } from "express";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";
import type { PipelineContext } from "../pipeline/pipeline.js";
import type { DendriteConfig } from "../config.js";
import type { CompartmentsFile } from "../types.js";
import { loadCompartments } from "../config.js";
import { moveNoteToCompartment, deleteNote, approveNote } from "../pipeline/triage.js";
import { answerQuestion } from "../pipeline/answer.js";
import type { DendriteIndex } from "../pipeline/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Views are at ../../src/views/dashboard/ relative to dist/inputs/
const VIEWS_DIR = join(__dirname, "..", "..", "src", "views", "dashboard");

function validatePath(path: string): boolean {
  return path.startsWith("brain/") && !path.includes("..");
}

function checkAuth(config: DendriteConfig, req: Request): boolean {
  const token = process.env[config.inputs.webhook.tokenEnv];
  if (!token) return true;
  const expected = `Bearer ${token}`;
  return req.headers.authorization === expected;
}

function authFail(res: Response): void {
  res.status(401).json({ ok: false, error: "unauthorized" });
}

function countDanglingLinks(vaultPath: string, index: DendriteIndex): number {
  const notes = index.listAllNotes();
  const knownSlugs = new Set<string>();
  for (const note of notes) {
    const slug = note.path.replace(/\.md$/i, "").split("/").pop();
    if (slug) knownSlugs.add(slug.toLowerCase());
  }

  const wikilinkRe = /\[\[([^\]]+)\]\]/g;
  const journalRe = /^\d{2}-\d{2}-\d{4}$/;
  let dangling = 0;

  for (const note of notes) {
    const fullPath = join(vaultPath, note.path);
    if (!existsSync(fullPath)) continue;
    let text: string;
    try {
      text = readFileSync(fullPath, "utf8");
    } catch {
      continue;
    }
    let match: RegExpExecArray | null;
    while ((match = wikilinkRe.exec(text)) !== null) {
      const raw = match[1];
      const target = raw.split(/[|#]/)[0].trim().toLowerCase();
      if (!target) continue;
      if (journalRe.test(target)) continue;
      if (!knownSlugs.has(target)) dangling += 1;
    }
  }

  return dangling;
}

export function mountDashboard(
  app: Express,
  ctx: PipelineContext,
  compartments: CompartmentsFile,
  config: DendriteConfig,
): void {
  const index = ctx.index;
  const vaultPath = config.vault.path;

  // --- Static files ---
  app.get("/dashboard", (_req, res) => {
    const html = readFileSync(join(VIEWS_DIR, "index.html"), "utf8");
    res.type("html").send(html);
  });

  app.get("/dashboard/style.css", (_req, res) => {
    const css = readFileSync(join(VIEWS_DIR, "style.css"), "utf8");
    res.type("css").send(css);
  });

  app.get("/dashboard/app.js", (_req, res) => {
    const js = readFileSync(join(VIEWS_DIR, "app.js"), "utf8");
    res.type("application/javascript").send(js);
  });

  app.get("/api/health", (_req, res) => {
    const total = index.listAllNotes().length;
    const embedded = index.countEmbeddings();
    const pct = total ? Math.round((embedded / total) * 100) : 0;
    res.json({
      ok: true,
      vault: vaultPath,
      embeddings_enabled: config.index.embeddings.enabled,
      embedding_coverage: { embedded, total, pct },
      queue: index.queueStatusCounts(),
      dangling_links: countDanglingLinks(vaultPath, index),
    });
  });

  app.post("/api/ask", async (req, res) => {
    const question = String(req.body?.question ?? "").trim();
    if (!question) {
      res.status(400).json({ ok: false, error: "question required" });
      return;
    }
    try {
      const result = await answerQuestion(index, vaultPath, question, config, ctx.llm);
      res.json({ ok: true, ...result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: msg });
    }
  });

  // --- Read endpoints ---
  app.get("/api/stats", (_req, res) => {
    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const startWeek = new Date(now.getTime() - 7 * 86400000).toISOString();

    const inboxCount = index.listInboxNotes().length;
    const todayCount = index.countDumpsSince(startToday);
    const weekCount = index.countDumpsSince(startWeek);
    const totalNotes = index.listAllNotes().length;

    const compCounts = index.compartmentCounts();
    const compList = Object.entries(compartments.compartments).map(([name, def]) => ({
      name,
      count: compCounts[name] ?? 0,
      description: def.description,
    }));
    compList.push({
      name: "inbox",
      count: compCounts["inbox"] ?? 0,
      description: compartments.inbox.description,
    });

    const recentDumps = index.recentDumpsWithNotes(1);
    const latest = recentDumps.length > 0 ? recentDumps[0] : null;

    res.json({
      inbox_count: inboxCount,
      today_count: todayCount,
      week_count: weekCount,
      total_notes: totalNotes,
      compartments: compList,
      latest_capture: latest
        ? {
            path: latest.path,
            title: latest.title,
            compartment: latest.compartment,
            confidence: latest.confidence,
            source: latest.source,
            received_at: latest.received_at,
          }
        : null,
    });
  });

  app.get("/api/inbox", (_req, res) => {
    const inboxNotes = index.listInboxNotes();
    const results = inboxNotes.map((note) => {
      const absPath = join(vaultPath, note.path);
      let confidence = 0;
      let source = "unknown";
      let created = note.updated_at;
      let bodyPreview = note.summary;

      if (existsSync(absPath)) {
        try {
          const raw = readFileSync(absPath, "utf8");
          const parsed = matter(raw);
          const data = parsed.data as Record<string, unknown>;
          confidence = Number(data.confidence ?? 0);
          source = String(data.source ?? "unknown");
          created = String(data.created ?? note.updated_at);
          bodyPreview = parsed.content.slice(0, 300).replace(/\s+/g, " ").trim();
        } catch {
          // Use SQLite fallback values
        }
      }

      return {
        path: note.path,
        title: note.title,
        compartment: note.compartment,
        confidence,
        source,
        created,
        entities: note.entities,
        tags: note.tags,
        summary: note.summary,
        body_preview: bodyPreview,
        split_group: (() => {
          if (!existsSync(absPath)) return undefined;
          try {
            const raw = readFileSync(absPath, "utf8");
            const parsed = matter(raw);
            return parsed.data.split_group ? String(parsed.data.split_group) : undefined;
          } catch {
            return undefined;
          }
        })(),
      };
    });

    results.sort((a, b) => (b.created > a.created ? 1 : -1));
    res.json(results);
  });

  app.get("/api/recent", (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const notes = index.recentDumpsWithNotes(limit);
    res.json(
      notes.map((n) => ({
        path: n.path,
        title: n.title,
        compartment: n.compartment,
        confidence: n.confidence,
        source: n.source,
        summary: n.summary,
        received_at: n.received_at,
        updated_at: n.updated_at,
      })),
    );
  });

  app.get("/api/compartments", (_req, res) => {
    const compCounts = index.compartmentCounts();
    const list = Object.entries(compartments.compartments).map(([name, def]) => ({
      name,
      path: def.path,
      description: def.description,
      count: compCounts[name] ?? 0,
    }));
    list.push({
      name: "inbox",
      path: compartments.inbox.path,
      description: compartments.inbox.description,
      count: compCounts["inbox"] ?? 0,
    });
    res.json(list);
  });

  app.get("/api/note", (req, res) => {
    const path = String(req.query.path ?? "");
    if (!validatePath(path)) {
      res.status(400).json({ ok: false, error: "Invalid path" });
      return;
    }
    const abs = join(vaultPath, path);
    if (!existsSync(abs)) {
      res.status(404).json({ ok: false, error: "Note not found" });
      return;
    }
    const raw = readFileSync(abs, "utf8");
    const parsed = matter(raw);
    res.json({
      path,
      frontmatter: parsed.data,
      body: parsed.content,
    });
  });

  app.get("/api/corrections", (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 10, 100);
    res.json(index.getRecentCorrections(limit));
  });

  // --- Write endpoints (triage) ---
  app.post("/api/triage/approve", (req, res) => {
    if (!checkAuth(config, req)) return authFail(res);
    const path = String(req.body?.path ?? "");
    if (!validatePath(path)) {
      res.status(400).json({ ok: false, error: "Invalid path" });
      return;
    }
    try {
      const result = approveNote(vaultPath, index, path, compartments, config);
      res.json({ ok: true, ...result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ ok: false, error: msg });
    }
  });

  app.post("/api/triage/reclassify", (req, res) => {
    if (!checkAuth(config, req)) return authFail(res);
    const path = String(req.body?.path ?? "");
    const compartment = String(req.body?.compartment ?? "");
    if (!validatePath(path)) {
      res.status(400).json({ ok: false, error: "Invalid path" });
      return;
    }
    if (!compartment) {
      res.status(400).json({ ok: false, error: "compartment required" });
      return;
    }
    try {
      const result = moveNoteToCompartment(vaultPath, index, path, compartment, compartments, config);
      res.json({ ok: true, ...result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ ok: false, error: msg });
    }
  });

  app.post("/api/triage/reject", (req, res) => {
    if (!checkAuth(config, req)) return authFail(res);
    const path = String(req.body?.path ?? "");
    if (!validatePath(path)) {
      res.status(400).json({ ok: false, error: "Invalid path" });
      return;
    }
    try {
      const result = deleteNote(vaultPath, index, path);
      res.json({ ok: true, ...result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ ok: false, error: msg });
    }
  });
}