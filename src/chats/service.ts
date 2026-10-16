import { Api } from "teleproto";
import { UsageError } from "../core/errors";
import { toNum } from "../core/tg";
import type { Messenger, Peer } from "../messaging/messenger";

export interface DialogSummary {
  id?: number;
  title: string;
  type: "user" | "group" | "channel" | "other";
  unread: number;
  archived: boolean;
  pinned: boolean;
}

export interface FolderSummary {
  id: number;
  title: string;
  kind: "custom" | "chatlist";
  chats: number;
}

const FOREVER = 2_147_483_647;

const titleText = (t: unknown): string => (typeof t === "string" ? t : ((t as { text?: string } | undefined)?.text ?? ""));

type InputPeerLike = { className: string; userId?: unknown; chatId?: unknown; channelId?: unknown };
const peerKey = (p: InputPeerLike): string => `${p.className}:${String(p.userId ?? p.chatId ?? p.channelId ?? "")}`;

export class ChatService {
  constructor(private readonly m: Messenger) {}

  async dialogs(limit = 20, archived = false): Promise<DialogSummary[]> {
    const list = await this.m.call("getDialogs", () => this.m.client.getDialogs({ limit: Math.min(limit, 100), archived }), "read");
    return list.map((d) => ({
      id: toNum(d.id),
      title: d.title ?? d.name ?? "(no title)",
      type: d.isUser ? "user" : d.isGroup ? "group" : d.isChannel ? "channel" : "other",
      unread: d.unreadCount ?? 0,
      archived: Boolean(d.archived),
      pinned: Boolean(d.pinned),
    }));
  }

  /** Mutes for `seconds` (or forever when undefined). Pass 0 via unmute(). */
  async mute(peer: Peer, seconds?: number): Promise<void> {
    const until = seconds === undefined ? FOREVER : Math.min(FOREVER, Math.floor(Date.now() / 1000) + seconds);
    await this.m.call("updateNotifySettings", () => this.m.client.updateNotifySettings(peer, { muteUntil: until }));
  }
  async unmute(peer: Peer): Promise<void> {
    await this.m.call("updateNotifySettings", () => this.m.client.updateNotifySettings(peer, { muteUntil: 0 }));
  }

  async archive(peer: Peer): Promise<void> {
    await this.m.call("editPeerFolders", () => this.m.client.editPeerFolders(peer, 1));
  }
  async unarchive(peer: Peer): Promise<void> {
    await this.m.call("editPeerFolders", () => this.m.client.editPeerFolders(peer, 0));
  }

  async folders(): Promise<FolderSummary[]> {
    const res = await this.m.call("getDialogFilters", () => this.m.client.getDialogFilters(), "read");
    const out: FolderSummary[] = [];
    for (const f of res.filters) {
      if (f.className === "DialogFilter") out.push({ id: f.id, title: titleText(f.title), kind: "custom", chats: f.includePeers.length + f.pinnedPeers.length });
      else if (f.className === "DialogFilterChatlist") out.push({ id: f.id, title: titleText(f.title), kind: "chatlist", chats: f.includePeers.length });
    }
    return out;
  }

  /** Adds (or removes) a chat to a plain custom folder. Chatlist (shared) folders are never modified. */
  async editFolder(folderId: number, peer: Peer, mode: "add" | "remove"): Promise<string> {
    const res = await this.m.call("getDialogFilters", () => this.m.client.getDialogFilters(), "read");
    const f = res.filters.find((x) => x.className === "DialogFilter" && x.id === folderId);
    if (!f || f.className !== "DialogFilter") throw new UsageError(`No editable custom folder with id ${folderId}`, "List folders first; shared (chatlist) folders can't be edited here.");
    const input = (await this.m.client.getInputEntity(peer)) as unknown as InputPeerLike;
    const key = peerKey(input);
    const has = (arr: InputPeerLike[]): boolean => arr.some((p) => peerKey(p) === key);
    const include = f.includePeers as unknown as InputPeerLike[];
    const pinned = f.pinnedPeers as unknown as InputPeerLike[];
    const exclude = f.excludePeers as unknown as InputPeerLike[];
    if (mode === "add" && has(include)) return "Already in that folder.";
    if (mode === "remove" && !has(include) && !has(pinned)) return "That chat is not in the folder.";
    const next = new Api.DialogFilter({
      ...f,
      includePeers: (mode === "add" ? [...include, input] : include.filter((p) => peerKey(p) !== key)) as unknown as Api.TypeInputPeer[],
      pinnedPeers: (mode === "add" ? pinned : pinned.filter((p) => peerKey(p) !== key)) as unknown as Api.TypeInputPeer[],
      excludePeers: (mode === "add" ? exclude.filter((p) => peerKey(p) !== key) : exclude) as unknown as Api.TypeInputPeer[],
    });
    await this.m.call("updateDialogFilter", () => this.m.client.updateDialogFilter(folderId, next));
    return mode === "add" ? "Added to the folder." : "Removed from the folder.";
  }
}
