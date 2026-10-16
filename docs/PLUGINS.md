# Plugins

A plugin is a CommonJS (`.js`/`.cjs`) or ES module (`.mjs`) exporting `{ manifest, activate, deactivate? }`.
Place it in `PLUGINS_DIR` (default `./plugins`) as `plugins/<name>/index.js` or `plugins/<name>.js`. See
`plugins/hello-example/index.js` for a complete example.

```js
module.exports = {
  manifest: {
    name: "daily-quote",          // lowercase slug, 2–41 chars
    version: "1.0.0",             // semantic version of the plugin
    description: "Posts a quote on request.",
    apiVersion: 1,                // plugin interface version (must match the app)
    // optional: zod schema for configuration + defaults
    defaults: { greeting: "Hello" },
  },
  activate(ctx) { /* register things */ },
  deactivate() { /* optional cleanup */ },
};
```

## `ctx` (PluginContext, API v1)

| Member | Purpose |
| --- | --- |
| `ctx.name`, `ctx.logger` | identity; a pino child logger (secrets are redacted) |
| `ctx.config` | frozen config: manifest `defaults` + stored values, validated by `configSchema` if given |
| `ctx.registerCommand({ name, aliases?, usage, description, scope?, run(c) })` | add a command; default scope `self`. `c` is the normal command context (`c.reply`, `c.cmd.args`, `c.requireConfirmation`, …) |
| `ctx.onMessage(handler)` | receive `{ text, chatId, chatType, senderId, messageId, isOut }` for every message (in memory only) |
| `ctx.registerTaskKind(kind, handler, { runIfLate? })` | scheduled-task handler, registered as `<plugin>:<kind>` |
| `ctx.send(peer, text)` | send plain text through the paced, FloodWait-aware messenger |
| `ctx.storage.get/set/delete` | key/value store private to the plugin |

Plugins deliberately do **not** receive the raw Telegram client; sending goes through the Messenger so pacing,
retries and FloodWait handling can't be bypassed by accident.

## Lifecycle and safety

- Built-in plugins start enabled. **External plugins start disabled**: `plugin enable <name>` (master only).
- `plugins` lists state; `plugin disable <name>`; `plugin config <name> <key> <value>` (JSON values allowed) validates and restarts the plugin.
- Every callback runs inside its own try/catch. After **5 consecutive failures** a plugin is disabled automatically
  (audited). A command-name collision makes only the later plugin fail.
- Message handlers have a 10 s time limit. Plugins run in-process: this is isolation of *errors*, not a sandbox.
- A manifest with a different `apiVersion` is refused with a clear message.

## Versioning

`PLUGIN_API_VERSION` (currently 1) changes only for incompatible interface changes. Additive changes keep the number.
