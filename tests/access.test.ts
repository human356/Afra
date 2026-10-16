import { describe, expect, it } from "vitest";
import { AccessControl } from "../src/auth/access";
import { ConfirmationManager } from "../src/commands/confirmations";
import { CommandDispatcher, type IncomingCommand } from "../src/commands/dispatcher";
import { CommandRegistry } from "../src/commands/registry";
import { Metrics } from "../src/core/metrics";
import { BoundedQueue } from "../src/core/queue";
import { memDb, silent, testConfig } from "./helpers";

const MASTER = 1000;

async function setup(env: Record<string, string> = {}) {
  const { repos } = await memDb();
  const access = new AccessControl(MASTER, repos.users, repos.audit, 0);
  const registry = new CommandRegistry();
  const cfg = testConfig(env);
  const confirmations = new ConfirmationManager(60);
  const queue = new BoundedQueue(4, 50);
  const dispatcher = new CommandDispatcher({ cfg, logger: silent, registry, access, confirmations, audit: repos.audit, metrics: new Metrics(), queue });
  const ran: string[] = [];
  registry.register({ name: "hi", group: "t", scope: "self", usage: "hi", description: "", run: async (c) => { ran.push("hi"); await c.reply("hello"); } });
  registry.register({ name: "send", group: "t", scope: "messaging", usage: "send", description: "", run: async (c) => { ran.push("send"); await c.reply("sent"); } });
  registry.register({ name: "secret", group: "t", scope: "master", usage: "secret", description: "", run: async (c) => { ran.push("secret"); await c.reply("s"); } });
  let destroyed = 0;
  registry.register({
    name: "wipe",
    group: "t",
    scope: "self",
    usage: "wipe",
    description: "",
    run: (c) => c.requireConfirmation({ action: "test.wipe", preview: "wipe everything", run: async () => (destroyed++, "wiped") }),
  });
  const replies: string[] = [];
  const msg = (senderId: number, text: string, transport: "userbot" | "bot" = "userbot"): IncomingCommand => ({
    transport,
    senderId,
    chatId: "1",
    text,
    reply: async (t) => void replies.push(t),
    progress: async () => async () => undefined,
    getRepliedMessage: async () => undefined,
  });
  return { repos, access, dispatcher, confirmations, replies, ran, msg, destroyed: () => destroyed };
}

describe("access control", () => {
  it("master always has full access; strangers have none", async () => {
    const { access } = await setup();
    expect((await access.resolve(MASTER))?.isMaster).toBe(true);
    expect(await access.resolve(42)).toBeUndefined();
  });

  it("only the master can grant; scopes are validated; master cannot be demoted", async () => {
    const { access } = await setup();
    await expect(access.grant(42, 43)).rejects.toThrow(/master/);
    expect(() => access.parseScopes(["bogus"])).toThrow(/Unknown scope/);
    expect(() => access.parseScopes(["all"])).toThrow(/not allowed/);
    await expect(access.grant(MASTER, MASTER)).rejects.toThrow();
    await access.grant(MASTER, 43, access.parseScopes(["self,search"]), "pal");
    const p = await access.resolve(43);
    expect(p?.isMaster).toBe(false);
    expect([...(p?.scopes ?? [])].sort()).toEqual(["search", "self"]);
    await expect(access.revoke(43, MASTER)).rejects.toThrow();
  });

  it("revoke and suspend take effect immediately and are audited", async () => {
    const { access, repos } = await setup();
    await access.grant(MASTER, 50, ["self"]);
    await access.setEnabled(MASTER, 50, false);
    expect(await access.resolve(50)).toBeUndefined();
    await access.setEnabled(MASTER, 50, true);
    expect(await access.resolve(50)).toBeDefined();
    expect(await access.revoke(MASTER, 50)).toBe(true);
    expect(await access.resolve(50)).toBeUndefined();
    expect((await repos.audit.recent(10)).map((a) => a.action)).toContain("access.revoke");
  });
});

describe("command dispatcher", () => {
  it("ignores strangers silently on the userbot transport, politely refuses on the bot", async () => {
    const t = await setup();
    expect(await t.dispatcher.handle(t.msg(42, ".hi"))).toBe(false);
    expect(t.replies).toEqual([]);
    expect(t.ran).toEqual([]);
    await t.dispatcher.handle(t.msg(42, "/hi", "bot"));
    expect(t.replies[0]).toMatch(/private/);
  });

  it("does not treat ordinary text as a command", async () => {
    const t = await setup();
    expect(await t.dispatcher.handle(t.msg(MASTER, "just chatting"))).toBe(false);
  });

  it("enforces scopes for self-mode users and master-only commands", async () => {
    const t = await setup();
    await t.access.grant(MASTER, 7, ["self"]);
    await t.dispatcher.handle(t.msg(7, ".hi"));
    await t.dispatcher.handle(t.msg(7, ".send"));
    await t.dispatcher.handle(t.msg(7, ".secret"));
    expect(t.ran).toEqual(["hi"]);
    expect(t.replies.filter((r) => /permission/.test(r))).toHaveLength(2);
    await t.dispatcher.handle(t.msg(MASTER, ".secret"));
    expect(t.ran).toEqual(["hi", "secret"]);
    expect((await t.repos.audit.recent(10)).filter((a) => a.result === "denied")).toHaveLength(2);
  });

  it("destructive actions: preview first, execute only after confirmation by the same user", async () => {
    const t = await setup();
    await t.dispatcher.handle(t.msg(MASTER, ".wipe"));
    expect(t.destroyed()).toBe(0);
    expect(t.replies[0]).toMatch(/DRY RUN/);
    const token = /confirm (\w+)/.exec(t.replies[0] as string)?.[1] as string;
    expect(token).toBeTruthy();
    expect(t.confirmations.take(999, token)).toBeUndefined(); // someone else cannot use it
    const pending = t.confirmations.take(MASTER, token);
    expect(pending).toBeDefined();
    expect(t.confirmations.take(MASTER, token)).toBeUndefined(); // single use
    await t.dispatcher.execute(MASTER, pending!, async (m) => void t.replies.push(m));
    expect(t.destroyed()).toBe(1);
    const log = await t.repos.audit.recent(10);
    expect(log.some((a) => a.action === "test.wipe" && a.dryRun)).toBe(true);
    expect(log.some((a) => a.action === "test.wipe" && a.result === "ok")).toBe(true);
  });

  it("--yes is ignored while DRY_RUN_DEFAULT=true, honoured when false, --dry never executes", async () => {
    const strict = await setup();
    await strict.dispatcher.handle(strict.msg(MASTER, ".wipe --yes"));
    expect(strict.destroyed()).toBe(0);

    const relaxed = await setup({ DRY_RUN_DEFAULT: "false" });
    await relaxed.dispatcher.handle(relaxed.msg(MASTER, ".wipe --yes"));
    expect(relaxed.destroyed()).toBe(1);
    await relaxed.dispatcher.handle(relaxed.msg(MASTER, ".wipe --yes --dry"));
    expect(relaxed.destroyed()).toBe(1);
    expect(relaxed.replies.at(-1)).toMatch(/Nothing was changed/);
  });

  it("confirmation tokens expire", async () => {
    let now = 0;
    const cm = new ConfirmationManager(60, () => now);
    const { token } = cm.create({ userId: 1, action: "a", preview: "p", run: async () => "ok" });
    now = 61_000;
    expect(cm.take(1, token)).toBeUndefined();
  });

  it("rate-limits non-master users but not the master", async () => {
    const t = await setup();
    await t.access.grant(MASTER, 9, ["self"]);
    for (let i = 0; i < 40; i++) await t.dispatcher.handle(t.msg(9, ".hi"));
    expect(t.ran.length).toBe(30);
    expect(t.replies.some((r) => /Slow down/.test(r))).toBe(true);
    for (let i = 0; i < 40; i++) await t.dispatcher.handle(t.msg(MASTER, ".hi"));
    expect(t.ran.length).toBe(70);
  });

  it("unknown commands: explained on the control bot, left alone on the userbot (it may be ordinary text)", async () => {
    const t = await setup();
    expect(await t.dispatcher.handle(t.msg(MASTER, ".net is a framework"))).toBe(false);
    expect(t.replies).toEqual([]);
    expect(await t.dispatcher.handle(t.msg(MASTER, "/nope", "bot"))).toBe(true);
    expect(t.replies[0]).toMatch(/Unknown command/);
  });

  it("a stranger's dot-prefixed chat text is not swallowed on the userbot", async () => {
    const t = await setup();
    expect(await t.dispatcher.handle(t.msg(42, ".hi everyone"))).toBe(false);
  });
});
