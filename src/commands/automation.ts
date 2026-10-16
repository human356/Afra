import { applyChain, TRANSFORMS } from "../automation/transforms";
import { parseRuleDefinition, type RuleDefinition } from "../automation/rules";
import type { ReminderPayload } from "../automation/kinds";
import { UsageError } from "../core/errors";
import { formatDate, formatDuration, parseDuration } from "../core/time";
import { truncate } from "../core/tg";
import type { Services } from "../core/services";
import { extractWhen, intArg, textAfter } from "./helpers";
import type { CommandContext } from "./types";
import type { CommandRegistry } from "./registry";

/** Text to work on: the replied-to message, else the free text after `skip` tokens. */
async function inputText(ctx: CommandContext, skip: number): Promise<string> {
  const replied = await ctx.getRepliedMessage();
  // Leading --flags (e.g. `sum --bullets text`) are options, not part of the text to process.
  const inline = textAfter(ctx.cmd.rest.replace(/^(?:\s*--[A-Za-z][\w-]*(?:=\S*)?)+/, ""), skip);
  const text = inline || replied?.message || "";
  if (!text.trim()) throw new UsageError("Give some text, or reply to a message");
  return text;
}

const ids = (v: string | undefined, here: number | undefined): number[] =>
  (v ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      if (x === "here") {
        if (here === undefined) throw new UsageError('"here" is only available when the command is sent inside a chat');
        return here;
      }
      if (!/^-?\d+$/.test(x)) throw new UsageError(`"${x}" is not a numeric chat id`, "Use `id` in the chat to see its id.");
      return Number(x);
    });

export function registerAutomationCommands(reg: CommandRegistry, s: Services): void {
  /* ------------------------------ reminders & tasks ------------------------------ */
  reg.register({
    name: "remind",
    group: "Automation",
    scope: "self",
    usage: "remind <when> <text> [--repeat=1h]",
    description: "Personal reminder (10m, 2h30m, 18:30, tomorrow 09:00, 2026-12-31 23:59)",
    async run(ctx) {
      const { when, consumed } = extractWhen(ctx.cmd.args);
      const text = textAfter(ctx.cmd.rest.replace(/(?:^|\s)--repeat=\S+/i, " "), consumed);
      if (!text) throw new UsageError("Usage: remind <when> <text>");
      if (text.length > 1000) throw new UsageError("Reminder text is limited to 1000 characters");
      const rep = ctx.cmd.options["repeat"];
      const repeatMs = rep ? parseDuration(rep) : undefined;
      if (rep && repeatMs === undefined) throw new UsageError(`"${rep}" is not a duration`);
      const via = ctx.transport;
      const payload: ReminderPayload = { via, chat: via === "bot" ? ctx.principal.userId : ctx.chatId, text };
      const id = await s.tasks.create({ ownerId: ctx.principal.userId, kind: "reminder", name: truncate(text, 40), payload: payload as unknown as Record<string, unknown>, when, repeatSec: repeatMs ? Math.round(repeatMs / 1000) : undefined, maxPending: ctx.principal.isMaster ? 500 : undefined });
      await ctx.reply(`⏰ Reminder #${id} set for ${formatDate(when.getTime())}${repeatMs ? `, repeating every ${formatDuration(repeatMs)}` : ""}.`);
    },
  });

  reg.register({
    name: "reminders",
    aliases: ["tasks"],
    group: "Automation",
    scope: "self",
    usage: "reminders [--all]",
    description: "List your pending reminders/tasks (master: --all for everyone's)",
    async run(ctx) {
      const all = ctx.cmd.flags.has("all") && ctx.principal.isMaster;
      const rows = await s.repos.tasks.list({ ownerId: all ? undefined : ctx.principal.userId, status: "pending", limit: 30 });
      await ctx.reply(rows.length ? rows.map((t) => `#${t.id} · ${formatDate(t.runAt)}${t.repeatSec ? ` · every ${formatDuration(t.repeatSec * 1000)}` : ""} · ${t.kind}: ${t.name}${all ? ` · owner ${t.ownerId}` : ""}`).join("\n") : "No pending reminders.");
    },
  });

  reg.register({
    name: "unremind",
    aliases: ["untask"],
    group: "Automation",
    scope: "self",
    usage: "unremind <id>",
    description: "Cancel a reminder/task you created",
    async run(ctx) {
      const id = intArg(ctx.cmd.args[0], "id", { min: 1 });
      const ok = await s.repos.tasks.cancel(id, ctx.principal.isMaster ? undefined : ctx.principal.userId);
      await ctx.reply(ok ? `✅ Cancelled #${id}.` : `No pending task #${id} of yours.`);
    },
  });

  reg.register({
    name: "taskhistory",
    group: "Automation",
    scope: "master",
    usage: "taskhistory [n]",
    description: "Recent scheduled-task runs",
    async run(ctx) {
      const runs = await s.repos.tasks.recentRuns(intArg(ctx.cmd.args[0], "n", { min: 1, max: 50, def: 15 }));
      await ctx.reply(runs.length ? runs.map((r) => `#${r.taskId} ${r.taskName ?? ""} · ${formatDate(r.startedAt)} · ${r.status}${r.lateSec ? ` · late ${r.lateSec}s` : ""}${r.error ? ` · ${r.error}` : ""}`).join("\n") : "No runs yet.");
    },
  });

  /* ------------------------------ text tools ------------------------------ */
  reg.register({
    name: "t",
    aliases: ["transform"],
    group: "Text tools",
    scope: "self",
    usage: "t <transform[,transform…]> [text]   (or reply)",
    description: `Transform text: ${Object.keys(TRANSFORMS).join(", ")}`,
    async run(ctx) {
      const names = (ctx.cmd.args[0] ?? "").split(",").filter(Boolean);
      if (!names.length) throw new UsageError("Usage: t <transform> [text]", `Available: ${Object.keys(TRANSFORMS).join(", ")}`);
      await ctx.reply(applyChain(names, await inputText(ctx, 1)));
    },
  });

  reg.register({
    name: "tr",
    group: "Text tools",
    scope: "self",
    usage: "tr <lang> [text]   (or reply)",
    description: "Translate text (needs TRANSLATE_PROVIDER)",
    async run(ctx) {
      const lang = ctx.cmd.args[0];
      if (!lang) throw new UsageError("Usage: tr <lang code> [text]");
      await ctx.reply(await s.translator.translate(await inputText(ctx, 1), lang));
    },
  });

  reg.register({
    name: "sum",
    group: "Text tools",
    scope: "self",
    usage: "sum [--bullets] [text]   (or reply)",
    description: "Summarise text with AI (opt-in; only the text you pass is sent)",
    async run(ctx) {
      await ctx.reply(await s.ai.summarize(await inputText(ctx, 0), ctx.cmd.flags.has("bullets") ? "bullets" : "short"));
    },
  });

  reg.register({
    name: "classify",
    group: "Text tools",
    scope: "self",
    usage: "classify <label1,label2,…> [text]   (or reply)",
    description: "Classify text into one of your labels with AI (opt-in)",
    async run(ctx) {
      const labels = (ctx.cmd.args[0] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
      await ctx.reply(`Label: ${await s.ai.classify(await inputText(ctx, 1), labels)}`);
    },
  });

  /* ------------------------------ rules ------------------------------ */
  reg.register({
    name: "rule",
    group: "Automation",
    scope: "automation",
    usage: "rule add|list|show|on|off|del|chat|block …",
    description: "Auto-reply / keyword rules. Run `rule` for details",
    async run(ctx) {
      const sub = ctx.cmd.args[0];
      const here = Number(ctx.chatId);
      const o = ctx.cmd.options;
      const owner = ctx.principal.userId;
      const own = async (id: number) => {
        const r = await s.repos.rules.get(id);
        if (!r || (r.ownerId !== owner && !ctx.principal.isMaster)) throw new UsageError(`No rule #${id} of yours`);
        return r;
      };

      switch (sub) {
        case "add": {
          const name = ctx.cmd.args[1];
          const on = (o["on"] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
          if (!name || !on.length) throw new UsageError("Usage: rule add <name> --on=word1,word2 (--reply=text | --react=👍 | --notify | --forward=me) (--here | --chat=id,id)");
          const actions = [o["reply"] !== undefined, o["react"] !== undefined, ctx.cmd.flags.has("notify") || o["notify"] !== undefined, o["forward"] !== undefined].filter(Boolean).length;
          if (actions !== 1) throw new UsageError("Choose exactly one action: --reply, --react, --notify or --forward");
          if (o["forward"] !== undefined && o["forward"] !== "me" && !ctx.principal.isMaster) throw new UsageError("Only the master admin can forward matched messages to other chats", "Use --forward=me to send them to Saved Messages.");
          const chatIds = ids(ctx.cmd.flags.has("here") ? "here" : o["chat"], Number.isFinite(here) && ctx.transport === "userbot" ? here : undefined);
          const mode = (o["mode"] ?? "allowlist") as "allowlist" | "blocklist";
          if (mode === "allowlist" && !chatIds.length) throw new UsageError("Say where the rule applies: --here or --chat=<ids>", "Rules never apply anywhere until you list chats (safe default).");
          const action: RuleDefinition["action"] =
            o["reply"] !== undefined ? { type: "reply", text: o["reply"] } : o["react"] !== undefined ? { type: "react", emoji: o["react"] } : o["forward"] !== undefined ? { type: "forward", to: o["forward"] === "me" ? "me" : Number(o["forward"]) } : { type: "notify", text: o["notify"] || "Rule {rule} matched in chat {chat}: {match}" };
          const def = parseRuleDefinition({
            trigger: { type: o["type"] ?? "contains", patterns: on, caseSensitive: ctx.cmd.flags.has("cs"), wholeWord: ctx.cmd.flags.has("word") },
            scope: { mode, chatIds },
            filters: { chatTypes: ctx.cmd.flags.has("private") ? ["private"] : ctx.cmd.flags.has("group") ? ["group"] : undefined, blockUserIds: [], minLength: 0 },
            action,
            cooldownSec: intArg(o["cooldown"], "--cooldown", { min: 5, max: 86_400, def: 60 }),
          });
          const id = await s.repos.rules.create(owner, name, def);
          s.rules.invalidate();
          await s.repos.audit.add({ actorId: owner, action: "rule.add", target: String(id), details: { name }, result: "ok" });
          await ctx.reply(`✅ Rule #${id} "${name}" created (${def.scope.mode}: ${chatIds.length ? chatIds.join(", ") : "all chats except none"}, cooldown ${def.cooldownSec}s).`);
          return;
        }
        case "list": {
          const rows = await s.repos.rules.list(ctx.principal.isMaster ? undefined : owner);
          await ctx.reply(rows.length ? rows.map((r) => `#${r.id} ${r.enabled ? "🟢" : "⚪"} ${r.name} · ${r.hitCount} hit(s)`).join("\n") : "No rules yet.");
          return;
        }
        case "show": {
          const r = await own(intArg(ctx.cmd.args[1], "id", { min: 1 }));
          await ctx.reply(`#${r.id} ${r.name} (${r.enabled ? "on" : "off"})\n${JSON.stringify(r.definition, null, 1)}`);
          return;
        }
        case "on":
        case "off": {
          const r = await own(intArg(ctx.cmd.args[1], "id", { min: 1 }));
          await s.repos.rules.setEnabled(r.id, sub === "on");
          s.rules.invalidate();
          await ctx.reply(`✅ Rule #${r.id} ${sub === "on" ? "enabled" : "disabled"}.`);
          return;
        }
        case "del": {
          const r = await own(intArg(ctx.cmd.args[1], "id", { min: 1 }));
          await ctx.requireConfirmation({
            action: "rule.delete",
            target: String(r.id),
            preview: `delete rule #${r.id} "${r.name}"`,
            run: async () => {
              await s.repos.rules.delete(r.id);
              s.rules.invalidate();
              return `Rule #${r.id} deleted.`;
            },
          });
          return;
        }
        case "chat": {
          const r = await own(intArg(ctx.cmd.args[1], "id", { min: 1 }));
          const op = ctx.cmd.args[2];
          if (op !== "add" && op !== "remove") throw new UsageError("Usage: rule chat <id> add|remove <chat id|here>");
          const [target] = ids(ctx.cmd.args[3], Number.isFinite(here) && ctx.transport === "userbot" ? here : undefined);
          if (target === undefined) throw new UsageError("Give a chat id (or `here`)");
          const def = parseRuleDefinition(r.definition);
          def.scope.chatIds = op === "add" ? [...new Set([...def.scope.chatIds, target])] : def.scope.chatIds.filter((c) => c !== target);
          await s.repos.rules.update(r.id, def);
          s.rules.invalidate();
          await ctx.reply(`✅ Rule #${r.id} ${def.scope.mode}: ${def.scope.chatIds.join(", ") || "(empty)"}`);
          return;
        }
        case "block": {
          const r = await own(intArg(ctx.cmd.args[1], "id", { min: 1 }));
          const uid = intArg(ctx.cmd.args[2], "user id", { min: 1 });
          const def = parseRuleDefinition(r.definition);
          def.filters.blockUserIds = [...new Set([...def.filters.blockUserIds, uid])];
          await s.repos.rules.update(r.id, def);
          s.rules.invalidate();
          await ctx.reply(`✅ Rule #${r.id} will ignore user ${uid}.`);
          return;
        }
        default:
          await ctx.reply(
            [
              "Rules react to INCOMING messages only (never your own, never bots) and apply only in chats you list.",
              "rule add <name> --on=hi,hello [--type=contains|exact|regex] [--word] [--cs] [--cooldown=60] [--private|--group]",
              "     --reply=text | --react=👍 | --notify[=text] | --forward=me|<chat id>",
              "     --here | --chat=id,id   [--mode=blocklist]",
              "rule list · show <id> · on|off <id> · del <id> · chat <id> add|remove <chat> · block <id> <user>",
              "Template variables: {sender} {chat} {match} {rule}",
            ].join("\n"),
          );
      }
    },
  });
}
