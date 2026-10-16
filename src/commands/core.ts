import { SCOPE_HELP, SCOPES } from "../auth/access";
import { publicConfigView } from "../config";
import { UsageError } from "../core/errors";
import { formatDate, formatDuration } from "../core/time";
import { parseChatRef, toNum } from "../core/tg";
import type { Services } from "../core/services";
import { backupConfig } from "../storage/backup";
import { intArg } from "./helpers";
import type { CommandRegistry } from "./registry";

export function registerCoreCommands(reg: CommandRegistry, s: Services): void {
  const prefix = (t: "userbot" | "bot"): string => s.dispatcher.prefixFor(t);

  reg.register({
    name: "help",
    aliases: ["start"],
    group: "General",
    scope: "self",
    usage: "help [command]",
    description: "List the commands you may use",
    async run(ctx) {
      const p = prefix(ctx.transport);
      const name = ctx.cmd.args[0]?.replace(/^[./]/, "");
      if (name) {
        const def = reg.get(name);
        if (!def) throw new UsageError(`Unknown command "${name}"`);
        await ctx.reply(`${p}${def.usage}\n${def.description}\nPermission: ${def.scope}`);
        return;
      }
      const groups = new Map<string, string[]>();
      for (const d of reg.list()) {
        const ok = d.scope === "master" ? ctx.principal.isMaster : ctx.principal.scopes.has(d.scope);
        if (!ok) continue;
        groups.set(d.group, [...(groups.get(d.group) ?? []), `${p}${d.usage} — ${d.description}`]);
      }
      const out = [...groups.entries()].map(([g, lines]) => `${g}\n${lines.join("\n")}`);
      await ctx.reply(`${out.join("\n\n")}\n\nTip: ${p}help <command> for details. Destructive commands show a dry-run first and need ${p}confirm.`);
    },
  });

  reg.register({
    name: "ping",
    group: "General",
    scope: "self",
    usage: "ping",
    description: "Check that the userbot is alive",
    async run(ctx) {
      const t0 = Date.now();
      await ctx.reply("🏓 pong");
      s.logger.debug({ module: "commands", ms: Date.now() - t0 }, "ping");
    },
  });

  reg.register({
    name: "id",
    group: "General",
    scope: "self",
    usage: "id",
    description: "Show the chat id and the id of the replied-to user",
    async run(ctx) {
      const replied = await ctx.getRepliedMessage();
      const lines = [`You: ${ctx.principal.userId}`, `Chat: ${ctx.chatId}`];
      const rs = toNum(replied?.senderId);
      if (rs !== undefined) lines.push(`Replied-to user: ${rs}`);
      await ctx.reply(lines.join("\n"));
    },
  });

  reg.register({
    name: "me",
    aliases: ["whoami"],
    group: "General",
    scope: "self",
    usage: "me",
    description: "Show your access level",
    async run(ctx) {
      const scopes = [...ctx.principal.scopes];
      await ctx.reply(`User ${ctx.principal.userId} — ${ctx.principal.isMaster ? "master admin (full access)" : "self mode"}\nPermissions: ${scopes.join(", ")}`);
    },
  });

  reg.register({
    name: "status",
    group: "General",
    scope: "self",
    usage: "status",
    description: "Connection, queue and scheduler status",
    async run(ctx) {
      const q = s.queue.stats;
      const m = s.metrics.snapshot();
      await ctx.reply(
        [
          `Account: ${s.account.name}${s.account.username ? ` (@${s.account.username})` : ""}`,
          `Connected: ${s.client.connected ? "yes" : "NO"}   Control bot: ${s.bot ? "on" : "off"}`,
          `Uptime: ${formatDuration(s.metrics.uptimeSec() * 1000)}`,
          `Queue: ${q.running} running, ${q.pending} pending, ${q.failed} failed`,
          `Commands: ${m["commands.total"] ?? 0}   Messages sent: ${m["messages.sent"] ?? 0}   FloodWaits: ${m["telegram.floodwait"] ?? 0}`,
          `Plugins active: ${s.plugins.list().filter((p) => p.status === "active").length}`,
        ].join("\n"),
      );
    },
  });

  reg.register({
    name: "features",
    group: "General",
    scope: "self",
    usage: "features",
    description: "What this build supports (from the installed library)",
    async run(ctx) {
      const f = s.features;
      const notFull = f.features.filter((x) => x.status !== "supported").map((x) => `${x.status === "partial" ? "🟡" : "❌"} ${x.title}${x.note ? ` — ${x.note}` : ""}`);
      await ctx.reply(`Library ${f.library.name}@${f.library.version}: ${f.summary.supported} supported, ${f.summary.partial} partial, ${f.summary.unavailable} unavailable.\n${notFull.join("\n")}`);
    },
  });

  reg.register({
    name: "confirm",
    group: "General",
    scope: "self",
    usage: "confirm <code>",
    description: "Confirm a previewed destructive action",
    async run(ctx) {
      const token = ctx.cmd.args[0];
      if (!token) throw new UsageError("Give the confirmation code shown in the dry-run");
      const pending = s.confirmations.take(ctx.principal.userId, token);
      if (!pending) throw new UsageError("That code is invalid, expired, or belongs to someone else");
      await s.dispatcher.execute(ctx.principal.userId, pending, (t) => ctx.reply(t));
    },
  });

  reg.register({
    name: "cancel",
    group: "General",
    scope: "self",
    usage: "cancel",
    description: "Discard your pending confirmations",
    async run(ctx) {
      const n = s.confirmations.cancelAll(ctx.principal.userId);
      await ctx.reply(n ? `Cancelled ${n} pending action(s).` : "Nothing pending.");
    },
  });

  /* ------------------------------ master-only ------------------------------ */
  reg.register({
    name: "grant",
    group: "Access (master)",
    scope: "master",
    usage: "grant <user id> [scopes] [--note=text]",
    description: `Enable "self mode" for a user. Scopes: ${SCOPES.join(", ")} (default: self)`,
    async run(ctx) {
      const id = Number(ctx.cmd.args[0]);
      if (!Number.isSafeInteger(id) || id <= 0) throw new UsageError("Give the numeric Telegram user id", "Ask the user for their id, or use /id in a chat with them.");
      const scopes = s.access.parseScopes(ctx.cmd.args.slice(1));
      await s.access.grant(ctx.principal.userId, id, scopes, ctx.cmd.options["note"]);
      await ctx.reply(`✅ User ${id} now has self mode with: ${scopes.join(", ")}\n${scopes.map((x) => `• ${x}: ${SCOPE_HELP[x]}`).join("\n")}`);
    },
  });

  reg.register({
    name: "revoke",
    group: "Access (master)",
    scope: "master",
    usage: "revoke <user id>",
    description: "Remove a user's self mode",
    async run(ctx) {
      const id = intArg(ctx.cmd.args[0], "user id", { min: 1 });
      await ctx.reply((await s.access.revoke(ctx.principal.userId, id)) ? `✅ Revoked ${id}.` : `User ${id} had no access.`);
    },
  });

  reg.register({
    name: "suspend",
    aliases: ["resume"],
    group: "Access (master)",
    scope: "master",
    usage: "suspend <user id> | resume <user id>",
    description: "Temporarily disable / re-enable a user without deleting their grant",
    async run(ctx) {
      const id = intArg(ctx.cmd.args[0], "user id", { min: 1 });
      const enable = ctx.cmd.name === "resume";
      const ok = await s.access.setEnabled(ctx.principal.userId, id, enable);
      await ctx.reply(ok ? `✅ User ${id} ${enable ? "re-enabled" : "suspended"}.` : `No grant found for ${id}.`);
    },
  });

  reg.register({
    name: "users",
    group: "Access (master)",
    scope: "master",
    usage: "users",
    description: "List users who have self mode",
    async run(ctx) {
      const list = await s.access.list();
      await ctx.reply(list.length ? list.map((u) => `${u.userId}${u.enabled ? "" : " (suspended)"} — ${u.scopes.join(", ")}${u.note ? ` — ${u.note}` : ""} — since ${formatDate(u.addedAt)}`).join("\n") : `No users yet. Master admin: ${s.access.masterAdminId}. Use ${prefix(ctx.transport)}grant <id>.`);
    },
  });

  reg.register({
    name: "audit",
    group: "Access (master)",
    scope: "master",
    usage: "audit [n]",
    description: "Recent audit-log entries (administrative and destructive actions)",
    async run(ctx) {
      const rows = await s.repos.audit.recent(intArg(ctx.cmd.args[0], "n", { min: 1, max: 50, def: 15 }));
      await ctx.reply(rows.length ? rows.map((r) => `#${r.id} ${formatDate(r.ts)} by ${r.actorId}: ${r.action}${r.target ? ` → ${r.target}` : ""} [${r.dryRun ? "dry-run" : r.result}]`).join("\n") : "The audit log is empty.");
    },
  });

  reg.register({
    name: "backup",
    group: "Access (master)",
    scope: "master",
    usage: "backup",
    description: "Back up local configuration (settings, grants, rules, tasks, plugin state)",
    async run(ctx) {
      const r = await backupConfig(s.db, s.cfg.paths.backupsDir);
      await s.repos.audit.add({ actorId: ctx.principal.userId, action: "backup", result: "ok" });
      await ctx.reply(`✅ Backup written to the backups folder:\n${[r.snapshotFile, r.databaseFile].filter(Boolean).map((f) => `• ${String(f).split(/[\\/]/).pop()}`).join("\n")}${r.pruned.length ? `\nPruned ${r.pruned.length} old file(s).` : ""}`);
    },
  });

  reg.register({
    name: "config",
    group: "Access (master)",
    scope: "master",
    usage: "config",
    description: "Show non-secret settings",
    async run(ctx) {
      await ctx.reply(JSON.stringify(publicConfigView(s.cfg), null, 1));
    },
  });

  reg.register({
    name: "chatref",
    group: "General",
    scope: "self",
    usage: "chatref <ref>",
    description: "Check how a chat reference is understood",
    async run(ctx) {
      await ctx.reply(`→ ${String(parseChatRef(ctx.cmd.args[0], ctx.chatId))}`);
    },
  });
}
