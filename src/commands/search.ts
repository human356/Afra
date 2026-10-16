import { UsageError } from "../core/errors";
import { formatDate } from "../core/time";
import { parseChatRef, toNum } from "../core/tg";
import type { Services } from "../core/services";
import { intArg, textAfter } from "./helpers";
import { throttled } from "./media";
import type { CommandRegistry } from "./registry";

export function registerSearchCommands(reg: CommandRegistry, s: Services): void {
  reg.register({
    name: "find",
    group: "Search",
    scope: "search",
    usage: "find <query> [--chat=...] [--limit=10] [--from=user]",
    description: "Search messages in a chat (Telegram-side; nothing is stored)",
    async run(ctx) {
      const query = textAfter(ctx.cmd.rest.replace(/(?:^|\s)--[a-z]+=\S+/gi, " "), 0);
      if (!query) throw new UsageError("Usage: find <query>");
      const from = ctx.cmd.options["from"];
      const res = await s.search.live(ctx.targetChat(), query, { limit: intArg(ctx.cmd.options["limit"], "--limit", { min: 1, max: 30, def: 10 }), fromUser: from ? parseChatRef(from) : undefined });
      await ctx.reply(res.length ? res.map((r) => `${r.id} · ${formatDate(r.date)} · ${r.senderId ?? "?"}: ${r.text}`).join("\n") : "No matches.");
    },
  });

  reg.register({
    name: "findlocal",
    group: "Search",
    scope: "search",
    usage: "findlocal <query> [--chat=...]",
    description: "Search the opt-in local archive",
    async run(ctx) {
      if (!s.search.archivingAvailable) throw new UsageError("Local archiving is disabled", "Set STORE_MESSAGE_CONTENT=true, then enable chats with `archive on`.");
      const query = ctx.cmd.rest.replace(/(?:^|\s)--[a-z]+=\S+/gi, " ").trim();
      if (!query) throw new UsageError("Usage: findlocal <query>");
      const chat = ctx.cmd.options["chat"] ? toNum(await s.client.getPeerId(parseChatRef(ctx.cmd.options["chat"]))) : undefined;
      const res = await s.search.searchArchive(query, { chatId: chat, limit: 15 });
      await ctx.reply(res.length ? res.map((r) => `${r.chatId}/${r.messageId} · ${formatDate(r.sentAt)}: ${(r.text ?? "").slice(0, 80)}`).join("\n") : "No archived matches.");
    },
  });

  reg.register({
    name: "archivechat",
    group: "Search",
    scope: "search",
    usage: "archivechat on|off|list|purge [--chat=...]",
    description: "Opt a chat in/out of local message archiving (needs STORE_MESSAGE_CONTENT=true)",
    async run(ctx) {
      const mode = ctx.cmd.args[0];
      if (mode === "list") {
        const l = await s.search.archivedChats();
        await ctx.reply(`Archiving ${s.search.archivingAvailable ? "is available" : "is DISABLED (STORE_MESSAGE_CONTENT=false)"}. Chats opted in: ${l.length ? l.join(", ") : "none"}`);
        return;
      }
      if (mode !== "on" && mode !== "off" && mode !== "purge") throw new UsageError("Usage: archivechat on|off|list|purge");
      if (mode === "purge") {
        if (!ctx.principal.isMaster) throw new UsageError("Only the master admin can purge the archive");
        await ctx.requireConfirmation({ action: "archive.purge", preview: "delete ALL locally archived message text", run: async () => `Deleted ${await s.repos.archive.purgeAll()} archived message(s).` });
        return;
      }
      const chatId = toNum(await s.client.getPeerId(ctx.targetChat())) as number;
      await s.search.setArchiving(chatId, mode === "on");
      await s.repos.audit.add({ actorId: ctx.principal.userId, action: `archive.${mode}`, target: String(chatId), result: "ok" });
      await ctx.reply(mode === "on" ? "🗄️ New messages in this chat will be stored locally (text only)." : "🗑️ Archiving stopped and stored messages for this chat were deleted.");
    },
  });

  reg.register({
    name: "export",
    group: "Search",
    scope: "search",
    usage: "export [n] [--chat=...] [--notext]",
    description: "Export chat history to a JSONL file (max 100000, paced)",
    async run(ctx) {
      const peer = ctx.targetChat();
      const update = throttled(await ctx.progress("📦 Exporting…"), 3000);
      const r = await s.search.exportHistory(peer, String(peer), { limit: intArg(ctx.cmd.args[0], "n", { min: 1, max: 100_000, def: 1000 }), includeText: !ctx.cmd.flags.has("notext"), onProgress: (n) => update(`📦 ${n} messages…`) });
      await s.repos.audit.add({ actorId: ctx.principal.userId, action: "export.history", target: String(peer), details: { count: r.count }, result: "ok" });
      await ctx.reply(`✅ Exported ${r.count} messages → ${r.file.replace(s.cfg.paths.dataDir, "data")}`);
    },
  });
}
