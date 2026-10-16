import { UsageError } from "../core/errors";
import { formatDate } from "../core/time";
import { parseChatRef, summarizeMessage, truncate } from "../core/tg";
import type { Services } from "../core/services";
import { extractWhen, intArg, resolveTargetMessage, textAfter } from "./helpers";
import type { CommandRegistry } from "./registry";

export function registerMessagingCommands(reg: CommandRegistry, s: Services): void {
  const m = s.messenger;

  reg.register({
    name: "send",
    group: "Messaging",
    scope: "messaging",
    usage: "send <chat> <text>",
    description: "Send a text message as this account (paced; never bulk)",
    async run(ctx) {
      const chat = ctx.cmd.args[0];
      const text = textAfter(ctx.cmd.rest, 1);
      if (!chat || !text) throw new UsageError("Usage: send <chat> <text>");
      const sent = await m.sendText(parseChatRef(chat), text);
      await ctx.reply(`✅ Sent (message ${sent[0]?.id}).`);
    },
  });

  reg.register({
    name: "saved",
    group: "Messaging",
    scope: "messaging",
    usage: "saved <text>",
    description: "Write a note to Saved Messages",
    async run(ctx) {
      const text = ctx.cmd.rest;
      if (!text) throw new UsageError("Usage: saved <text>");
      await m.sendSaved(text);
      await ctx.reply("✅ Saved.");
    },
  });

  reg.register({
    name: "edit",
    group: "Messaging",
    scope: "messaging",
    usage: "edit <new text>   (reply to your own message)",
    description: "Edit one of this account's messages",
    async run(ctx) {
      const { msg, peer } = await resolveTargetMessage(ctx, s);
      if (!msg.out) throw new UsageError("Only this account's own messages can be edited");
      if (!ctx.cmd.rest) throw new UsageError("Usage: edit <new text> (as a reply)");
      await m.edit(peer, msg.id, ctx.cmd.rest);
      await ctx.reply("✅ Edited.");
    },
  });

  reg.register({
    name: "del",
    group: "Messaging",
    scope: "messaging",
    usage: "del [n] [--chat=...]",
    description: "Delete this account's last n messages in a chat (dry-run first)",
    async run(ctx) {
      const n = intArg(ctx.cmd.args[0], "n", { min: 1, max: 100, def: 1 });
      const peer = ctx.targetChat();
      const mine = (await m.history(peer, { limit: n + 1, fromUser: "me" })).filter((x) => x.id !== ctx.messageId).slice(0, n);
      if (mine.length === 0) throw new UsageError("No messages of this account found there");
      const preview = mine.slice(0, 5).map((x) => `  ${x.id}: ${truncate(x.message ?? "", 40) || `[${x.media?.className ?? "media"}]`}`).join("\n");
      await ctx.requireConfirmation({
        action: "msg.delete",
        target: String(peer),
        details: { count: mine.length },
        preview: `delete ${mine.length} message(s) of this account in ${peer}:\n${preview}${mine.length > 5 ? "\n  …" : ""}`,
        run: async () => `Deleted ${await m.deleteMessages(peer, mine.map((x) => x.id))} message(s).`,
      });
    },
  });

  reg.register({
    name: "fwd",
    group: "Messaging",
    scope: "messaging",
    usage: "fwd <to chat>   (reply to a message)",
    description: "Forward the replied-to message",
    async run(ctx) {
      const to = parseChatRef(ctx.cmd.args[0]);
      const { msg, peer } = await resolveTargetMessage(ctx, s);
      await m.forward(to, peer, [msg.id]);
      await ctx.reply("✅ Forwarded.");
    },
  });

  reg.register({
    name: "history",
    group: "Messaging",
    scope: "search",
    usage: "history [n] [--chat=...]",
    description: "Show the last n messages of a chat (not stored)",
    async run(ctx) {
      const n = intArg(ctx.cmd.args[0], "n", { min: 1, max: 30, def: 10 });
      const msgs = await m.history(ctx.targetChat(), { limit: n });
      await ctx.reply(msgs.length ? msgs.reverse().map((x) => { const q = summarizeMessage(x, 60); return `${q.id} · ${formatDate(q.date)} · ${q.senderId ?? "?"}: ${q.text || (q.media ? `[${q.media}]` : "")}`; }).join("\n") : "No messages.");
    },
  });

  reg.register({
    name: "draft",
    group: "Messaging",
    scope: "messaging",
    usage: "draft <chat> <text>",
    description: "Save a draft in a chat (use `draft <chat>` with no text to clear it)",
    async run(ctx) {
      const peer = parseChatRef(ctx.cmd.args[0]);
      const text = textAfter(ctx.cmd.rest, 1);
      if (!text) {
        await m.clearDraft(peer);
        await ctx.reply("✅ Draft cleared.");
      } else {
        await m.saveDraft(peer, text);
        await ctx.reply("✅ Draft saved.");
      }
    },
  });

  reg.register({
    name: "drafts",
    group: "Messaging",
    scope: "messaging",
    usage: "drafts",
    description: "List all drafts",
    async run(ctx) {
      const d = await m.listDrafts();
      await ctx.reply(d.length ? d.map((x) => `${x.peer} · ${formatDate(x.date)}: ${truncate(x.text, 60)}`).join("\n") : "No drafts.");
    },
  });

  reg.register({
    name: "schedule",
    group: "Messaging",
    scope: "messaging",
    usage: "schedule <when> <chat> <text>",
    description: "Schedule a message with Telegram's own scheduler (works even if this app is offline)",
    async run(ctx) {
      const { when, consumed } = extractWhen(ctx.cmd.args);
      const chat = ctx.cmd.args[consumed];
      const text = textAfter(ctx.cmd.rest, consumed + 1);
      if (!chat || !text) throw new UsageError("Usage: schedule <when> <chat> <text>", "Example: schedule tomorrow 09:00 me Call the bank");
      if (when.getTime() < Date.now() + 10_000) throw new UsageError("Pick a time at least 10 seconds in the future");
      await m.sendText(parseChatRef(chat), text, { schedule: when });
      await ctx.reply(`✅ Scheduled for ${formatDate(when.getTime())}.`);
    },
  });

  reg.register({
    name: "scheduled",
    group: "Messaging",
    scope: "messaging",
    usage: "scheduled [--chat=...]",
    description: "List scheduled messages in a chat",
    async run(ctx) {
      const list = await m.listScheduled(ctx.targetChat());
      await ctx.reply(list.length ? list.map((x) => `${x.id} · ${formatDate((x.date ?? 0) * 1000)}: ${truncate(x.message ?? "", 60)}`).join("\n") : "Nothing scheduled.");
    },
  });

  reg.register({
    name: "unschedule",
    group: "Messaging",
    scope: "messaging",
    usage: "unschedule <id...> [--chat=...]",
    description: "Cancel scheduled messages",
    async run(ctx) {
      const ids = ctx.cmd.args.map((a) => intArg(a, "message id", { min: 1 }));
      if (!ids.length) throw new UsageError("Give one or more message ids (see `scheduled`)");
      await m.cancelScheduled(ctx.targetChat(), ids);
      await ctx.reply(`✅ Cancelled ${ids.length} scheduled message(s).`);
    },
  });
}
