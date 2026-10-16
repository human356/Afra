import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminService } from "../src/admin/service";
import { FEATURES, hasRequirement, probeFeatures, renderMatrixMarkdown, type LibLike } from "../src/core/features";
import { libInfo } from "../src/core/library";
import { Metrics } from "../src/core/metrics";
import { Pacer } from "../src/core/queue";
import { Messenger } from "../src/messaging/messenger";
import { silent, testConfig } from "./helpers";

afterEach(() => vi.useRealTimers());

function makeMessenger(client: Record<string, unknown>, env: Record<string, string> = {}) {
  const metrics = new Metrics();
  return { metrics, m: new Messenger({ client: client as never, cfg: testConfig(env), logger: silent, metrics, pacer: new Pacer(0) }) };
}

describe("messenger", () => {
  it("sends plain text (no markup parsing, no link previews) and chunks long messages", async () => {
    const sendMessage = vi.fn(async (_p: unknown, o: { message: string; parseMode?: unknown; linkPreview?: unknown; replyTo?: number }) => ({ id: o.message.length }));
    const { m } = makeMessenger({ sendMessage });
    await m.sendText("me", "x".repeat(9000), { replyTo: 5 });
    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(sendMessage.mock.calls.every(([, o]) => o.parseMode === false && o.linkPreview === false)).toBe(true);
    expect(sendMessage.mock.calls[0]?.[1].replyTo).toBe(5);
    expect(sendMessage.mock.calls[1]?.[1].replyTo).toBeUndefined();
    await expect(m.sendText("me", "   ")).rejects.toThrow(/empty/);
  });

  it("honours FloodWait: waits at least the requested time before retrying", async () => {
    vi.useFakeTimers();
    const flood = Object.assign(new Error("flood"), { name: "FloodWaitError", seconds: 3 });
    const sendMessage = vi.fn().mockRejectedValueOnce(flood).mockResolvedValue({ id: 1 });
    const { m, metrics } = makeMessenger({ sendMessage });
    let done = false;
    const p = m.sendText("me", "hello").then(() => (done = true));
    await vi.advanceTimersByTimeAsync(2900);
    expect(done).toBe(false);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1700); // wait is (3+1)s plus up to 0.5s jitter
    await p;
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(metrics.get("telegram.floodwait")).toBe(1);
  });

  it("does not retry non-transient errors", async () => {
    const sendMessage = vi.fn().mockRejectedValue(Object.assign(new Error("x"), { errorMessage: "CHAT_WRITE_FORBIDDEN" }));
    const { m } = makeMessenger({ sendMessage });
    await expect(m.sendText("me", "hello")).rejects.toThrow();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("converts schedule dates to unix seconds and limits albums to 10 files", async () => {
    const sendMessage = vi.fn(async () => ({ id: 1 }));
    const sendFile = vi.fn(async () => ({ id: 2 }));
    const { m } = makeMessenger({ sendMessage, sendFile });
    await m.sendText("me", "later", { schedule: new Date("2026-12-31T00:00:00Z") });
    expect((sendMessage.mock.calls[0] as unknown as [unknown, { schedule: number }])[1].schedule).toBe(Date.parse("2026-12-31T00:00:00Z") / 1000);
    await expect(m.sendFiles("me", Array.from({ length: 11 }, (_, i) => `f${i}`))).rejects.toThrow(/at most 10/);
    await m.sendFiles("me", ["a.jpg", "b.jpg"], { caption: "c", voice: false });
    expect((sendFile.mock.calls[0] as unknown as [unknown, { file: string[] }])[1].file).toEqual(["a.jpg", "b.jpg"]);
  });

  it("deletes in batches of 100", async () => {
    const deleteMessages = vi.fn(async (_p: unknown, ids: number[]) => [{ ptsCount: ids.length }]);
    const { m } = makeMessenger({ deleteMessages });
    expect(await m.deleteMessages("me", Array.from({ length: 250 }, (_, i) => i + 1))).toBe(250);
    expect(deleteMessages).toHaveBeenCalledTimes(3);
  });
});

describe("admin service", () => {
  const rights = (r: Partial<Record<string, boolean>>) => ({ className: "ChannelParticipantAdmin", adminRights: r });
  function setup(entity: unknown, participant: unknown) {
    const client = {
      getEntity: vi.fn(async () => entity),
      getParticipant: vi.fn(async () => ({ participant })),
      getMe: vi.fn(async () => ({ id: 77 })),
      invoke: vi.fn(async () => ({ fullChat: { participants: { participants: [participant] } } })),
      editBanned: vi.fn(async () => undefined),
      kickParticipant: vi.fn(async () => undefined),
    };
    const m = { client, call: async (_l: string, fn: () => Promise<unknown>) => fn(), history: vi.fn(async () => []), deleteMessages: vi.fn(async () => 3) };
    return { client, m, admin: new AdminService(m as never) };
  }

  it("refuses moderation when Telegram has not granted the right", async () => {
    const t = setup({ className: "Channel" }, { className: "ChannelParticipant" });
    await expect(t.admin.ban("@g", 5)).rejects.toThrow(/banUsers/);
    expect(t.client.editBanned).not.toHaveBeenCalled();
    const noDelete = setup({ className: "Channel" }, rights({ banUsers: true, deleteMessages: false }));
    await expect(noDelete.admin.purge("@g", [1, 2])).rejects.toThrow(/deleteMessages/);
    expect(noDelete.m.deleteMessages).not.toHaveBeenCalled();
  });

  it("bans with viewMessages=true (forever) and unbans by clearing all restrictions", async () => {
    const t = setup({ className: "Channel" }, rights({ banUsers: true }));
    expect(await t.admin.ban("@g", 5)).toBe("banned");
    expect(t.client.editBanned).toHaveBeenCalledWith("@g", 5, { viewMessages: true, untilDate: 0 });
    await t.admin.unban("@g", 5);
    expect(t.client.editBanned).toHaveBeenLastCalledWith("@g", 5, { untilDate: 0 });
  });

  it("creators have every right; basic-group bans degrade to removal; unban is unsupported there", async () => {
    const creator = setup({ className: "Channel" }, { className: "ChannelParticipantCreator" });
    expect((await creator.admin.myRights("@g")).deleteMessages).toBe(true);
    const group = setup({ className: "Chat", id: 5 }, { className: "ChatParticipantAdmin", userId: 77 });
    expect(await group.admin.ban(5, 9)).toBe("removed");
    expect(group.client.kickParticipant).toHaveBeenCalled();
    expect(group.client.editBanned).not.toHaveBeenCalled();
    await expect(group.admin.unban(5, 9)).rejects.toThrow(/Basic groups/);
  });

  it("private chats: can delete, cannot ban", async () => {
    const t = setup({ className: "User" }, undefined);
    const r = await t.admin.myRights(5);
    expect(r).toMatchObject({ chatType: "private", deleteMessages: true, banUsers: false });
    await expect(t.admin.kick(5, 9)).rejects.toThrow(/banUsers/);
  });
});

describe("feature probe", () => {
  it("every feature resolves against the installed library; nothing is unavailable", () => {
    const r = probeFeatures(libInfo());
    expect(r.summary.unavailable).toBe(0);
    const supportedMissing = r.features.filter((f) => f.status === "supported" && f.missing.length);
    expect(supportedMissing).toEqual([]);
    expect(r.library.version).not.toBe("unknown");
    expect(r.features.length).toBe(FEATURES.length);
  });

  it("downgrades features when symbols are missing", () => {
    const lib = libInfo();
    const stripped: LibLike = { ...lib, TelegramClient: { prototype: {} }, events: {}, utils: {} };
    const r = probeFeatures(stripped);
    expect(r.features.find((f) => f.id === "msg.text")?.status).toBe("unavailable");
    expect(r.features.find((f) => f.id === "media.classify")?.status).toBe("supported"); // needs nothing from the library
    const partial: LibLike = { ...lib, TelegramClient: { prototype: { sendMessage() {} } } };
    expect(probeFeatures(partial).features.find((f) => f.id === "msg.scheduled")?.status).toBe("partial");
  });

  it("documented caps stay partial even when all symbols exist", () => {
    const r = probeFeatures(libInfo());
    for (const id of ["msg.events", "media.resume", "ids.botfileid", "admin.permissions"]) expect(r.features.find((f) => f.id === id)?.status).toBe("partial");
  });

  it("checks nested Api symbols and rejects unknown ones", () => {
    const lib = libInfo();
    expect(hasRequirement(lib, "api:messages.GetStickerSet")).toBe(true);
    expect(hasRequirement(lib, "api:messages.TotallyMadeUp")).toBe(false);
    expect(hasRequirement(lib, "client:invented")).toBe(false);
  });

  it("renders a markdown matrix with the library version and the 'not implemented' list", () => {
    const md = renderMatrixMarkdown(probeFeatures(libInfo()));
    expect(md).toContain("teleproto@");
    expect(md).toContain("Deliberately not implemented");
    expect(md).toContain("Rate-limit evasion");
  });
});
