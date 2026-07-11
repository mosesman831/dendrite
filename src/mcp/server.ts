import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { loadConfig, loadCompartments } from "../config.js";
import { DendriteIndex } from "../pipeline/index.js";
import { smartSearch } from "../pipeline/search.js";
import { answerQuestion } from "../pipeline/answer.js";
import { FRONTMATTER_CONTRACT } from "../types.js";
import matter from "gray-matter";

export async function startMcpServer(configPath?: string): Promise<void> {
  const { config, configDir, llm } = loadConfig(configPath);
  const compartments = loadCompartments(config, configDir);
  const index = new DendriteIndex(config.index.db_path);

  const server = new McpServer({
    name: "dendrite",
    version: "0.1.0",
  });

  server.tool(
    "search_vault",
    "Search the Obsidian vault index by keyword",
    {
      query: z.string(),
      compartment: z.string().optional(),
      limit: z.number().optional(),
    },
    async ({ query, compartment, limit }) => {
      const hits = await smartSearch(index, query, config, llm, {
        compartment,
        limit: limit ?? 10,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(hits, null, 2) }],
      };
    },
  );

  server.tool(
    "answer_question",
    "Answer a natural-language question using ONLY vault notes, with [[wikilink]] citations. Read-only RAG; refuses when nothing relevant is found.",
    { question: z.string(), compartment: z.string().optional(), k: z.number().optional() },
    async ({ question, compartment, k }) => {
      const result = await answerQuestion(index, config.vault.path, question, config, llm, { compartment, k });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "read_note",
    "Read a note from the vault by relative path",
    { path: z.string() },
    async ({ path }) => {
      const abs = join(config.vault.path, path);
      if (!existsSync(abs)) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "not found" }) }] };
      }
      const raw = readFileSync(abs, "utf8");
      const { data, content } = matter(raw);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ frontmatter: data, body: content }, null, 2),
          },
        ],
      };
    },
  );

  server.tool("list_compartments", "List brain compartments and note counts", {}, async () => {
    const list = Object.entries(compartments.compartments).map(([name, def]) => {
      const count = index.db
        .prepare(`SELECT COUNT(*) as c FROM notes WHERE compartment = ?`)
        .get(name) as { c: number };
      return { name, path: def.path, description: def.description, count: count.c };
    });
    list.push({
      name: "inbox",
      path: compartments.inbox.path,
      description: compartments.inbox.description,
      count: (index.db.prepare(`SELECT COUNT(*) as c FROM notes WHERE compartment = 'inbox'`).get() as { c: number }).c,
    });
    return { content: [{ type: "text", text: JSON.stringify(list, null, 2) }] };
  });

  server.tool(
    "vault_catalog",
    "Return the full vault index: all notes grouped by compartment with paths, titles, summaries",
    { compartment: z.string().optional() },
    async ({ compartment }) => {
      let notes = index.listAllNotes();
      if (compartment) notes = notes.filter((n) => n.compartment === compartment);
      const counts = index.compartmentCounts();
      const catalogPath = join(config.vault.path, "brain/_dendrite/catalog.md");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                db_path: config.index.db_path,
                catalog_md: existsSync(catalogPath) ? "brain/_dendrite/catalog.md" : null,
                counts,
                notes,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "recent_notes",
    "List recently updated notes",
    {
      compartment: z.string().optional(),
      since: z.string().optional(),
      limit: z.number().optional(),
    },
    async ({ compartment, since, limit }) => {
      const notes = index.recentNotes(compartment, since, limit ?? 10);
      return { content: [{ type: "text", text: JSON.stringify(notes, null, 2) }] };
    },
  );

  server.tool(
    "get_backlinks",
    "Find notes that link to the given note path",
    { path: z.string() },
    async ({ path }) => {
      const slug = path.replace(/\.md$/, "").split("/").pop() ?? path;
      const hits = index.search(slug, undefined, 20);
      const backlinks = hits.filter((h) => h.path !== path);
      return { content: [{ type: "text", text: JSON.stringify(backlinks, null, 2) }] };
    },
  );

  server.tool(
    "get_capture_siblings",
    "Reconstruct a multi-segment capture by parent dump id or split_group frontmatter value",
    { split_group: z.string() },
    async ({ split_group }) => {
      const siblings = index.getCaptureSiblings(split_group, config.vault.path);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                parentId: split_group.includes("#") ? split_group.replace(/#\d+$/, "") : split_group,
                segmentCount: siblings.length,
                siblings,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "describe_schema",
    "Return compartment list and frontmatter contract for agent self-configuration",
    {},
    async () => {
      const schema = {
        version: FRONTMATTER_CONTRACT.version,
        compartments: {
          ...compartments.compartments,
          inbox: compartments.inbox,
        },
        frontmatter_contract: FRONTMATTER_CONTRACT.fields,
        vault_path: config.vault.path,
      };
      return { content: [{ type: "text", text: JSON.stringify(schema, null, 2) }] };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
