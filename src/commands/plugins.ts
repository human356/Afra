import { UsageError } from "../core/errors";
import type { Services } from "../core/services";
import type { CommandRegistry } from "./registry";

export function registerPluginCommands(reg: CommandRegistry, s: Services): void {
  reg.register({
    name: "plugins",
    group: "Plugins",
    scope: "master",
    usage: "plugins",
    description: "List plugins and their state",
    async run(ctx) {
      const l = s.plugins.list();
      await ctx.reply(l.length ? l.map((p) => `${p.status === "active" ? "🟢" : p.status === "failed" ? "🔴" : "⚪"} ${p.name} v${p.version}${p.builtin ? " (built-in)" : ""} — ${p.description}${p.lastError ? `\n   last error: ${p.lastError}` : ""}`).join("\n") : "No plugins installed.");
    },
  });

  reg.register({
    name: "plugin",
    group: "Plugins",
    scope: "master",
    usage: "plugin enable|disable <name> | plugin config <name> <key> <value>",
    description: "Enable/disable a plugin or set one of its config values",
    async run(ctx) {
      const [op, name, key, ...rest] = ctx.cmd.args;
      if (!op || !name) throw new UsageError("Usage: plugin enable|disable <name> | plugin config <name> <key> <value>");
      if (op === "enable") await s.plugins.enable(name, ctx.principal.userId);
      else if (op === "disable") await s.plugins.disable(name, ctx.principal.userId);
      else if (op === "config") {
        if (!key || !rest.length) throw new UsageError("Usage: plugin config <name> <key> <value>");
        await s.plugins.setConfig(name, key, rest.join(" "), ctx.principal.userId);
      } else throw new UsageError(`Unknown plugin action "${op}"`);
      await ctx.reply(`✅ plugin ${name}: ${op} done.`);
    },
  });
}
