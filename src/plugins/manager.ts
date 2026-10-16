import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Logger } from "pino";
import { z } from "zod";
import type { Scheduler } from "../automation/scheduler";
import type { CommandRegistry } from "../commands/registry";
import type { Metrics } from "../core/metrics";
import { UsageError } from "../core/errors";
import type { Messenger } from "../messaging/messenger";
import type { AuditRepo, PluginRepo, SettingsRepo } from "../storage/repositories";
import { PLUGIN_API_VERSION, type Plugin, type PluginContext, type PluginInfo, type PluginMessage, type PluginStatus } from "./types";

const ManifestSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/, "lowercase letters, digits and dashes (2-41 chars)"),
  version: z.string().regex(/^\d+\.\d+\.\d+([-+][\w.]+)?$/, "semantic version like 1.0.0"),
  description: z.string().min(1).max(200),
  apiVersion: z.number().int(),
});

const MAX_CONSECUTIVE_FAILURES = 5;
const HANDLER_TIMEOUT_MS = 10_000;

interface Loaded {
  plugin: Plugin;
  builtin: boolean;
  status: PluginStatus;
  failures: number;
  lastError?: string;
  commands: string[];
  handlers: Array<(m: PluginMessage) => Promise<void> | void>;
  config: Record<string, unknown>;
}

export interface PluginManagerDeps {
  registry: CommandRegistry;
  scheduler: Scheduler;
  repo: PluginRepo;
  settings: SettingsRepo;
  audit: AuditRepo;
  messenger: Messenger;
  logger: Logger;
  metrics: Metrics;
}

const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e: unknown) => (clearTimeout(t), reject(e)),
    );
  });

/**
 * Loads, enables/disables and isolates plugins.
 * - Built-in plugins start enabled; external plugins start DISABLED until the master admin enables them.
 * - Every plugin callback runs inside its own try/catch; 5 consecutive failures auto-disable the plugin.
 * - Plugins run in-process: error isolation is not a security sandbox. Only install plugins you trust.
 */
export class PluginManager {
  private readonly plugins = new Map<string, Loaded>();

  constructor(private readonly d: PluginManagerDeps) {}

  /* ---------------- discovery ---------------- */
  register(plugin: Plugin, builtin: boolean): void {
    const m = ManifestSchema.safeParse(plugin.manifest);
    if (!m.success) throw new UsageError(`Invalid plugin manifest: ${m.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    if (plugin.manifest.apiVersion !== PLUGIN_API_VERSION) throw new UsageError(`Plugin "${plugin.manifest.name}" targets plugin API v${plugin.manifest.apiVersion}; this app provides v${PLUGIN_API_VERSION}`);
    if (this.plugins.has(plugin.manifest.name)) throw new UsageError(`Duplicate plugin name "${plugin.manifest.name}"`);
    this.plugins.set(plugin.manifest.name, { plugin, builtin, status: "disabled", failures: 0, commands: [], handlers: [], config: {} });
  }

  /** Finds plugins in `dir`: `<dir>/<name>/index.(js|cjs|mjs)` or `<dir>/<name>.(js|cjs|mjs)`. Failures are logged, never thrown. */
  async loadDirectory(dir: string): Promise<number> {
    if (!fs.existsSync(dir)) return 0;
    let loaded = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const candidates = entry.isDirectory() ? ["index.js", "index.cjs", "index.mjs"].map((f) => path.join(dir, entry.name, f)) : /\.(c|m)?js$/.test(entry.name) ? [path.join(dir, entry.name)] : [];
      const file = candidates.find((c) => fs.existsSync(c));
      if (!file) continue;
      try {
        const mod = (await import(pathToFileURL(file).href)) as { default?: Plugin } & Partial<Plugin>;
        const plugin = (mod.default && "manifest" in mod.default ? mod.default : mod) as Plugin;
        this.register(plugin, false);
        loaded++;
      } catch (err) {
        this.d.logger.error({ module: "plugins", file: path.relative(dir, file), err: err instanceof Error ? err.message : String(err) }, "failed to load plugin");
      }
    }
    return loaded;
  }

  /* ---------------- lifecycle ---------------- */
  async activateConfigured(): Promise<void> {
    for (const [name, l] of this.plugins) {
      const state = await this.d.repo.get(name);
      const enabled = state?.enabled ?? l.builtin;
      if (enabled) await this.activate(name).catch(() => undefined);
    }
  }

  private async activate(name: string): Promise<void> {
    const l = this.must(name);
    const state = await this.d.repo.get(name);
    const merged = { ...(l.plugin.manifest.defaults ?? {}), ...(state?.config ?? {}) };
    const schema = l.plugin.manifest.configSchema;
    if (schema) {
      const parsed = schema.safeParse(merged);
      if (!parsed.success) {
        this.fail(l, name, `invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
        throw new UsageError(l.lastError as string);
      }
      l.config = parsed.data;
    } else l.config = merged;

    l.commands = [];
    l.handlers = [];
    try {
      await l.plugin.activate(this.makeContext(name, l));
      l.status = "active";
      l.failures = 0;
      l.lastError = undefined;
      await this.d.repo.upsert(name, { enabled: true, version: l.plugin.manifest.version });
      this.d.logger.info({ module: "plugins", plugin: name, version: l.plugin.manifest.version }, "plugin activated");
    } catch (err) {
      this.teardown(name, l);
      this.fail(l, name, err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  private teardown(name: string, l: Loaded): void {
    this.d.registry.unregisterOwner(`plugin:${name}`);
    this.d.scheduler.unregisterOwner(`plugin:${name}`);
    l.handlers = [];
    l.commands = [];
  }

  private fail(l: Loaded, name: string, error: string): void {
    l.status = "failed";
    l.lastError = error;
    this.d.logger.error({ module: "plugins", plugin: name, err: error }, "plugin failed");
  }

  async enable(name: string, actorId: number): Promise<void> {
    const l = this.must(name);
    if (l.status === "active") return;
    await this.d.repo.upsert(name, { enabled: true });
    await this.activate(name);
    await this.d.audit.add({ actorId, action: "plugin.enable", target: name, result: "ok" });
  }

  async disable(name: string, actorId: number): Promise<void> {
    const l = this.must(name);
    await this.deactivate(name, l);
    l.status = "disabled";
    await this.d.repo.upsert(name, { enabled: false });
    await this.d.audit.add({ actorId, action: "plugin.disable", target: name, result: "ok" });
  }

  private async deactivate(name: string, l: Loaded): Promise<void> {
    try {
      await l.plugin.deactivate?.();
    } catch (err) {
      this.d.logger.warn({ module: "plugins", plugin: name, err: String(err) }, "plugin deactivate threw");
    }
    this.teardown(name, l);
  }

  /** Sets one top-level config key (validated against the plugin's schema) and restarts the plugin if it was active. */
  async setConfig(name: string, key: string, rawValue: string, actorId: number): Promise<void> {
    const l = this.must(name);
    let value: unknown = rawValue;
    try {
      value = JSON.parse(rawValue);
    } catch {
      /* keep as string */
    }
    const state = await this.d.repo.get(name);
    const next = { ...(state?.config ?? {}), [key]: value };
    const schema = l.plugin.manifest.configSchema;
    if (schema) {
      const parsed = schema.safeParse({ ...(l.plugin.manifest.defaults ?? {}), ...next });
      if (!parsed.success) throw new UsageError(`Invalid value: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    }
    await this.d.repo.upsert(name, { config: next });
    await this.d.audit.add({ actorId, action: "plugin.config", target: name, details: { key }, result: "ok" });
    if (l.status === "active") {
      await this.deactivate(name, l);
      await this.activate(name);
    }
  }

  /* ---------------- runtime ---------------- */
  private makeContext(name: string, l: Loaded): PluginContext {
    const owner = `plugin:${name}`;
    const logger = this.d.logger.child({ module: "plugin", plugin: name });
    const guard = <A extends unknown[]>(label: string, fn: (...a: A) => Promise<void> | void) =>
      async (...args: A): Promise<void> => {
        try {
          await fn(...args);
          l.failures = 0;
        } catch (err) {
          await this.recordFailure(name, l, label, err);
          throw err;
        }
      };
    return {
      name,
      logger,
      config: Object.freeze({ ...l.config }),
      registerCommand: (cmd) => {
        this.d.registry.register({ ...cmd, aliases: cmd.aliases, group: `plugin:${name}`, scope: cmd.scope ?? "self", run: guard(`command ${cmd.name}`, cmd.run) }, owner);
        l.commands.push(cmd.name);
      },
      onMessage: (h) => {
        l.handlers.push(h);
      },
      registerTaskKind: (kind, handler, opts) => {
        this.d.scheduler.registerKind(`${name}:${kind}`, guard(`task ${kind}`, handler), { owner, runIfLate: opts?.runIfLate });
      },
      send: async (peer, text) => {
        await this.d.messenger.sendText(peer, text);
      },
      storage: {
        get: (k) => this.d.settings.get(`plugin.${name}.${k}`),
        set: (k, v) => this.d.settings.set(`plugin.${name}.${k}`, v),
        delete: (k) => this.d.settings.delete(`plugin.${name}.${k}`),
      },
    };
  }

  private async recordFailure(name: string, l: Loaded, label: string, err: unknown): Promise<void> {
    l.failures++;
    l.lastError = `${label}: ${err instanceof Error ? err.message : String(err)}`;
    this.d.metrics.inc("plugins.errors");
    this.d.logger.warn({ module: "plugins", plugin: name, label, failures: l.failures, err: l.lastError }, "plugin error (isolated)");
    if (l.failures >= MAX_CONSECUTIVE_FAILURES && l.status === "active") {
      await this.deactivate(name, l);
      l.status = "failed";
      await this.d.repo.upsert(name, { enabled: false });
      await this.d.audit.add({ actorId: 0, action: "plugin.auto-disable", target: name, details: { error: l.lastError }, result: "disabled after repeated failures" });
      this.d.logger.error({ module: "plugins", plugin: name }, "plugin auto-disabled after repeated failures");
    }
  }

  /** Delivers a message to every active plugin handler; one plugin's failure never affects another. */
  async dispatchMessage(m: PluginMessage): Promise<void> {
    for (const [name, l] of this.plugins) {
      if (l.status !== "active") continue;
      for (const h of [...l.handlers]) {
        try {
          await withTimeout(Promise.resolve(h(m)), HANDLER_TIMEOUT_MS, `plugin ${name} message handler`);
          l.failures = 0;
        } catch (err) {
          await this.recordFailure(name, l, "message handler", err);
        }
      }
    }
  }

  async shutdown(): Promise<void> {
    for (const [name, l] of this.plugins) if (l.status === "active") await this.deactivate(name, l);
  }

  list(): PluginInfo[] {
    return [...this.plugins.entries()].map(([name, l]) => ({
      name,
      version: l.plugin.manifest.version,
      description: l.plugin.manifest.description,
      builtin: l.builtin,
      status: l.status,
      failures: l.failures,
      lastError: l.lastError,
      commands: l.commands,
      config: l.config,
    }));
  }

  private must(name: string): Loaded {
    const l = this.plugins.get(name);
    if (!l) throw new UsageError(`No plugin named "${name}"`, `Installed: ${[...this.plugins.keys()].join(", ") || "none"}`);
    return l;
  }
}
