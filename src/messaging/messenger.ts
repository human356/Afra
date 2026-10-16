import type { Logger } from "pino";
import { Api, type TelegramClient } from "teleproto";
import type { AppConfig } from "../config";
import { UsageError } from "../core/errors";
import type { Metrics } from "../core/metrics";
import { Pacer } from "../core/queue";
import { floodWaitSeconds, withRetry } from "../core/retry";
import { chunkText, toNum } from "../core/tg";

export interface MessengerDeps {
  client: TelegramClient;
  cfg: AppConfig;
  logger: Logger;
  metrics: Metrics;
  pacer: Pacer;
}

export type Peer = string | number;

/** Telegram wants scheduled times as unix seconds (the library passes the number through unchanged). */
const toUnix = (d?: Date): number | undefined => (d ? Math.floor(d.getTime() / 1000) : undefined);

export interface SendOptions {
  replyTo?: number;
  schedule?: Date;
  silent?: boolean;
}

export interface DraftInfo {
  peer: string;
  text: string;
  date: number;
}

/**
 * All outgoing Telegram calls go through here: paced (minimum spacing), retried on transient errors with
 * exponential backoff, and FloodWait is honoured exactly. Text is always sent as plain text (no markup parsing),
 * so user-provided content can never inject formatting or links.
 */
export class Messenger {
  constructor(private readonly d: MessengerDeps) {}

  get client(): TelegramClient {
    return this.d.client;
  }

  /** Runs one Telegram operation with pacing + retry. */
  async call<T>(label: string, fn: () => Promise<T>, paceKey = "send"): Promise<T> {
    await this.d.pacer.wait(paceKey);
    return withRetry(() => fn(), {
      retries: this.d.cfg.limits.retryAttempts,
      maxFloodWaitSec: this.d.cfg.limits.floodWaitMaxSec,
      onRetry: ({ attempt, delayMs, reason, error }) => {
        if (reason === "flood") this.d.metrics.inc("telegram.floodwait");
        this.d.metrics.inc("telegram.retries");
        this.d.logger.warn({ module: "messenger", op: label, attempt, delayMs, reason, floodWait: floodWaitSeconds(error) }, "retrying after Telegram error");
      },
    });
  }

  async sendText(peer: Peer, text: string, opts: SendOptions = {}): Promise<Api.Message[]> {
    if (!text.trim()) throw new UsageError("Nothing to send: the message is empty");
    const sent: Api.Message[] = [];
    let replyTo = opts.replyTo;
    for (const part of chunkText(text)) {
      const m = await this.call("sendMessage", () =>
        this.d.client.sendMessage(peer, { message: part, parseMode: false, linkPreview: false, replyTo, schedule: toUnix(opts.schedule), silent: opts.silent }),
      );
      sent.push(m);
      replyTo = undefined;
      this.d.metrics.inc("messages.sent");
    }
    return sent;
  }

  async sendSaved(text: string): Promise<Api.Message[]> {
    return this.sendText("me", text);
  }

  async sendFiles(peer: Peer, files: string[], opts: SendOptions & { caption?: string; voice?: boolean; videoNote?: boolean; forceDocument?: boolean; onProgress?: (fraction: number) => void } = {}): Promise<Api.Message[]> {
    if (files.length === 0) throw new UsageError("No files to send");
    if (files.length > 10) throw new UsageError("Albums hold at most 10 files");
    const result = await this.call("sendFile", () =>
      this.d.client.sendFile(peer, {
        file: files.length === 1 ? (files[0] as string) : files,
        caption: opts.caption,
        parseMode: false,
        voiceNote: opts.voice,
        videoNote: opts.videoNote,
        forceDocument: opts.forceDocument,
        replyTo: opts.replyTo,
        scheduleDate: toUnix(opts.schedule),
        silent: opts.silent,
        progressCallback: opts.onProgress,
      }),
    );
    this.d.metrics.inc("messages.sent", files.length);
    return Array.isArray(result) ? result : [result];
  }

  async edit(peer: Peer, messageId: number, text: string): Promise<Api.Message> {
    return this.call("editMessage", () => this.d.client.editMessage(peer, { message: messageId, text, parseMode: false, linkPreview: false }));
  }

  async deleteMessages(peer: Peer, ids: number[], revoke = true): Promise<number> {
    let count = 0;
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100);
      const res = await this.call("deleteMessages", () => this.d.client.deleteMessages(peer, batch, { revoke }), "delete");
      count += res.reduce((n, r) => n + (r.ptsCount ?? 0), 0) || batch.length;
    }
    return count;
  }

  async forward(to: Peer, from: Peer, ids: number[]): Promise<number> {
    const res = await this.call("forwardMessages", () => this.d.client.forwardMessages(to, { messages: ids, fromPeer: from }));
    this.d.metrics.inc("messages.sent", ids.length);
    return res.length;
  }

  async history(peer: Peer, opts: { limit?: number; offsetId?: number; search?: string; fromUser?: Peer } = {}): Promise<Api.Message[]> {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 1000);
    await this.d.pacer.wait("read");
    return withRetry(
      () => this.d.client.getMessages(peer, { limit, offsetId: opts.offsetId ?? 0, search: opts.search, fromUser: opts.fromUser }).then((l) => [...l]),
      { retries: this.d.cfg.limits.retryAttempts, maxFloodWaitSec: this.d.cfg.limits.floodWaitMaxSec },
    );
  }

  async getById(peer: Peer, id: number): Promise<Api.Message | undefined> {
    const res = await this.call("getMessages", () => this.d.client.getMessages(peer, { ids: id }), "read");
    return res[0] ?? undefined;
  }

  /* ---------------- drafts ---------------- */
  async saveDraft(peer: Peer, text: string, replyTo?: number): Promise<void> {
    await this.call("saveDraft", () => this.d.client.saveDraft(peer, { message: text, parseMode: false, replyTo }));
  }
  async clearDraft(peer: Peer): Promise<void> {
    await this.call("clearDraft", () => this.d.client.clearDraft(peer));
  }
  async listDrafts(): Promise<DraftInfo[]> {
    const res = await this.call("getAllDrafts", () => this.d.client.invoke(new Api.messages.GetAllDrafts()), "read");
    const updates = (res as unknown as { updates?: unknown[] }).updates ?? [];
    const out: DraftInfo[] = [];
    for (const u of updates) {
      const upd = u as { className?: string; peer?: { className?: string; userId?: unknown; chatId?: unknown; channelId?: unknown }; draft?: { className?: string; message?: string; date?: number } };
      if (upd.className !== "UpdateDraftMessage" || upd.draft?.className !== "DraftMessage" || !upd.draft.message) continue;
      const p = upd.peer ?? {};
      const id = toNum(p.userId ?? p.chatId ?? p.channelId);
      out.push({ peer: `${(p.className ?? "Peer").replace(/^Peer/, "").toLowerCase()}:${id ?? "?"}`, text: upd.draft.message, date: (upd.draft.date ?? 0) * 1000 });
    }
    return out;
  }

  /* ---------------- scheduled (Telegram-native) ---------------- */
  async listScheduled(peer: Peer): Promise<Api.Message[]> {
    return this.call("getScheduledMessages", () => this.d.client.getScheduledMessages(peer), "read");
  }
  async cancelScheduled(peer: Peer, ids: number[]): Promise<void> {
    await this.call("deleteScheduledMessages", () => this.d.client.deleteScheduledMessages(peer, ids), "delete");
  }
  async sendScheduledNow(peer: Peer, ids: number[]): Promise<void> {
    await this.call("sendScheduledMessages", () => this.d.client.sendScheduledMessages(peer, ids));
  }
}
