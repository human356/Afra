import { describe, expect, it, vi } from "vitest";
import { AccessControl } from "../src/auth/access";
import { TaskService } from "../src/automation/scheduler";
import { registerAllCommands } from "../src/commands";
import { ConfirmationManager } from "../src/commands/confirmations";
import { CommandDispatcher, type IncomingCommand } from "../src/commands/dispatcher";
import { CommandRegistry } from "../src/commands/registry";
import { probeFeatures } from "../src/core/features";
import { libInfo } from "../src/core/library";
import { Metrics } from "../src/core/metrics";
import { BoundedQueue } from "../src/core/queue";
import type { Services } from "../src/core/services";
import { memDb, silent, testConfig } from "./helpers";

const MASTER = 1000;

async function build(env: Record<string, string> = {}) {
  const { repos, db } = await memDb();
  const cfg = testConfig(env);
  const metrics = new Metrics();
  const queue = new BoundedQueue(4, 50);
  const access = new AccessControl(MASTER, repos.users, repos.audit, 0);
  const registry = new CommandRegistry();
  const confirmations = new ConfirmationManager(60);
  const dispatcher = new CommandDispatcher({ cfg, logger: silent, registry, access, confirmations, audit: repos.audit, metrics, queue });
  const messenger = {
    sendText: vi.fn(async () => [{ id: 55 }]),
    sendSaved: vi.fn(async () => [{ id: 56 }]),
    history: vi.fn(async () => [{ id: 40, message: "old A" }, { id: 41, message: "old B" }, { id: 99, message: ".del 2" }]),
    deleteMessages: vi.fn(async (_p: unknown, ids: number[]) => ids.length),
    forward: vi.fn(async () => 1),
    call: async (_l: string, fn: () => Promise<unknown>) => fn(),
  };
  const rulesInvalidate = vi.fn();
  const s = {
    cfg, logger: silent, metrics, db, repos, access, queue, registry, confirmations, dispatcher, messenger,
    tasks: new TaskService(repos.tasks),
    rules: { invalidate: rulesInvalidate },
    plugins: { list: () => [] },
    features: probeFeatures(libInfo()),
    account: { id: 1, name: "Acct", username: "acct" },
    client: { connected: true },
    search: { archivingAvailable: false },
    translator: { translate: vi.fn(async () => "translated") },
    ai: { summarize: vi.fn(async () => "summary") },
    scheduler: { running: true },
    admin: { requireRight: vi.fn(async () => { throw Object.assign(new Error("no right"), { name: "PermissionError" }); }), findPurgeTargets: vi.fn(async () => [1]) },
  } as unknown as Services;
  registerAllCommands(registry, s);
  const replies: string[] = [];
  const say = (senderId: number, text: string, opts: { transport?: "userbot" | "bot"; replied?: unknown; messageId?: number; chatId?: string } = {}): Promise<boolean> => {
    const inc: IncomingCommand = {
      transport: opts.transport ?? "userbot",
      senderId,
      chatId: opts.chatId ?? "-1001",
      messageId: opts.messageId ?? 99,
      text,
      reply: async (t) => void replies.push(t),
      progress: async () => async (t) => void replies.push(t),
      getRepliedMessage: async () => opts.replied as never,
    };
    return dispatcher.handle(inc);
  };
  return { s, say, replies, messenger, repos, rulesInvalidate, last: () => replies.at(-1) ?? "" };
}

describe("access management commands (control bot)", () => {
  it("master grants, lists and revokes; scopes appear in the reply", async () => {
    const t = await build();
    await t.say(MASTER, "/grant 2000 self,search --note=alice", { transport: "bot" });
    expect(t.last()).toMatch(/User 2000 now has self mode with: self, search/);
    await t.say(MASTER, "/users", { transport: "bot" });
    expect(t.last()).toMatch(/2000 — self, search — alice/);
    await t.say(2000, "/me", { transport: "bot" });
    expect(t.last()).toMatch(/self mode/);
    await t.say(MASTER, "/revoke 2000", { transport: "bot" });
    await t.say(2000, "/me", { transport: "bot" });
    expect(t.last()).toMatch(/private/);
  });

  it("granted users cannot grant others, and bad input is explained", async () => {
    const t = await build();
    await t.s.access.grant(MASTER, 2000, ["self"]);
    await t.say(2000, "/grant 3000", { transport: "bot" });
    expect(t.last()).toMatch(/permission/);
    expect(await t.s.access.resolve(3000)).toBeUndefined();
    await t.say(MASTER, "/grant abc", { transport: "bot" });
    expect(t.last()).toMatch(/numeric Telegram user id/);
    await t.say(MASTER, "/grant 2000 superpowers", { transport: "bot" });
    expect(t.last()).toMatch(/Unknown scope/);
  });

  it("help only lists what the caller may run", async () => {
    const t = await build();
    await t.s.access.grant(MASTER, 2000, ["self"]);
    await t.say(2000, ".help");
    const limited = t.last();
    expect(limited).toContain(".remind");
    expect(limited).not.toContain(".grant");
    expect(limited).not.toContain(".send");
    await t.say(MASTER, ".help");
    expect(t.last()).toContain(".grant");
    expect(t.last()).toContain(".send");
  });
});

describe("reminders", () => {
  it("creates, lists and cancels; bot reminders are delivered via the bot to the user", async () => {
    const t = await build();
    await t.s.access.grant(MASTER, 2000, ["self"]);
    await t.say(2000, "/remind 10m drink water --repeat=2h", { transport: "bot" });
    expect(t.last()).toMatch(/Reminder #1 set/);
    const [task] = await t.repos.tasks.list({ ownerId: 2000 });
    expect(task).toMatchObject({ kind: "reminder", repeatSec: 7200, payload: { via: "bot", chat: 2000, text: "drink water" } });
    await t.say(2000, "/reminders", { transport: "bot" });
    expect(t.last()).toMatch(/#1 .*every 2h.*drink water/);
    await t.say(3000, "/unremind 1", { transport: "bot" }); // a stranger
    await t.say(MASTER, ".remind 5m other");
    await t.s.access.grant(MASTER, 4000, ["self"]);
    await t.say(4000, ".unremind 1");
    expect(t.last()).toMatch(/No pending task/); // cannot cancel someone else's
    await t.say(2000, "/unremind 1", { transport: "bot" });
    expect(t.last()).toMatch(/Cancelled #1/);
  });

  it("rejects past times, unknown time words, and tiny repeats", async () => {
    const t = await build();
    await t.say(MASTER, ".remind whenever stuff");
    expect(t.last()).toMatch(/Could not understand the time/);
    await t.say(MASTER, ".remind 10m x --repeat=5s");
    expect(t.last()).toMatch(/at least 60s/);
    await t.say(MASTER, ".remind 10m");
    expect(t.last()).toMatch(/Usage: remind/);
  });
});

describe("rules", () => {
  it("refuses rules that would apply nowhere/everywhere by accident", async () => {
    const t = await build();
    await t.say(MASTER, '.rule add greet --on=hi,hello --reply="Hey!"');
    expect(t.last()).toMatch(/Say where the rule applies/);
    await t.say(MASTER, ".rule add greet --on=hi --here");
    expect(t.last()).toMatch(/exactly one action/);
  });

  it("creates a rule scoped to the current chat, shows it, toggles it, and deletion needs confirmation", async () => {
    const t = await build();
    await t.say(MASTER, '.rule add greet --on=hi,hello --reply="Hey {sender}!" --here --word --cooldown=30');
    expect(t.last()).toMatch(/Rule #1 "greet" created/);
    const [row] = await t.repos.rules.list();
    expect(row?.definition).toMatchObject({ scope: { mode: "allowlist", chatIds: [-1001] }, trigger: { wholeWord: true }, cooldownSec: 30, action: { type: "reply" } });
    expect(t.rulesInvalidate).toHaveBeenCalled();
    await t.say(MASTER, ".rule off 1");
    expect((await t.repos.rules.get(1))?.enabled).toBe(false);
    await t.say(MASTER, ".rule del 1");
    expect(t.last()).toMatch(/DRY RUN/);
    expect(await t.repos.rules.get(1)).toBeDefined();
    const token = /confirm (\w+)/.exec(t.last())?.[1] as string;
    await t.say(MASTER, `.confirm ${token}`);
    expect(await t.repos.rules.get(1)).toBeUndefined();
  });

  it("non-master users may only forward matches to Saved Messages, never to other chats", async () => {
    const t = await build();
    await t.s.access.grant(MASTER, 2000, ["self", "automation"]);
    await t.say(2000, ".rule add leak --on=secret --here --forward=-100999");
    expect(t.last()).toMatch(/Only the master admin can forward/);
    await t.say(2000, ".rule add ok --on=secret --here --forward=me");
    expect(t.last()).toMatch(/created/);
    await t.say(MASTER, ".rule add m --on=secret --here --forward=-100999");
    expect(t.last()).toMatch(/created/);
  });

  it("users can only manage their own rules (needs the automation scope)", async () => {
    const t = await build();
    await t.s.access.grant(MASTER, 2000, ["self", "automation"]);
    await t.say(MASTER, ".rule add mine --on=x --here --notify");
    await t.say(2000, ".rule show 1");
    expect(t.last()).toMatch(/No rule #1 of yours/);
    await t.s.access.grant(MASTER, 3000, ["self"]);
    await t.say(3000, ".rule list");
    expect(t.last()).toMatch(/permission/);
  });
});

describe("messaging commands", () => {
  it(".del previews first and only deletes the account's own previous messages after confirmation", async () => {
    const t = await build();
    await t.say(MASTER, ".del 2");
    expect(t.messenger.deleteMessages).not.toHaveBeenCalled();
    expect(t.last()).toMatch(/DRY RUN — delete 2 message\(s\)/);
    const token = /confirm (\w+)/.exec(t.last())?.[1] as string;
    await t.say(MASTER, `.confirm ${token}`, { messageId: 100 });
    expect(t.messenger.deleteMessages).toHaveBeenCalledWith(-1001, [40, 41]); // not the command message (99)
    expect(t.last()).toMatch(/Deleted 2/);
    const audit = await t.repos.audit.recent(10);
    expect(audit.filter((a) => a.action === "msg.delete").map((a) => (a.dryRun ? "preview" : a.result))).toEqual(["ok", "preview"]);
  });

  it("a different user cannot execute someone else's confirmation", async () => {
    const t = await build();
    await t.s.access.grant(MASTER, 2000, ["self", "messaging"]);
    await t.say(2000, ".del 1");
    const token = /confirm (\w+)/.exec(t.last())?.[1] as string;
    await t.say(MASTER, `.confirm ${token}`);
    expect(t.last()).toMatch(/invalid, expired, or belongs to someone else/);
    expect(t.messenger.deleteMessages).not.toHaveBeenCalled();
  });

  it(".send needs the messaging scope and parses the chat reference", async () => {
    const t = await build();
    await t.s.access.grant(MASTER, 2000, ["self"]);
    await t.say(2000, ".send @someone hi there");
    expect(t.messenger.sendText).not.toHaveBeenCalled();
    await t.say(MASTER, ".send @someone hi there  friend");
    expect(t.messenger.sendText).toHaveBeenCalledWith("@someone", "hi there  friend");
    await t.say(MASTER, ".send !!! x");
    expect(t.last()).toMatch(/not a valid chat reference/);
  });

  it("commands that need a chat explain how to pass one on the control bot", async () => {
    const t = await build();
    await t.say(MASTER, "/del 1", { transport: "bot" });
    expect(t.last()).toMatch(/No chat given/);
  });
});

describe("text tools and misc", () => {
  it("transforms text inline and from a replied message", async () => {
    const t = await build();
    await t.say(MASTER, ".t upper,reverse hello");
    expect(t.last()).toBe("OLLEH");
    await t.say(MASTER, ".t snake", { replied: { message: "Hello Big World" } });
    expect(t.last()).toBe("hello_big_world");
    await t.say(MASTER, ".t upper");
    expect(t.last()).toMatch(/Give some text/);
    await t.say(MASTER, ".t nope abc");
    expect(t.last()).toMatch(/Unknown transform/);
  });

  it("translate and AI commands go through their services", async () => {
    const t = await build();
    await t.say(MASTER, ".tr de Good morning");
    expect(t.last()).toBe("translated");
    expect(t.s.translator.translate).toHaveBeenCalledWith("Good morning", "de");
    await t.say(MASTER, ".sum --bullets a long text");
    expect(t.s.ai.summarize).toHaveBeenCalledWith("a long text", "bullets");
  });

  it("group admin commands refuse to act without real Telegram rights, even for the master", async () => {
    const t = await build();
    await t.say(MASTER, ".kick 5");
    expect(t.last()).toMatch(/⚠️/);
    expect((await t.repos.audit.recent(5)).some((a) => a.action === "admin.kick")).toBe(false);
  });

  it("status, features and config reveal no secrets", async () => {
    const t = await build();
    for (const c of [".status", ".features", ".config", ".me", ".audit"]) await t.say(MASTER, c);
    const all = t.replies.join("\n");
    expect(all).toMatch(/Account: Acct/);
    for (const secret of t.s.cfg.secrets) expect(all).not.toContain(secret);
  });

  it("every registered command has a usage line, description and valid scope", async () => {
    const t = await build();
    const scopes = new Set(["self", "automation", "search", "media", "messaging", "chatadmin", "master"]);
    const defs = t.s.registry.list();
    expect(defs.length).toBeGreaterThan(60);
    for (const d of defs) {
      expect(d.usage, d.name).toBeTruthy();
      expect(d.description, d.name).toBeTruthy();
      expect(scopes.has(d.scope), d.name).toBe(true);
    }
  });
});
