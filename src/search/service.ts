import fs from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import type { Api } from "teleproto";
import type { AppConfig } from "../config";
import { UsageError } from "../core/errors";
import { summarizeMessage, toNum, type MessageSummary } from "../core/tg";
import { sanitizeFileName } from "../media/naming";
import type { Messenger, Peer } from "../messaging/messenger";
import type { ArchivedMessage, ArchiveRepo, SettingsRepo } from "../storage/repositories";

const ARCHIVE_KEY = "archive.chats";

export class SearchService {
  private archiveChats: Set<number> | undefined;
  private archiveLoadedAt = 0;

  constructor(
    private readonly d: { messenger: Messenger; archive: ArchiveRepo; settings: SettingsRepo; cfg: AppConfig; logger: Logger },
  ) {}

  /** Telegram-side search in one chat. Nothing is stored. */
  async live(peer: Peer, query: string, opts: { limit?: number; fromUser?: Peer } = {}): Promise<MessageSummary[]> {
    if (!query.trim()) throw new UsageError("Empty search query");
    const msgs = await this.d.messenger.history(peer, { limit: opts.limit ?? 10, search: query, fromUser: opts.fromUser });
    return msgs.map((m) => summarizeMessage(m));
  }

  /* ------------------------- opt-in local archive ------------------------- */
  get archivingAvailable(): boolean {
    return this.d.cfg.privacy.storeMessageContent;
  }

  private async chats(): Promise<Set<number>> {
    if (!this.archiveChats || Date.now() - this.archiveLoadedAt > 10_000) {
      this.archiveChats = new Set(await this.d.settings.getJson<number[]>(ARCHIVE_KEY, []));
      this.archiveLoadedAt = Date.now();
    }
    return this.archiveChats;
  }

  async setArchiving(chatId: number, on: boolean): Promise<void> {
    if (!this.archivingAvailable) throw new UsageError("Message storage is disabled", "Set STORE_MESSAGE_CONTENT=true in .env to allow archiving (it stays off per chat until enabled).");
    const set = await this.chats();
    if (on) set.add(chatId);
    else set.delete(chatId);
    await this.d.settings.setJson(ARCHIVE_KEY, [...set]);
    if (!on) await this.d.archive.deleteChat(chatId);
  }

  async archivedChats(): Promise<number[]> {
    return [...(await this.chats())];
  }

  /** Called for every message seen. Stores text only when BOTH the global flag and the chat opt-in are on. */
  async maybeArchive(chatId: number | undefined, msg: Pick<Api.Message, "id" | "message" | "date" | "senderId" | "media">): Promise<boolean> {
    if (!this.archivingAvailable || chatId === undefined) return false;
    if (!(await this.chats()).has(chatId)) return false;
    const rec: ArchivedMessage = { chatId, messageId: msg.id, senderId: toNum(msg.senderId), sentAt: (msg.date ?? 0) * 1000, text: msg.message ?? undefined, hasMedia: Boolean(msg.media) };
    await this.d.archive.upsert(rec);
    return true;
  }

  searchArchive(query: string, opts: { chatId?: number; limit?: number } = {}): Promise<ArchivedMessage[]> {
    return this.d.archive.search(query, opts);
  }

  /* ------------------------- export ------------------------- */
  /** Exports history to JSONL under DATA_DIR/exports (paced, in batches of 100). */
  async exportHistory(peer: Peer, label: string, opts: { limit: number; includeText: boolean; onProgress?: (n: number) => void }): Promise<{ file: string; count: number }> {
    const limit = Math.min(Math.max(opts.limit, 1), 100_000);
    fs.mkdirSync(this.d.cfg.paths.exportsDir, { recursive: true, mode: 0o700 });
    const file = path.join(this.d.cfg.paths.exportsDir, `${sanitizeFileName(label)}-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
    const fd = fs.openSync(file, "w", 0o600);
    let count = 0;
    let offsetId = 0;
    try {
      while (count < limit) {
        const batch = await this.d.messenger.history(peer, { limit: Math.min(100, limit - count), offsetId });
        if (batch.length === 0) break;
        for (const m of batch) {
          const row: Record<string, unknown> = { id: m.id, date: new Date((m.date ?? 0) * 1000).toISOString(), senderId: toNum(m.senderId), replyTo: m.replyTo ? ((m.replyTo as { replyToMsgId?: number }).replyToMsgId ?? null) : null, media: m.media ? m.media.className : null };
          if (opts.includeText) row["text"] = m.message ?? "";
          fs.writeSync(fd, `${JSON.stringify(row)}\n`);
        }
        count += batch.length;
        offsetId = (batch[batch.length - 1] as Api.Message).id;
        opts.onProgress?.(count);
      }
    } finally {
      fs.closeSync(fd);
    }
    this.d.logger.info({ module: "search", count, file: path.basename(file) }, "history exported");
    return { file, count };
  }
}
