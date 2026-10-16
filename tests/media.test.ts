import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classifyMessage, describeMedia } from "../src/media/classify";
import { buildFileName, sanitizeFileName } from "../src/media/naming";
import { CHUNK, MediaService, resumeOffset, type Fetchers } from "../src/media/service";
import { memDb, silent, testConfig, tmpDir } from "./helpers";

type AnyMsg = Parameters<typeof classifyMessage>[0];
const doc = (mimeType: string, attributes: Array<Record<string, unknown>>, size = 1000): AnyMsg => ({ photo: undefined, document: { className: "Document", id: 99, accessHash: 7, dcId: 2, mimeType, size, attributes } }) as unknown as AnyMsg;

describe("media classification", () => {
  it("recognises voice, video note, gif, video, audio, plain document", () => {
    expect(classifyMessage(doc("audio/ogg", [{ className: "DocumentAttributeAudio", voice: true, duration: 4 }]))).toMatchObject({ kind: "voice", duration: 4 });
    expect(classifyMessage(doc("video/mp4", [{ className: "DocumentAttributeVideo", roundMessage: true, duration: 3, w: 240, h: 240 }]))?.kind).toBe("video_note");
    expect(classifyMessage(doc("video/mp4", [{ className: "DocumentAttributeVideo", duration: 3, w: 10, h: 10 }, { className: "DocumentAttributeAnimated" }]))?.kind).toBe("gif");
    expect(classifyMessage(doc("video/mp4", [{ className: "DocumentAttributeVideo", duration: 90, w: 1920, h: 1080 }]))).toMatchObject({ kind: "video", width: 1920, height: 1080, ext: ".mp4" });
    expect(classifyMessage(doc("audio/mpeg", [{ className: "DocumentAttributeAudio", title: "Song", performer: "Band", duration: 200 }]))).toMatchObject({ kind: "audio", title: "Song" });
    expect(classifyMessage(doc("application/pdf", [{ className: "DocumentAttributeFilename", fileName: "report.PDF" }]))).toMatchObject({ kind: "document", name: "report.PDF", ext: ".pdf" });
  });

  it("detects sticker formats and custom emoji", () => {
    const set = { className: "InputStickerSetShortName", shortName: "Cats" };
    expect(classifyMessage(doc("image/webp", [{ className: "DocumentAttributeSticker", alt: "😺", stickerset: set }]))?.sticker).toMatchObject({ format: "static", alt: "😺", setShortName: "Cats", customEmoji: false });
    expect(classifyMessage(doc("application/x-tgsticker", [{ className: "DocumentAttributeSticker", alt: "x" }]))?.sticker?.format).toBe("animated");
    expect(classifyMessage(doc("video/webm", [{ className: "DocumentAttributeSticker", alt: "x" }]))?.sticker?.format).toBe("video");
    expect(classifyMessage(doc("application/x-tgsticker", [{ className: "DocumentAttributeCustomEmoji", alt: "🙂" }]))?.sticker).toMatchObject({ customEmoji: true });
  });

  it("classifies photos by their largest size and ignores text-only messages", () => {
    const m = { document: undefined, photo: { className: "Photo", id: 1, accessHash: 2, dcId: 4, sizes: [{ w: 90, h: 90, size: 1000 }, { w: 1280, h: 960, sizes: [5000, 90000] }] } } as unknown as AnyMsg;
    expect(classifyMessage(m)).toMatchObject({ kind: "photo", width: 1280, height: 960, size: 90000 });
    expect(classifyMessage({ photo: undefined, document: undefined } as unknown as AnyMsg)).toBeUndefined();
    expect(describeMedia(classifyMessage(m)!).join("\n")).toContain("1280×960");
  });
});

describe("file naming", () => {
  it("neutralises path traversal and illegal characters", () => {
    for (const evil of ["../../etc/passwd", "a/b\\c", "con:*?.txt", "\u0000bad\u001f", "...", ""]) {
      const n = sanitizeFileName(evil);
      expect(n).not.toMatch(/[\\/:*?"<>|]/);
      expect(n).not.toContain("..");
      expect(n.startsWith(".")).toBe(false);
      expect(n.length).toBeGreaterThan(0);
    }
    expect(sanitizeFileName("x".repeat(300) + ".mp4").length).toBeLessThanOrEqual(120);
    expect(sanitizeFileName("x".repeat(300) + ".mp4").endsWith(".mp4")).toBe(true);
  });

  it("applies templates and appends the extension", () => {
    const n = buildFileName("{date}_{chat}_{id}_{name}", { date: new Date("2026-10-12T08:09:10Z"), chat: "-100123", id: 77, name: "holiday.jpg", ext: ".jpg", kind: "photo" });
    expect(n).toBe("20261012-080910_m100123_77_holiday.jpg");
    expect(buildFileName("{kind}-{sha8}{ext}", { date: new Date(0), chat: "1", id: 1, ext: ".png", sha8: "deadbeef", kind: "photo" })).toBe("photo-deadbeef.png");
  });
});

describe("downloads", () => {
  const msg = (size: number, id = 7) => ({ id, date: 1_700_000_000, chatId: 5, photo: undefined, document: { className: "Document", id: 1, accessHash: 2, dcId: 1, mimeType: "video/mp4", size, attributes: [{ className: "DocumentAttributeFilename", fileName: "clip.mp4" }, { className: "DocumentAttributeVideo", duration: 1, w: 2, h: 2 }] } }) as never;

  async function setup(data: Buffer, over: Record<string, string> = {}) {
    const { repos } = await memDb();
    const cfg = testConfig(over);
    const offsets: number[] = [];
    const fetchers: Fetchers = {
      photo: async () => data,
      async *document(_m, offset) {
        offsets.push(offset);
        for (let o = offset; o < data.length; o += CHUNK) yield data.subarray(o, Math.min(o + CHUNK, data.length));
      },
    };
    return { cfg, repos, offsets, service: new MediaService({ cfg, logger: silent, repo: repos.media, fetchers }) };
  }

  it("downloads, hashes, files under kind/year/month and records metadata", async () => {
    const data = crypto.randomBytes(CHUNK * 2 + 123);
    const t = await setup(data);
    const progress: number[] = [];
    const r = await t.service.download(msg(data.length), { chatKey: "5", chatId: 5, onProgress: (d) => progress.push(d) });
    expect(fs.readFileSync(r.path).equals(data)).toBe(true);
    expect(r.sha256).toBe(crypto.createHash("sha256").update(data).digest("hex"));
    expect(r.path).toContain(path.join("video", "2023", "11"));
    expect(path.basename(r.path)).toContain("clip");
    expect(r.duplicate).toBe(false);
    expect(progress.at(-1)).toBe(data.length);
    expect(await t.repos.media.findBySha(r.sha256)).toMatchObject({ kind: "video", chatId: 5, messageId: 7 });
    expect(fs.existsSync(path.join(t.cfg.paths.downloadsDir, ".partial", "5_7.part"))).toBe(false);
  });

  it("detects duplicates by content hash and does not store the file twice", async () => {
    const data = crypto.randomBytes(5000);
    const t = await setup(data);
    const a = await t.service.download(msg(data.length, 1), { chatKey: "5" });
    const b = await t.service.download(msg(data.length, 2), { chatKey: "5" });
    expect(b.duplicate).toBe(true);
    expect(b.path).toBe(a.path);
    expect((await t.repos.media.stats()).files).toBe(1);
  });

  it("resumes from the last whole chunk of an existing .part file", async () => {
    const data = crypto.randomBytes(CHUNK * 2 + 1000);
    const t = await setup(data);
    const partDir = path.join(t.cfg.paths.downloadsDir, ".partial");
    fs.mkdirSync(partDir, { recursive: true });
    fs.writeFileSync(path.join(partDir, "5_7.part"), data.subarray(0, CHUNK + 300)); // interrupted mid-chunk
    const r = await t.service.download(msg(data.length), { chatKey: "5" });
    expect(t.offsets).toEqual([CHUNK]);
    expect(r.resumed).toBe(true);
    expect(fs.readFileSync(r.path).equals(data)).toBe(true);
  });

  it("restarts when the leftover part file is larger than the file (stale)", async () => {
    const data = crypto.randomBytes(2000);
    const t = await setup(data);
    const partDir = path.join(t.cfg.paths.downloadsDir, ".partial");
    fs.mkdirSync(partDir, { recursive: true });
    fs.writeFileSync(path.join(partDir, "5_7.part"), Buffer.alloc(CHUNK * 3));
    const r = await t.service.download(msg(data.length), { chatKey: "5" });
    expect(t.offsets).toEqual([0]);
    expect(fs.readFileSync(r.path).equals(data)).toBe(true);
  });

  it("keeps the partial file when the transfer is incomplete, so it can resume", async () => {
    const full = crypto.randomBytes(CHUNK + 500);
    const t = await setup(full.subarray(0, CHUNK));
    await expect(t.service.download(msg(full.length), { chatKey: "5" })).rejects.toThrow(/incomplete/);
    expect(fs.statSync(path.join(t.cfg.paths.downloadsDir, ".partial", "5_7.part")).size).toBe(CHUNK);
  });

  it("enforces the size limit and rejects messages without media", async () => {
    const t = await setup(Buffer.alloc(1), { MEDIA_MAX_DOWNLOAD_MB: "1" });
    await expect(t.service.download(msg(5 * 1024 * 1024), { chatKey: "5" })).rejects.toThrow(/limit/);
    await expect(t.service.download({ id: 1, photo: undefined, document: undefined } as never, { chatKey: "5" })).rejects.toThrow(/no downloadable media/);
  });

  it("computes resume offsets on chunk boundaries", () => {
    expect(resumeOffset(0)).toBe(0);
    expect(resumeOffset(CHUNK - 1)).toBe(0);
    expect(resumeOffset(CHUNK * 3 + 17)).toBe(CHUNK * 3);
    expect(CHUNK % 4096).toBe(0);
    expect(1024 * 1024 % CHUNK).toBe(0);
  });

  it("never writes outside the downloads directory, whatever the file name says", async () => {
    const data = crypto.randomBytes(100);
    const t = await setup(data);
    const evil = { id: 3, date: 1_700_000_000, chatId: 5, photo: undefined, document: { className: "Document", id: 1, accessHash: 2, dcId: 1, mimeType: "application/pdf", size: 100, attributes: [{ className: "DocumentAttributeFilename", fileName: "../../../../tmp/pwned.pdf" }] } } as never;
    const r = await t.service.download(evil, { chatKey: "../../x" });
    expect(path.resolve(r.path).startsWith(path.resolve(t.cfg.paths.downloadsDir) + path.sep)).toBe(true);
  });
});

it("tmpDir helper exists", () => expect(fs.existsSync(tmpDir())).toBe(true));
