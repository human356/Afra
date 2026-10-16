import { UsageError } from "../core/errors";
import { parseDuration } from "../core/time";
import type { Services } from "../core/services";
import { intArg } from "./helpers";
import type { CommandRegistry } from "./registry";

export function registerChatCommands(reg: CommandRegistry, s: Services): void {
  reg.register({
    name: "chats",
    group: "Chats",
    scope: "search",
    usage: "chats [n] [--archived]",
    description: "List recent chats with their ids",
    async run(ctx) {
      const list = await s.chats.dialogs(intArg(ctx.cmd.args[0], "n", { min: 1, max: 50, def: 15 }), ctx.cmd.flags.has("archived"));
      await ctx.reply(list.length ? list.map((d) => `${d.id ?? "?"} · ${d.type} · ${d.title}${d.unread ? ` (${d.unread} unread)` : ""}${d.pinned ? " 📌" : ""}`).join("\n") : "No chats.");
    },
  });

  reg.register({
    name: "mute",
    group: "Chats",
    scope: "messaging",
    usage: "mute [duration|forever] [--chat=...]",
    description: "Mute notifications for a chat",
    async run(ctx) {
      const arg = ctx.cmd.args[0];
      const secs = !arg || arg === "forever" ? undefined : parseDuration(arg);
      if (arg && arg !== "forever" && secs === undefined) throw new UsageError(`"${arg}" is not a duration`, "Examples: 1h, 8h, 7d, forever");
      await s.chats.mute(ctx.targetChat(), secs === undefined ? undefined : Math.round(secs / 1000));
      await ctx.reply(`🔕 Muted ${arg && arg !== "forever" ? `for ${arg}` : "indefinitely"}.`);
    },
  });

  reg.register({
    name: "unmute",
    group: "Chats",
    scope: "messaging",
    usage: "unmute [--chat=...]",
    description: "Unmute a chat",
    async run(ctx) {
      await s.chats.unmute(ctx.targetChat());
      await ctx.reply("🔔 Unmuted.");
    },
  });

  reg.register({
    name: "archive",
    aliases: ["unarchive"],
    group: "Chats",
    scope: "messaging",
    usage: "archive | unarchive [--chat=...]",
    description: "Move a chat to / from the archive",
    async run(ctx) {
      if (ctx.cmd.name === "unarchive") await s.chats.unarchive(ctx.targetChat());
      else await s.chats.archive(ctx.targetChat());
      await ctx.reply(ctx.cmd.name === "unarchive" ? "📤 Unarchived." : "📥 Archived.");
    },
  });

  reg.register({
    name: "folders",
    group: "Chats",
    scope: "search",
    usage: "folders",
    description: "List chat folders",
    async run(ctx) {
      const f = await s.chats.folders();
      await ctx.reply(f.length ? f.map((x) => `${x.id} · ${x.title || "(untitled)"} · ${x.kind} · ${x.chats} chat(s)`).join("\n") : "No custom folders.");
    },
  });

  reg.register({
    name: "folder",
    group: "Chats",
    scope: "messaging",
    usage: "folder add|remove <folder id> [--chat=...]",
    description: "Add / remove a chat to a custom folder",
    async run(ctx) {
      const mode = ctx.cmd.args[0];
      if (mode !== "add" && mode !== "remove") throw new UsageError("Usage: folder add|remove <folder id>");
      const id = intArg(ctx.cmd.args[1], "folder id", { min: 1 });
      await ctx.reply(await s.chats.editFolder(id, ctx.targetChat(), mode));
    },
  });
}
