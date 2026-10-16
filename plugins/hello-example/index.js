"use strict";
/**
 * Example external plugin (CommonJS). External plugins start DISABLED:
 *   master admin:  .plugin enable hello-example
 * See docs/PLUGINS.md for the full interface.
 */
module.exports = {
  manifest: {
    name: "hello-example",
    version: "1.0.0",
    description: "Replies to .hello and keeps a per-plugin counter.",
    apiVersion: 1,
    defaults: { greeting: "Hello" },
  },
  activate(ctx) {
    ctx.registerCommand({
      name: "hello",
      usage: "hello [name]",
      description: "Greets and counts how often it was used",
      async run(c) {
        const n = Number((await ctx.storage.get("count")) ?? "0") + 1;
        await ctx.storage.set("count", String(n));
        await c.reply(`${ctx.config.greeting}, ${c.cmd.args[0] ?? "world"}! (used ${n}x)`);
      },
    });
  },
};
