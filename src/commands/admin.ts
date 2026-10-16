import { UsageError } from "../core/errors";
import { formatDate } from "../core/time";
import { parseChatRef, toNum } from "../core/tg";
import type { Services } from "../core/services";
import { intArg } from "./helpers";
import type { CommandContext } from "./types";
import type { CommandRegistry } from "./registry";

export function registerAdminCommands(reg: CommandRegistry, s: Services): void {
  const a = s.admin;

  /** User from the first argument, else the sender of the replied-to message. */
  const userOf = async (ctx: CommandContext): Promise<string | number> => {
    const arg = ctx.cmd.args[0];
    if (arg) return parseChatRef(arg);
    const replied = await ctx.getRepliedMessage();
    const id = toNum(replied?.senderId);
    if (id === undefined) throw new UsageError("Give a user (id or @username) or reply to their message");
    return id;
  };

  reg.register({
    name: "members",
    aliases: ["admins"],
    group: "Group admin",
    scope: "chatadmin",
    usage: "members [n] [--admins] [--search=text] [--chat=...]",
    description: "List participants (admins first with --admins)",
    async run(ctx) {
      const list = await a.participants(ctx.targetChat(), { limit: intArg(ctx.cmd.args[0], "n", { min: 1, max: 100, def: 30 }), adminsOnly: ctx.cmd.flags.has("admins") || ctx.cmd.name === "admins", search: ctx.cmd.options["search"] });
      await ctx.reply(list.length ? list.map((p) => `${p.id ?? "?"} · ${p.name}${p.username ? ` (@${p.username})` : ""} · ${p.role}${p.rank ? ` “${p.rank}”` : ""}`).join("\n") : "No participants visible.");
    },
  });

  reg.register({
    name: "perms",
    group: "Group admin",
    scope: "chatadmin",
    usage: "perms [--chat=...]",
    description: "Show what THIS account is actually allowed to do in the chat",
    async run(ctx) {
      const r = await a.myRights(ctx.targetChat());
      const yes = (b: boolean): string => (b ? "yes" : "no");
      await ctx.reply(`Chat type: ${r.chatType}\nAdmin: ${yes(r.isAdmin)}${r.isCreator ? " (creator)" : ""}\nDelete messages: ${yes(r.deleteMessages)}\nBan users: ${yes(r.banUsers)}\nInvite users: ${yes(r.inviteUsers)}\nPin messages: ${yes(r.pinMessages)}\nChange info: ${yes(r.changeInfo)}`);
    },
  });

  reg.register({
    name: "kick",
    group: "Group admin",
    scope: "chatadmin",
    usage: "kick <user>|(reply) [--chat=...]",
    description: "Remove a user from the chat (needs the ban-users right; dry-run first)",
    async run(ctx) {
      const peer = ctx.targetChat();
      const user = await userOf(ctx);
      await a.requireRight(peer, "banUsers");
      await ctx.requireConfirmation({ action: "admin.kick", target: `${peer}:${user}`, preview: `remove user ${user} from chat ${peer}`, run: async () => (await a.kick(peer, user), `Removed ${user}.`) });
    },
  });

  reg.register({
    name: "ban",
    group: "Group admin",
    scope: "chatadmin",
    usage: "ban <user>|(reply) [--chat=...]",
    description: "Ban a user (supergroups/channels; basic groups can only remove)",
    async run(ctx) {
      const peer = ctx.targetChat();
      const user = await userOf(ctx);
      await a.requireRight(peer, "banUsers");
      await ctx.requireConfirmation({ action: "admin.ban", target: `${peer}:${user}`, preview: `ban user ${user} in chat ${peer}`, run: async () => `${(await a.ban(peer, user)) === "banned" ? "Banned" : "Removed"} ${user}.` });
    },
  });

  reg.register({
    name: "unban",
    group: "Group admin",
    scope: "chatadmin",
    usage: "unban <user> [--chat=...]",
    description: "Lift a ban",
    async run(ctx) {
      const peer = ctx.targetChat();
      const user = await userOf(ctx);
      await ctx.requireConfirmation({ action: "admin.unban", target: `${peer}:${user}`, preview: `lift the ban on ${user} in chat ${peer}`, run: async () => (await a.unban(peer, user), `Unbanned ${user}.`) });
    },
  });

  reg.register({
    name: "purge",
    group: "Group admin",
    scope: "chatadmin",
    usage: "purge <n> [--from=user] [--chat=...]",
    description: "Delete the last n messages (optionally of one user) — needs delete right; dry-run first",
    async run(ctx) {
      const peer = ctx.targetChat();
      const n = intArg(ctx.cmd.args[0], "n", { min: 1, max: 500 });
      const from = ctx.cmd.options["from"] ? parseChatRef(ctx.cmd.options["from"]) : undefined;
      await a.requireRight(peer, "deleteMessages");
      const targets = (await a.findPurgeTargets(peer, n + 1, from)).filter((id) => id !== ctx.messageId).slice(0, n);
      if (!targets.length) throw new UsageError("No messages to delete");
      await ctx.requireConfirmation({ action: "admin.purge", target: String(peer), details: { count: targets.length, from: from ?? null }, preview: `delete ${targets.length} message(s) in ${peer}${from ? ` from ${from}` : ""}`, run: async () => `Deleted ${await a.purge(peer, targets)} message(s).` });
    },
  });

  reg.register({
    name: "adminlog",
    group: "Group admin",
    scope: "chatadmin",
    usage: "adminlog [n] [--chat=...]",
    description: "Read the channel/supergroup admin log",
    async run(ctx) {
      const ev = await a.adminLog(ctx.targetChat(), intArg(ctx.cmd.args[0], "n", { min: 1, max: 50, def: 15 }));
      await ctx.reply(ev.length ? ev.map((e) => `${formatDate(e.date)} · user ${e.userId ?? "?"} · ${e.action}`).join("\n") : "The admin log is empty (or this chat has none).");
    },
  });
}
