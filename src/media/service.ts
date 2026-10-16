import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import type { Api, TelegramClient } from "teleproto";
import type { AppConfig } from "../config";
import { UsageError } from "../core/errors";
import type { MediaRecord, MediaRepo } from "../storage/repositories";
import { classifyMessage, type MediaInfo } from "./classify";
import { buildFileName, relativeDir } from "./naming";

/** 512 KiB: a multiple of 4 KiB that divides 1 MiB, as Telegram requires for chunked downloads. */
export const CHUNK = 512 * 1024;

export interface Fetchers {
  /** Streams a document starting at `offset` (aligned to CHUNK). */
  document(msg: Api.Message, offset: number): AsyncIterable<Buffer>;
  photo(msg: Api.Message): Promise<Buffer>;
}

export function clientFetchers(client: TelegramClient): Fetchers {
  return {
    document: (msg, offset) => client.iterDownload(msg, { offset, requestSize: CHUNK }),
    photo: async (msg) => {
      const buf = await client.downloadMedia(msg);
      if (!Buffer.isBuffer(buf)) throw new Error("Telegram returned no photo data");
      return buf;
    },
  };
}

export interface DownloadOptions {
  /** Chat reference used in file names and the .part file name. */
  chatKey: string;
  chatId?: number;
  onProgress?: (done: number, total: number | undefined) => void;
  signal?: AbortSignal;
}

export interface DownloadResult {
  path: string;
  sha256: string;
  size: number;
  duplicate: boolean;
  resumed: boolean;
  info: MediaInfo;
  record?: MediaRecord;
}

export function resumeOffset(partSize: number, chunk = CHUNK): number {
  return Math.floor(partSize / chunk) * chunk;
}

export async function sha256File(file: string): Promise<string> {
  const h = crypto.createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    fs.createReadStream(file)
      .on("data", (c) => h.update(c))
      .on("end", resolve)
      .on("error", reject);
  });
  return h.digest("hex");
}

export interface MediaDeps {
  cfg: AppConfig;
  logger: Logger;
  repo: MediaRepo;
  fetchers: Fetchers;
}

export class MediaService {
  constructor(private readonly d: MediaDeps) {}

  classify(msg: Api.Message): MediaInfo | undefined {
    return classifyMessage(msg);
  }

  /** Downloads one message's media: resumable, hashed, de-duplicated, and filed under a predictable path. */
  async download(msg: Api.Message, opts: DownloadOptions): Promise<DownloadResult> {
    const info = classifyMessage(msg);
    if (!info) throw new UsageError("That message has no downloadable media");
    const maxBytes = this.d.cfg.media.maxDownloadMb * 1024 * 1024;
    if (info.size !== undefined && info.size > maxBytes) throw new UsageError(`File is ${Math.round(info.size / 1048576)} MB; the limit is ${this.d.cfg.media.maxDownloadMb} MB (MEDIA_MAX_DOWNLOAD_MB)`);

    const root = this.d.cfg.paths.downloadsDir;
    const partDir = path.join(root, ".partial");
    fs.mkdirSync(partDir, { recursive: true, mode: 0o700 });
    const partFile = path.join(partDir, `${opts.chatKey.replace(/[^\w-]/g, "_")}_${msg.id}.part`);

    let resumed = false;
    if (info.mtproto.type === "photo") {
      const buf = await this.d.fetchers.photo(msg);
      fs.writeFileSync(partFile, buf);
      opts.onProgress?.(buf.length, buf.length);
    } else {
      resumed = await this.fetchDocument(msg, info, partFile, opts);
    }

    const size = fs.statSync(partFile).size;
    const sha256 = await sha256File(partFile);
    const existing = await this.d.repo.findBySha(sha256);
    if (existing && fs.existsSync(existing.path)) {
      fs.rmSync(partFile, { force: true });
      this.d.logger.info({ module: "media", sha: sha256.slice(0, 12), existing: existing.path }, "duplicate download skipped");
      return { path: existing.path, sha256, size, duplicate: true, resumed, info, record: existing };
    }

    const date = new Date((msg.date ?? 0) * 1000);
    const name = buildFileName(this.d.cfg.media.nameTemplate, { date, chat: opts.chatKey, id: msg.id, name: info.name, ext: info.ext, sha8: sha256.slice(0, 8), kind: info.kind });
    const dir = path.join(root, relativeDir(info.kind, date));
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const finalPath = uniquePath(path.join(dir, name));
    fs.renameSync(partFile, finalPath);
    const id = await this.d.repo.insert({ sha256, path: finalPath, size, mime: info.mime, kind: info.kind, chatId: opts.chatId, messageId: msg.id, originalName: info.name });
    return { path: finalPath, sha256, size, duplicate: false, resumed, info, record: { id, sha256, path: finalPath, size, mime: info.mime, kind: info.kind, chatId: opts.chatId, messageId: msg.id, originalName: info.name, createdAt: Date.now() } };
  }

  /** Appends chunks to the .part file, resuming from the last whole chunk already on disk. Returns true if resumed. */
  private async fetchDocument(msg: Api.Message, info: MediaInfo, partFile: string, opts: DownloadOptions): Promise<boolean> {
    const existing = fs.existsSync(partFile) ? fs.statSync(partFile).size : 0;
    let offset = resumeOffset(existing);
    if (info.size !== undefined && existing > info.size) offset = 0; // stale/corrupt leftover
    const fd = fs.openSync(partFile, offset > 0 ? "r+" : "w");
    try {
      fs.ftruncateSync(fd, offset);
      let pos = offset;
      opts.onProgress?.(pos, info.size);
      for await (const chunk of this.d.fetchers.document(msg, offset)) {
        if (opts.signal?.aborted) throw new Error("download cancelled");
        fs.writeSync(fd, chunk, 0, chunk.length, pos);
        pos += chunk.length;
        opts.onProgress?.(pos, info.size);
      }
      if (info.size !== undefined && pos !== info.size) throw new Error(`incomplete download: got ${pos} of ${info.size} bytes (the partial file is kept and will resume)`);
    } finally {
      fs.closeSync(fd);
    }
    return offset > 0;
  }
}

function uniquePath(p: string): string {
  if (!fs.existsSync(p)) return p;
  const { dir, name, ext } = path.parse(p);
  for (let i = 2; i < 10_000; i++) {
    const c = path.join(dir, `${name}-${i}${ext}`);
    if (!fs.existsSync(c)) return c;
  }
  return path.join(dir, `${name}-${Date.now()}${ext}`);
}
