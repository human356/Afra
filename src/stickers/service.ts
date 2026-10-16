import fs from "node:fs";
import path from "node:path";
import bigInt from "big-integer";
import { Api } from "teleproto";
import { UsageError } from "../core/errors";
import { classifyMessage, extensionFor, type MediaInfo } from "../media/classify";
import { sanitizeFileName } from "../media/naming";
import type { Messenger } from "../messaging/messenger";

export interface StickerSetInfo {
  title: string;
  shortName: string;
  count: number;
  kind: "stickers" | "emoji" | "masks";
  format: "static" | "animated" | "video" | "mixed";
  official: boolean;
  items: Array<{ alt?: string; mime?: string; size?: number }>;
}

export interface InstalledSet {
  title: string;
  shortName: string;
  count: number;
  kind: "stickers" | "emoji" | "masks";
}

type RawSet = { title: string; shortName: string; count: number; animated?: boolean; videos?: boolean; emojis?: boolean; masks?: boolean; official?: boolean };

const kindOf = (s: RawSet): "stickers" | "emoji" | "masks" => (s.emojis ? "emoji" : s.masks ? "masks" : "stickers");

function infoOfDocument(doc: Api.TypeDocument): MediaInfo | undefined {
  return classifyMessage({ document: doc as Api.Document, photo: undefined } as never);
}

export class StickerService {
  constructor(
    private readonly messenger: Messenger,
    private readonly exportsDir: string,
  ) {}

  /** Sticker/emoji metadata for a message's media (no network). */
  inspect(msg: Pick<Api.Message, "photo" | "document">): MediaInfo | undefined {
    const info = classifyMessage(msg);
    return info?.sticker ? info : undefined;
  }

  async getSet(shortName: string, previewLimit = 12): Promise<StickerSetInfo> {
    const name = shortName.replace(/^.*addstickers\//, "").replace(/^.*addemoji\//, "").trim();
    if (!/^[A-Za-z0-9_]{3,64}$/.test(name)) throw new UsageError("Not a valid sticker set short name", "Use the name from t.me/addstickers/<name>.");
    const res = await this.messenger.call("getStickerSet", () => this.messenger.client.getStickerSet(new Api.InputStickerSetShortName({ shortName: name })), "read");
    if (res.className !== "messages.StickerSet") throw new UsageError("Telegram returned no data for that set");
    const set = res.set as unknown as RawSet;
    const items = res.documents.slice(0, previewLimit).map((d) => {
      const i = infoOfDocument(d);
      return { alt: i?.sticker?.alt, mime: i?.mime, size: i?.size };
    });
    return {
      title: set.title,
      shortName: set.shortName,
      count: set.count,
      kind: kindOf(set),
      format: set.animated ? "animated" : set.videos ? "video" : "static",
      official: Boolean(set.official),
      items,
    };
  }

  async installed(): Promise<InstalledSet[]> {
    const res = await this.messenger.call("getAllStickers", () => this.messenger.client.getAllStickers(), "read");
    if (res.className !== "messages.AllStickers") return [];
    return res.sets.map((s) => ({ title: s.title, shortName: s.shortName, count: s.count, kind: kindOf(s as unknown as RawSet) }));
  }

  /** Resolves custom emoji used in a message's text into their documents. */
  async customEmoji(msg: Pick<Api.Message, "entities">): Promise<Array<{ documentId: string; alt?: string; mime?: string }>> {
    const ids = (msg.entities ?? []).filter((e): e is Api.MessageEntityCustomEmoji => e.className === "MessageEntityCustomEmoji").map((e) => bigInt(String(e.documentId)));
    if (!ids.length) return [];
    const docs = await this.messenger.call("getCustomEmojiDocuments", () => this.messenger.client.getCustomEmojiDocuments(ids.slice(0, 100)), "read");
    return docs.map((d) => {
      const i = infoOfDocument(d);
      return { documentId: String((d as Api.Document).id), alt: i?.sticker?.alt, mime: i?.mime };
    });
  }

  /** Downloads sticker files of a set into <exports>/stickers/<set>/ (explicit, user-requested, paced). */
  async exportSet(shortName: string, limit: number, onProgress?: (done: number, total: number) => void): Promise<{ dir: string; files: number }> {
    const name = shortName.trim();
    if (!/^[A-Za-z0-9_]{3,64}$/.test(name)) throw new UsageError("Not a valid sticker set short name");
    const res = await this.messenger.call("getStickerSet", () => this.messenger.client.getStickerSet(new Api.InputStickerSetShortName({ shortName: name })), "read");
    if (res.className !== "messages.StickerSet") throw new UsageError("Telegram returned no data for that set");
    const dir = path.join(this.exportsDir, "stickers", sanitizeFileName(name));
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const docs = res.documents.slice(0, Math.min(Math.max(limit, 1), 200));
    let n = 0;
    for (const doc of docs) {
      const info = infoOfDocument(doc);
      const ext = info?.ext ?? extensionFor(info?.mime) ?? ".bin";
      const file = path.join(dir, `${String(n + 1).padStart(3, "0")}${ext}`);
      if (!fs.existsSync(file)) {
        await this.messenger.call("downloadSticker", () => this.messenger.client.downloadMedia(new Api.MessageMediaDocument({ document: doc }), file), "download");
      }
      n++;
      onProgress?.(n, docs.length);
    }
    return { dir, files: n };
  }
}
