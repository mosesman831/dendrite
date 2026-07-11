import { Bot, InlineKeyboard } from "grammy";
import { mkdirSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Dump, PipelineResult } from "../types.js";
import type { PipelineContext } from "../pipeline/pipeline.js";
import {
  enqueueAndProcess,
  formatPipelineReply,
  aggregateTier,
  drainQueue,
} from "../pipeline/pipeline.js";
import { loadCompartments, type DendriteConfig } from "../config.js";
import { undoCapture, resolveUndoTarget } from "../pipeline/remove.js";
import { previewSort, runSort, formatSortPreviewTelegram } from "../commands/sort.js";
import { answerQuestion } from "../pipeline/answer.js";
import type { Context } from "grammy";

const pendingSorts = new Map<number, { scope: "all" | "inbox" | "imports"; at: number }>();

const TELEGRAM_COMMANDS = [
  { command: "start", description: "Welcome — start capturing" },
  { command: "help", description: "List all commands" },
  { command: "inbox", description: "Review unfiled items" },
  { command: "recent", description: "Recently updated notes" },
  { command: "compartments", description: "List brain compartments" },
  { command: "sort", description: "Preview LLM vault sort (inbox + imports)" },
  { command: "undo", description: "Undo your last capture" },
  { command: "ask", description: "Ask a question answered from your vault" },
] as const;

export async function startTelegramBot(
  _configPath: string | undefined,
  ctx: PipelineContext,
): Promise<void> {
  const { config, configDir } = ctx;

  if (!config.inputs.telegram.enabled) {
    throw new Error("Telegram input is disabled in config");
  }

  const token = process.env[config.inputs.telegram.tokenEnv];
  if (!token) throw new Error(`Missing ${config.inputs.telegram.tokenEnv}`);

  const bot = new Bot(token);

  await bot.api.setMyCommands([...TELEGRAM_COMMANDS]);

  const allowed = new Set(config.inputs.telegram.allowed_user_ids);

  bot.command("start", (c) => {
    if (!isAllowed(c.from?.id, allowed)) return;
    return c.reply(
      "Dendrite ready. Send text or voice notes to capture.\n\nUse /help to see commands.",
    );
  });

  bot.command("help", async (c) => {
    if (!isAllowed(c.from?.id, allowed)) return;
    const lines = TELEGRAM_COMMANDS.map((cmd) => `/${cmd.command} — ${cmd.description}`);
    await c.reply(["Dendrite commands:", "", ...lines].join("\n"));
  });

  bot.command("inbox", async (c) => {
    if (!isAllowed(c.from?.id, allowed)) return;
    const items = ctx.index.listInboxNotes();
    if (!items.length) return c.reply("Inbox is empty.");
    const lines = items.slice(0, 10).map((n) => `- ${n.title} (\`${n.path}\`)`);
    await c.reply(`Inbox:\n${lines.join("\n")}`);
  });

  bot.command("recent", async (c) => {
    if (!isAllowed(c.from?.id, allowed)) return;
    const notes = ctx.index.recentNotes(undefined, undefined, 5);
    const lines = notes.map((n) => `- [${n.compartment}] ${n.title}`);
    await c.reply(lines.join("\n") || "No notes yet.");
  });

  bot.command("compartments", async (c) => {
    if (!isAllowed(c.from?.id, allowed)) return;
    const comps = loadCompartments(config, configDir);
    const lines = Object.entries(comps.compartments).map(
      ([k, v]) => `- **${k}**: ${v.description}`,
    );
    await c.reply(lines.join("\n"), { parse_mode: "Markdown" });
  });

  bot.command("undo", async (c) => {
    if (!isAllowed(c.from?.id, allowed)) return;
    try {
      const parentId = resolveUndoTarget(ctx.index, { last: true });
      const result = undoCapture(config.vault.path, ctx.index, parentId, config);
      const lines = result.results.map((r) => {
        if (r.action === "moved_to_inbox") return `Moved to inbox: \`${r.notePath}\``;
        if (r.action === "section_removed") return `Removed section from \`${r.notePath}\``;
        return `${r.action}: ${r.notePath}`;
      });
      await c.reply(`Undone last capture (${result.results.length} item(s)):\n${lines.join("\n")}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await c.reply(`Undo failed: ${msg}`);
    }
  });

  bot.command("sort", async (c) => {
    if (!isAllowed(c.from?.id, allowed)) return;
    const chatId = c.chat.id;
    try {
      await c.reply("Scanning vault for notes to sort…");
      const preview = await previewSort({});
      if (preview.candidateCount === 0) {
        await c.reply("Nothing to sort — vault is dendrite-ready.");
        return;
      }
      pendingSorts.set(chatId, { scope: "all", at: Date.now() });
      const kb = new InlineKeyboard()
        .text("✅ Confirm sort", "sort:confirm")
        .text("❌ Cancel", "sort:cancel");
      await safeReply(c, { text: formatSortPreviewTelegram(preview), keyboard: kb });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await c.reply(`Sort preview failed: ${msg}`);
    }
  });

  bot.command("ask", async (c) => {
    if (!isAllowed(c.from?.id, allowed)) return;
    const question = (c.match ?? "").toString().trim();
    if (!question) return c.reply("Usage: /ask <your question>");
    try {
      const result = await answerQuestion(ctx.index, config.vault.path, question, config, ctx.llm);
      const sources = result.sources.length
        ? "\n\nSources:\n" + result.sources.slice(0, 5).map((s) => `• [[${s.slug}]]`).join("\n")
        : "";
      await safeReply(c, { text: `${result.answer}${sources}` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await c.reply(`Ask failed: ${msg}`);
    }
  });

  bot.on("message:text", async (c) => {
    if (!isAllowed(c.from?.id, allowed)) return;
    const text = c.message.text;
    if (!text || text.startsWith("/")) return;

    const dump: Dump = {
      id: `tg-${c.message.message_id}`,
      source: "telegram-text",
      receivedAt: new Date(c.message.date * 1000).toISOString(),
      text,
      meta: { chatId: c.chat.id, userId: c.from?.id },
    };

    try {
      const results = await enqueueAndProcess(ctx, dump);
      const replies = formatTelegramReplies(results, config);
      for (const reply of replies) {
        if (reply) await safeReply(c, reply);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("telegram text error:", msg);
      await c.reply(`Failed to process: ${msg}`);
    }
  });

  bot.on("message:voice", async (c) => {
    if (!isAllowed(c.from?.id, allowed)) return;

    const tmpDir = join(config.index.db_path, "..", "tmp");
    mkdirSync(tmpDir, { recursive: true });
    const audioPath = join(tmpDir, `voice-${c.message.message_id}.ogg`);

    const file = await c.getFile();
    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error("Failed to download voice");
    await pipeline(resp.body!, createWriteStream(audioPath));

    const dump: Dump = {
      id: `tg-voice-${c.message.message_id}`,
      source: "telegram-voice",
      receivedAt: new Date(c.message.date * 1000).toISOString(),
      audioPath,
      meta: { chatId: c.chat.id, userId: c.from?.id },
    };

    try {
      await c.reply("Transcribing…");
      const results = await enqueueAndProcess(ctx, dump);
      const replies = formatTelegramReplies(results, config, { voice: true });
      for (const reply of replies) {
        if (reply) await safeReply(c, reply);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("telegram voice error:", msg);
      await c.reply(`Voice processing failed: ${msg}`);
    }
  });

  bot.on("callback_query:data", async (c) => {
    const data = c.callbackQuery.data ?? "";

    if (data === "sort:confirm") {
      const chatId = c.chat?.id;
      if (!chatId || !pendingSorts.has(chatId)) {
        await c.answerCallbackQuery({ text: "Sort preview expired — run /sort again" });
        return;
      }
      const pending = pendingSorts.get(chatId)!;
      if (Date.now() - pending.at > 10 * 60 * 1000) {
        pendingSorts.delete(chatId);
        await c.answerCallbackQuery({ text: "Sort preview expired — run /sort again" });
        return;
      }
      pendingSorts.delete(chatId);
      await c.answerCallbackQuery({ text: "Sorting…" });
      await c.editMessageText("Sorting vault via LLM…");
      try {
        const results = await runSort({ scope: pending.scope });
        const filed = results.filter((r) => r.status === "filed").length;
        const notes = new Set(results.filter((r) => r.notePath).map((r) => r.notePath)).size;
        await c.editMessageText(`Sort complete: ${filed} segment(s) → ${notes} note(s).`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await c.editMessageText(`Sort failed: ${msg}`);
      }
      return;
    }

    if (data === "sort:cancel") {
      const chatId = c.chat?.id;
      if (chatId) pendingSorts.delete(chatId);
      await c.answerCallbackQuery({ text: "Sort cancelled" });
      await c.editMessageText("Sort cancelled.");
      return;
    }

    if (!data.startsWith("correct:")) return;
    const [, dumpId, compartment] = data.split(":");
    const dumpRow = ctx.index.db
      .prepare(`SELECT compartment, note_path FROM dumps WHERE id = ?`)
      .get(dumpId) as { compartment: string; note_path: string } | undefined;
    if (dumpRow) {
      ctx.index.addCorrection(dumpId, dumpRow.note_path, dumpRow.compartment, compartment);
      await c.answerCallbackQuery({ text: `Noted: prefer ${compartment}` });
      await c.editMessageText(`Correction saved: prefer **${compartment}** for similar dumps.`, {
        parse_mode: "Markdown",
      });
    }
  });

  console.log("Telegram bot started");
  await bot.start();
}

function isAllowed(userId: number | undefined, allowed: Set<number>): boolean {
  if (!userId) return false;
  if (allowed.size === 0) return true;
  return allowed.has(userId);
}

function buildCorrectionKeyboard(current: string, dumpId: string): InlineKeyboard {
  const options = [
    "memories",
    "learnings",
    "projects",
    "ideas",
    "reflections",
    "tasks",
    "journal",
    "inbox",
  ].filter((o) => o !== current);
  const kb = new InlineKeyboard();
  for (const opt of options.slice(0, 6)) {
    kb.text(opt, `correct:${dumpId}:${opt}`);
  }
  return kb;
}

function formatTelegramReplies(
  results: PipelineResult[],
  config: DendriteConfig,
  opts?: { voice?: boolean },
): Array<{ text: string; keyboard?: InlineKeyboard } | null> {
  if (results.length === 0) return [];

  if (results.every((r) => r.duplicate)) {
    return [{ text: "Already filed this message." }];
  }

  const active = results.filter((r) => !r.duplicate);
  const out: Array<{ text: string; keyboard?: InlineKeyboard } | null> = [];

  // Transcript once (voice or first result)
  const transcript = results.find((r) => r.transcript)?.transcript;
  if (transcript && opts?.voice) {
    const excerpt =
      transcript.length > 300 ? transcript.slice(0, 300) + "…" : transcript;
    out.push({ text: `🎙 _${escapeMarkdown(excerpt)}_` });
  }

  if (active.length === 1) {
    const single = formatTelegramReply(active[0]!, config, opts);
    if (single) out.push(single);
    else if (config.replies.mode !== "digest") {
      const r = active[0]!;
      out.push({
        text: `Filed under **${r.compartment}** → \`${r.notePath}\``,
        keyboard:
          r.tier === "confirm" || r.tier === "inbox"
            ? buildCorrectionKeyboard(r.compartment, r.dumpId)
            : undefined,
      });
    }
    return out;
  }

  // Multi-segment summary
  const summaryLines = [`Filed **${active.length}** items:`];
  for (const r of active) {
    summaryLines.push(`• **${r.compartment}** → \`${r.notePath}\``);
  }
  out.push({ text: summaryLines.join("\n") });

  // Per-segment correction messages (confirm/inbox tiers only)
  const tier = aggregateTier(active);
  const showButtons = tier !== "silent" || config.replies.mode === "always";

  if (showButtons) {
    for (const r of active) {
      if (r.tier === "confirm" || r.tier === "inbox") {
        const filing = formatPipelineReply(r, config);
        out.push({
          text: filing ?? `**${r.compartment}** → \`${r.notePath}\``,
          keyboard: buildCorrectionKeyboard(r.compartment, r.dumpId),
        });
      }
    }
  } else if (config.replies.mode !== "digest") {
    // Silent multi: still ack each filing briefly
    for (const r of active) {
      out.push({
        text: `✓ **${r.compartment}** → \`${r.notePath}\`\n_${escapeMarkdown(r.summary)}_`,
      });
    }
  }

  return out;
}

function formatTelegramReply(
  result: PipelineResult,
  config: DendriteConfig,
  opts?: { voice?: boolean },
): { text: string; keyboard?: InlineKeyboard } | null {
  if (result.duplicate) {
    return { text: "Already filed this message." };
  }

  const lines: string[] = [];

  if (result.transcript) {
    const excerpt =
      result.transcript.length > 300
        ? result.transcript.slice(0, 300) + "…"
        : result.transcript;
    const prefix = opts?.voice ? "🎙" : "📝";
    lines.push(`${prefix} _${escapeMarkdown(excerpt)}_`);
    lines.push("");
  }

  const filing = formatPipelineReply(result, config);
  if (filing) {
    lines.push(filing);
  } else {
    lines.push(`Filed under **${result.compartment}** → \`${result.notePath}\``);
  }

  const keyboard =
    result.tier === "confirm" || result.tier === "inbox"
      ? buildCorrectionKeyboard(result.compartment, result.dumpId)
      : undefined;

  return { text: lines.join("\n"), keyboard };
}

async function safeReply(
  c: Context,
  reply: { text: string; keyboard?: InlineKeyboard },
): Promise<void> {
  try {
    await c.reply(reply.text, {
      reply_markup: reply.keyboard,
      parse_mode: "Markdown",
    });
  } catch {
    await c.reply(stripMarkdown(reply.text), { reply_markup: reply.keyboard });
  }
}

function stripMarkdown(text: string): string {
  return text.replace(/[*_`[\]]/g, "");
}

function escapeMarkdown(text: string): string {
  return text.replace(/([_*`[\]])/g, "\\$1");
}

export async function runQueueWorker(ctx: PipelineContext): Promise<void> {
  setInterval(async () => {
    try {
      await drainQueue(ctx);
    } catch {
      /* logged per item */
    }
  }, 5000);
}
