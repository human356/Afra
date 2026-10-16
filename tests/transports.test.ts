import { describe, expect, it, vi } from "vitest";
import { AccessControl } from "../src/auth/access";
import { ConfirmationManager } from "../src/commands/confirmations";
import { CommandDispatcher } from "../src/commands/dispatcher";
import { CommandRegistry } from "../src/commands/registry";
import { Metrics } from "../src/core/metrics";
import { BoundedQueue } from "../src/core/queue";
import type { Services } from "../src/core/services";
import { attachBotTransport, attachUserbotTransport, chatTypeOf } from "../src/runtime/transports";
import { memDb, silent, testConfig } from "./helpers";

type Handler = (event: unknown) => Promise<void>;
const MASTER = 1000;

async function build() {
  const { repos } = await memDb();
  const cfg = testConfig();
  const metrics = new Metrics();
  const queue = new BoundedQueue(4, 50);
  const access = new AccessControl(MASTER, repos.users, repos.audit, 0);
  const registry = new CommandRegistry();
  registry.register({ name: "ping", group: "t", scope: "self", usage: "ping", description: "", run: async (c) => c.reply("🏓 pong") });
  const dispatcher = new CommandDispatcher({ cfg, logger: silent, registry, access, confirmations: new ConfirmationManager(60), audit: repos.audit, metrics, queue });
  let userHandler: Handler = async () => undefined;
  let botHandler: Handler = async () => undefined;
  const messenger = { edit: vi.fn(async () => ({})), sendText: vi.fn(async () => [{ id: 500 }]) };
  const botMessenger = { edit: vi.fn(async () => ({})), sendText: vi.fn(async () => [{ id: 600 }]) };
  const rules = { mightApply: vi.fn(async () => false), handle: vi.fn(async () => 0) };
  const plugins = { dispatchMessage: vi.fn(async () => undefined) };
  const search = { archivingAvailable: false, maybeArchive: vi.fn(async () => false) };
  const s = {
    cfg, logger: silent, metrics, queue, access, dispatcher, messenger, botMessenger, rules, plugins, search, repos,
    client: { addEventHandler: (h: Handler) => void (userHandler = h) },
    bot: { client: { addEventHandler: (h: Handler) => void (botHandler = h) }, account: { id: 9, name: "bot", username: "mybot" } },
  } as unknown as Services;
  attachUserbotTransport(s);
  attachBotTransport(s);
  const msg = (o: { text: string; out?: boolean; sender: number; chat?: number; peer?: string; id?: number }) => ({
    message: { message: o.text, out: o.out ?? false, id: o.id ?? 5, senderId: o.sender, chatId: o.chat ?? -1001, peerId: { className: o.peer ?? "PeerChannel" }, post: false, isReply: false, replyToMsgId: undefined, getSender: async () => ({ className: "User", bot: false }), getReplyMessage: async () => undefined },
    chatId: o.chat ?? -1001,
  });
  const idle = async () => { await queue.drain(500); await new Promise((r) => setTimeout(r, 5)); };
  return { s, messenger, botMessenger, rules, plugins, search, repos, metrics, msg, user: (e: unknown) => userHandler(e), bot: (e: unknown) => botHandler(e), idle, access };
}

describe("userbot transport", () => {
  it("replaces the master's own command message with the result (edit in place)", async () => {
    const t = await build();
    await t.user(t.msg({ text: ".ping", out: true, sender: MASTER }));
    expect(t.messenger.edit).toHaveBeenCalledWith(-1001, 5, "🏓 pong");
    expect(t.messenger.sendText).not.toHaveBeenCalled();
  });

  it("answers an authorised user's command as a reply, and never answers strangers", async () => {
    const t = await build();
    await t.user(t.msg({ text: ".ping", sender: 4242 }));
    expect(t.messenger.sendText).not.toHaveBeenCalled();
    expect(t.messenger.edit).not.toHaveBeenCalled();
    await t.access.grant(MASTER, 4242, ["self"]);
    await t.user(t.msg({ text: ".ping", sender: 4242, id: 8 }));
    expect(t.messenger.sendText).toHaveBeenCalledWith(-1001, "🏓 pong", { replyTo: 8 });
  });

  it("a stranger who impersonates the prefix in a group gets no reaction, but the message is still processed passively", async () => {
    const t = await build();
    await t.user(t.msg({ text: ".ping", sender: 31337 }));
    await t.idle();
    expect(t.messenger.sendText).not.toHaveBeenCalled();
    expect(t.plugins.dispatchMessage).toHaveBeenCalledTimes(1);
  });

  it("ordinary messages feed plugins and (only if a rule could apply) the rule engine; own messages never reach rules", async () => {
    const t = await build();
    await t.user(t.msg({ text: "hello", sender: 77 }));
    await t.idle();
    expect(t.rules.mightApply).toHaveBeenCalledWith(-1001);
    expect(t.rules.handle).not.toHaveBeenCalled(); // no rule covers this chat
    t.rules.mightApply.mockResolvedValue(true);
    await t.user(t.msg({ text: "hello", sender: 77, id: 6 }));
    await t.idle();
    expect(t.rules.handle).toHaveBeenCalledWith(expect.objectContaining({ text: "hello", chatId: -1001, chatType: "group", isBot: false, messageId: 6 }), -1001);
    t.rules.handle.mockClear();
    await t.user(t.msg({ text: "my own words", out: true, sender: MASTER, id: 7 }));
    await t.idle();
    expect(t.rules.handle).not.toHaveBeenCalled();
    expect(t.plugins.dispatchMessage).toHaveBeenLastCalledWith(expect.objectContaining({ isOut: true }));
  });

  it("archiving is only attempted when the feature is enabled", async () => {
    const t = await build();
    await t.user(t.msg({ text: "x", sender: 1 }));
    await t.idle();
    expect(t.search.maybeArchive).not.toHaveBeenCalled();
    (t.s.search as { archivingAvailable: boolean }).archivingAvailable = true;
    await t.user(t.msg({ text: "y", sender: 1 }));
    await t.idle();
    expect(t.search.maybeArchive).toHaveBeenCalledTimes(1);
  });

  it("counts events and survives handler errors", async () => {
    const t = await build();
    t.plugins.dispatchMessage.mockRejectedValue(new Error("boom"));
    await expect(t.user(t.msg({ text: "hi", sender: 1 }))).resolves.toBeUndefined();
    expect(t.metrics.get("events.messages")).toBe(1);
  });

  it("classifies chat types from the peer", () => {
    expect(chatTypeOf({ peerId: { className: "PeerUser" } as never, post: false })).toBe("private");
    expect(chatTypeOf({ peerId: { className: "PeerChat" } as never, post: false })).toBe("group");
    expect(chatTypeOf({ peerId: { className: "PeerChannel" } as never, post: true })).toBe("channel");
    expect(chatTypeOf({ peerId: { className: "PeerChannel" } as never, post: false })).toBe("group");
  });
});

describe("control bot transport", () => {
  it("answers the master in a private chat with the bot's own messenger", async () => {
    const t = await build();
    await t.bot(t.msg({ text: "/ping", sender: MASTER, chat: MASTER, peer: "PeerUser" }));
    expect(t.botMessenger.sendText).toHaveBeenCalledWith(MASTER, "🏓 pong", { replyTo: 5 });
    expect(t.messenger.sendText).not.toHaveBeenCalled();
  });

  it("ignores groups and tells strangers the bot is private", async () => {
    const t = await build();
    await t.bot(t.msg({ text: "/ping", sender: MASTER, peer: "PeerChat" }));
    expect(t.botMessenger.sendText).not.toHaveBeenCalled();
    await t.bot(t.msg({ text: "/ping", sender: 5555, chat: 5555, peer: "PeerUser" }));
    expect(t.botMessenger.sendText).toHaveBeenCalledWith(5555, expect.stringMatching(/private/), expect.anything());
  });
});
