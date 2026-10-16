import { Api } from "teleproto";
import { PermissionError, UsageError } from "../core/errors";
import { toNum } from "../core/tg";
import type { Messenger, Peer } from "../messaging/messenger";

export interface Rights {
  chatType: "channel" | "group" | "private";
  isCreator: boolean;
  isAdmin: boolean;
  deleteMessages: boolean;
  banUsers: boolean;
  inviteUsers: boolean;
  pinMessages: boolean;
  changeInfo: boolean;
}

const NONE = { isCreator: false, isAdmin: false, deleteMessages: false, banUsers: false, inviteUsers: false, pinMessages: false, changeInfo: false };

export interface ParticipantSummary {
  id?: number;
  name: string;
  username?: string;
  role: "creator" | "admin" | "member" | "banned" | "left" | "unknown";
  rank?: string;
}

export class AdminService {
  constructor(private readonly m: Messenger) {}

  /**
   * Actual rights of THIS account in the chat. The library has no getPermissions helper, so rights come from
   * GetParticipant (channels/supergroups) or GetFullChat (basic groups).
   */
  async myRights(peer: Peer): Promise<Rights> {
    const entity = await this.m.call("getEntity", () => this.m.client.getEntity(peer), "read");
    const cls = (entity as { className?: string }).className;

    if (cls === "Channel") {
      const res = await this.m.call("getParticipant", () => this.m.client.getParticipant(entity, "me"), "read");
      const p = res.participant;
      if (p.className === "ChannelParticipantCreator") return { chatType: "channel", ...NONE, isCreator: true, isAdmin: true, deleteMessages: true, banUsers: true, inviteUsers: true, pinMessages: true, changeInfo: true };
      if (p.className === "ChannelParticipantAdmin") {
        const r = p.adminRights;
        return { chatType: "channel", ...NONE, isAdmin: true, deleteMessages: Boolean(r.deleteMessages), banUsers: Boolean(r.banUsers), inviteUsers: Boolean(r.inviteUsers), pinMessages: Boolean(r.pinMessages), changeInfo: Boolean(r.changeInfo) };
      }
      return { chatType: "channel", ...NONE };
    }

    if (cls === "Chat") {
      const chatId = (entity as unknown as { id: never }).id;
      const full = await this.m.call("getFullChat", () => this.m.client.invoke(new Api.messages.GetFullChat({ chatId })), "read");
      const me = (await this.m.client.getMe()) as Api.User;
      const participants = (full.fullChat as unknown as { participants?: { participants?: Array<{ className: string; userId: unknown }> } }).participants?.participants ?? [];
      const mine = participants.find((p) => String(p.userId) === String(me.id));
      if (mine?.className === "ChatParticipantCreator") return { chatType: "group", ...NONE, isCreator: true, isAdmin: true, deleteMessages: true, banUsers: true, inviteUsers: true, pinMessages: true, changeInfo: true };
      if (mine?.className === "ChatParticipantAdmin") return { chatType: "group", ...NONE, isAdmin: true, deleteMessages: true, banUsers: true, inviteUsers: true, pinMessages: true, changeInfo: true };
      return { chatType: "group", ...NONE };
    }

    // Private chat: the account can delete messages in its own conversation, but cannot ban anyone.
    return { chatType: "private", ...NONE, deleteMessages: true };
  }

  async requireRight(peer: Peer, right: "deleteMessages" | "banUsers"): Promise<Rights> {
    const r = await this.myRights(peer);
    if (!r[right]) throw new PermissionError(`This account does not have the "${right}" admin right in that chat`, "Moderation only works where Telegram itself grants the account that right.");
    return r;
  }

  async participants(peer: Peer, opts: { limit?: number; adminsOnly?: boolean; search?: string } = {}): Promise<ParticipantSummary[]> {
    const filter = opts.adminsOnly ? new Api.ChannelParticipantsAdmins() : undefined;
    const list = await this.m.call("getParticipants", () => this.m.client.getParticipants(peer, { limit: Math.min(opts.limit ?? 30, 200), filter, search: opts.search }), "read");
    return list.map((u) => {
      const p = (u as unknown as { participant?: { className?: string; rank?: string } }).participant;
      const role: ParticipantSummary["role"] =
        p?.className?.includes("Creator") ? "creator" : p?.className?.includes("Admin") ? "admin" : p?.className?.includes("Banned") ? "banned" : p?.className?.includes("Left") ? "left" : p ? "member" : "unknown";
      return { id: toNum(u.id), name: [u.firstName, u.lastName].filter(Boolean).join(" ") || "(unnamed)", username: u.username ?? undefined, role, rank: p?.rank };
    });
  }

  /** Removes the user from the chat (they can rejoin if allowed). */
  async kick(peer: Peer, user: Peer): Promise<void> {
    await this.requireRight(peer, "banUsers");
    await this.m.call("kickParticipant", () => this.m.client.kickParticipant(peer, user), "moderation");
  }

  /** Bans permanently. Telegram only supports bans in supergroups/channels; basic groups can only remove. */
  async ban(peer: Peer, user: Peer): Promise<"banned" | "removed"> {
    const rights = await this.requireRight(peer, "banUsers");
    if (rights.chatType === "group") {
      await this.m.call("kickParticipant", () => this.m.client.kickParticipant(peer, user), "moderation");
      return "removed";
    }
    await this.m.call("editBanned", () => this.m.client.editBanned(peer, user, { viewMessages: true, untilDate: 0 }), "moderation");
    return "banned";
  }

  async unban(peer: Peer, user: Peer): Promise<void> {
    const rights = await this.requireRight(peer, "banUsers");
    if (rights.chatType === "group") throw new UsageError("Basic groups have no ban list; re-invite the user instead");
    await this.m.call("editBanned", () => this.m.client.editBanned(peer, user, { untilDate: 0 }), "moderation");
  }

  /** Finds message ids to purge (newest first). Does not delete anything. */
  async findPurgeTargets(peer: Peer, count: number, fromUser?: Peer): Promise<number[]> {
    const n = Math.min(Math.max(count, 1), 500);
    const msgs = await this.m.history(peer, { limit: n, fromUser });
    return msgs.map((x) => x.id);
  }

  async purge(peer: Peer, ids: number[]): Promise<number> {
    await this.requireRight(peer, "deleteMessages");
    return this.m.deleteMessages(peer, ids, true);
  }

  async adminLog(peer: Peer, limit = 15): Promise<Array<{ id: string; date: number; userId?: number; action: string }>> {
    const events = await this.m.call("getAdminLog", () => this.m.client.getAdminLog(peer, { limit: Math.min(limit, 50) }), "read");
    return events.map((e) => ({ id: String(e.id), date: e.date * 1000, userId: toNum(e.userId), action: e.action.className.replace(/^ChannelAdminLogEventAction/, "") }));
  }
}
