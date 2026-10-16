import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CommandRegistry } from "../src/commands/registry";
import { Metrics } from "../src/core/metrics";
import { PluginManager } from "../src/plugins/manager";
import type { Plugin, PluginMessage } from "../src/plugins/types";
import { timePlugin } from "../src/plugins/builtin/time";
import { memDb, silent } from "./helpers";

const MSG: PluginMessage = { text: "hi", chatId: 1, chatType: "private", messageId: 1, isOut: false };

async function setup() {
  const { repos } = await memDb();
  const registry = new CommandRegistry();
  const scheduler = { registerKind: vi.fn(), unregisterOwner: vi.fn() };
  const sent: string[] = [];
  const mgr = new PluginManager({ registry, scheduler: scheduler as never, repo: repos.plugins, settings: repos.settings, audit: repos.audit, messenger: { sendText: async (_p: unknown, t: string) => void sent.push(t) } as never, logger: silent, metrics: new Metrics() });
  return { mgr, registry, scheduler, repos, sent };
}

const plugin = (name: string, over: Partial<Plugin> = {}): Plugin => ({ manifest: { name, version: "1.0.0", description: "test plugin", apiVersion: 1 }, activate: () => undefined, ...over });

describe("plugin manager", () => {
  it("validates manifests and API versions", async () => {
    const { mgr } = await setup();
    expect(() => mgr.register({ manifest: { name: "Bad Name", version: "1", description: "x", apiVersion: 1 }, activate() {} } as Plugin, true)).toThrow(/Invalid plugin manifest/);
    expect(() => mgr.register(plugin("future", { manifest: { name: "future", version: "1.0.0", description: "x", apiVersion: 99 } }), true)).toThrow(/API v99/);
    mgr.register(plugin("dup"), true);
    expect(() => mgr.register(plugin("dup"), true)).toThrow(/Duplicate/);
  });

  it("built-ins start enabled; external plugins stay disabled until the master enables them", async () => {
    const { mgr, registry } = await setup();
    mgr.register(timePlugin, true);
    mgr.register(plugin("external", { activate: (ctx) => ctx.registerCommand({ name: "ext", usage: "ext", description: "d", run: async () => undefined }) }), false);
    await mgr.activateConfigured();
    expect(mgr.list().find((p) => p.name === "time")?.status).toBe("active");
    expect(mgr.list().find((p) => p.name === "external")?.status).toBe("disabled");
    expect(registry.get("ext")).toBeUndefined();
    await mgr.enable("external", 1000);
    expect(registry.get("ext")?.scope).toBe("self");
    await mgr.disable("external", 1000);
    expect(registry.get("ext")).toBeUndefined();
  });

  it("remembers enabled state across restarts via the database", async () => {
    const t = await setup();
    t.mgr.register(plugin("ext2"), false);
    await t.mgr.enable("ext2", 1);
    const again = new PluginManager({ registry: new CommandRegistry(), scheduler: t.scheduler as never, repo: t.repos.plugins, settings: t.repos.settings, audit: t.repos.audit, messenger: {} as never, logger: silent, metrics: new Metrics() });
    again.register(plugin("ext2"), false);
    await again.activateConfigured();
    expect(again.list()[0]?.status).toBe("active");
  });

  it("isolates a crashing message handler: others keep working, and it is auto-disabled after 5 failures", async () => {
    const t = await setup();
    const good = vi.fn();
    t.mgr.register(plugin("crashy", { activate: (ctx) => ctx.onMessage(() => { throw new Error("kaboom"); }) }), true);
    t.mgr.register(plugin("healthy", { activate: (ctx) => ctx.onMessage(good) }), true);
    await t.mgr.activateConfigured();
    for (let i = 0; i < 6; i++) await t.mgr.dispatchMessage(MSG);
    const crashy = t.mgr.list().find((p) => p.name === "crashy");
    expect(crashy?.status).toBe("failed");
    expect(crashy?.lastError).toMatch(/kaboom/);
    expect(good).toHaveBeenCalledTimes(6);
    expect(t.mgr.list().find((p) => p.name === "healthy")?.status).toBe("active");
    expect((await t.repos.audit.recent(10)).some((a) => a.action === "plugin.auto-disable")).toBe(true);
    expect((await t.repos.plugins.get("crashy"))?.enabled).toBe(false);
  });

  it("a plugin whose activate() throws is marked failed and leaves nothing registered", async () => {
    const t = await setup();
    t.mgr.register(plugin("broken", { activate: (ctx) => { ctx.registerCommand({ name: "half", usage: "h", description: "d", run: async () => undefined }); throw new Error("init failed"); } }), true);
    await t.mgr.activateConfigured();
    expect(t.mgr.list()[0]).toMatchObject({ status: "failed" });
    expect(t.registry.get("half")).toBeUndefined();
  });

  it("refuses command names that collide with another owner", async () => {
    const t = await setup();
    t.mgr.register(plugin("plug-a", { activate: (ctx) => ctx.registerCommand({ name: "same", usage: "s", description: "d", run: async () => undefined }) }), true);
    t.mgr.register(plugin("plug-b", { activate: (ctx) => ctx.registerCommand({ name: "same", usage: "s", description: "d", run: async () => undefined }) }), true);
    await t.mgr.activateConfigured();
    const statuses = Object.fromEntries(t.mgr.list().map((p) => [p.name, p.status]));
    expect(statuses).toEqual({ "plug-a": "active", "plug-b": "failed" });
  });

  it("validates and applies per-plugin configuration, restarting the plugin", async () => {
    const t = await setup();
    const seen: unknown[] = [];
    t.mgr.register(plugin("cfg", { manifest: { name: "cfg", version: "1.0.0", description: "x", apiVersion: 1, configSchema: z.object({ n: z.number().min(1).max(10) }), defaults: { n: 3 } }, activate: (ctx) => void seen.push(ctx.config["n"]) }), true);
    await t.mgr.activateConfigured();
    await expect(t.mgr.setConfig("cfg", "n", "99", 1000)).rejects.toThrow(/Invalid value/);
    await t.mgr.setConfig("cfg", "n", "7", 1000);
    expect(seen).toEqual([3, 7]);
    expect(t.mgr.list()[0]?.config).toEqual({ n: 7 });
  });

  it("gives each plugin private key/value storage", async () => {
    const t = await setup();
    let ctxA: import("../src/plugins/types").PluginContext | undefined;
    let ctxB: import("../src/plugins/types").PluginContext | undefined;
    t.mgr.register(plugin("pa", { activate: (c) => void (ctxA = c) }), true);
    t.mgr.register(plugin("pb", { activate: (c) => void (ctxB = c) }), true);
    await t.mgr.activateConfigured();
    await ctxA!.storage.set("k", "A");
    expect(await ctxB!.storage.get("k")).toBeUndefined();
    expect(await ctxA!.storage.get("k")).toBe("A");
  });

  it("registers task kinds under a namespaced name and cleans up on disable", async () => {
    const t = await setup();
    t.mgr.register(plugin("tasky", { activate: (c) => c.registerTaskKind("job", async () => undefined) }), true);
    await t.mgr.activateConfigured();
    expect(t.scheduler.registerKind).toHaveBeenCalledWith("tasky:job", expect.any(Function), expect.objectContaining({ owner: "plugin:tasky" }));
    await t.mgr.disable("tasky", 1);
    expect(t.scheduler.unregisterOwner).toHaveBeenCalledWith("plugin:tasky");
  });

  it("the built-in time plugin works and rejects bad zones", async () => {
    const t = await setup();
    t.mgr.register(timePlugin, true);
    await t.mgr.activateConfigured();
    const replies: string[] = [];
    const ctx = (args: string[]) => ({ cmd: { args }, reply: async (s: string) => void replies.push(s) }) as never;
    await t.registry.get("time")!.run(ctx(["Europe/Berlin"]));
    expect(replies[0]).toMatch(/Europe\/Berlin/);
    await expect(t.registry.get("time")!.run(ctx(["Mars/Base"]))).rejects.toThrow(/time zone/);
  });
});

describe("plugin directory loading", () => {
  it("loads the shipped example plugin from ./plugins and never throws on bad files", async () => {
    const t = await setup();
    const loaded = await t.mgr.loadDirectory(`${process.cwd()}/plugins`);
    expect(loaded).toBeGreaterThanOrEqual(1);
    expect(t.mgr.list().some((p) => p.name === "hello-example" && p.status === "disabled")).toBe(true);
    expect(await t.mgr.loadDirectory("/definitely/not/here")).toBe(0);
  });
});
