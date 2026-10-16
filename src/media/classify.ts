import type { Api } from "teleproto";
import { formatBytes, toNum, type MediaKind } from "../core/tg";

export interface MediaInfo {
  kind: MediaKind;
  mime?: string;
  size?: number;
  name?: string;
  ext?: string;
  duration?: number;
  width?: number;
  height?: number;
  title?: string;
  performer?: string;
  /** Sticker/emoji details when present. */
  sticker?: StickerInfo;
  mtproto: { type: "photo" | "document"; id: string; accessHash?: string; dcId?: number };
}

export interface StickerInfo {
  alt?: string;
  setShortName?: string;
  setId?: string;
  customEmoji: boolean;
  format: "static" | "animated" | "video" | "unknown";
}

const MIME_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "audio/mpeg": ".mp3",
  "audio/ogg": ".ogg",
  "audio/mp4": ".m4a",
  "audio/x-wav": ".wav",
  "application/pdf": ".pdf",
  "application/zip": ".zip",
  "application/x-tgsticker": ".tgs",
  "text/plain": ".txt",
};

export function extensionFor(mime?: string, name?: string): string | undefined {
  const fromName = name ? /\.[A-Za-z0-9]{1,8}$/.exec(name)?.[0]?.toLowerCase() : undefined;
  return fromName ?? (mime ? MIME_EXT[mime.toLowerCase()] : undefined);
}

type Attr = { className?: string } & Record<string, unknown>;

/** Sticker format from mime type: webp = static, tgs = animated (Lottie), webm = video sticker. */
export function stickerFormat(mime?: string): StickerInfo["format"] {
  switch (mime) {
    case "image/webp":
      return "static";
    case "application/x-tgsticker":
      return "animated";
    case "video/webm":
      return "video";
    default:
      return "unknown";
  }
}

function inputSetInfo(set: unknown): { shortName?: string; id?: string } {
  const s = set as { className?: string; shortName?: string; id?: unknown } | undefined;
  if (!s) return {};
  if (s.className === "InputStickerSetShortName") return { shortName: s.shortName };
  if (s.className === "InputStickerSetID") return { id: String(s.id) };
  return {};
}

/** Classifies the media attached to a message. Returns undefined for text-only or unsupported media. */
export function classifyMessage(msg: Pick<Api.Message, "photo" | "document">): MediaInfo | undefined {
  const photo = msg.photo as (Api.Photo & { sizes?: Array<Record<string, unknown>> }) | undefined;
  if (photo && photo.className === "Photo") {
    let w: number | undefined;
    let h: number | undefined;
    let size: number | undefined;
    for (const s of photo.sizes ?? []) {
      const sw = toNum(s["w"]);
      const sh = toNum(s["h"]);
      if (sw && sh && (w === undefined || sw * sh > (w ?? 0) * (h ?? 0))) {
        w = sw;
        h = sh;
        const sizes = s["sizes"] as unknown[] | undefined;
        size = toNum(s["size"]) ?? (sizes?.length ? Math.max(...sizes.map((x) => toNum(x) ?? 0)) : size);
      }
    }
    return { kind: "photo", mime: "image/jpeg", ext: ".jpg", width: w, height: h, size, mtproto: { type: "photo", id: String(photo.id), accessHash: String(photo.accessHash), dcId: photo.dcId } };
  }

  const doc = msg.document as (Api.Document & { attributes?: Attr[] }) | undefined;
  if (!doc) return undefined;
  const attrs = (doc.attributes ?? []) as Attr[];
  const find = (name: string): Attr | undefined => attrs.find((a) => a.className === name);
  const filename = find("DocumentAttributeFilename");
  const video = find("DocumentAttributeVideo");
  const audio = find("DocumentAttributeAudio");
  const stickerAttr = find("DocumentAttributeSticker");
  const customEmoji = find("DocumentAttributeCustomEmoji");
  const animated = find("DocumentAttributeAnimated");
  const imageSize = find("DocumentAttributeImageSize");
  const mime = doc.mimeType;

  let kind: MediaKind = "document";
  if (stickerAttr || customEmoji) kind = "sticker";
  else if (audio?.["voice"]) kind = "voice";
  else if (video?.["roundMessage"]) kind = "video_note";
  else if (animated && (video || mime?.startsWith("video/"))) kind = "gif";
  else if (video) kind = "video";
  else if (audio) kind = "audio";

  const name = (filename?.["fileName"] as string | undefined) ?? undefined;
  const info: MediaInfo = {
    kind,
    mime,
    size: toNum(doc.size),
    name,
    ext: extensionFor(mime, name),
    duration: toNum(video?.["duration"] ?? audio?.["duration"]),
    width: toNum(video?.["w"] ?? imageSize?.["w"]),
    height: toNum(video?.["h"] ?? imageSize?.["h"]),
    title: audio?.["title"] as string | undefined,
    performer: audio?.["performer"] as string | undefined,
    mtproto: { type: "document", id: String(doc.id), accessHash: String(doc.accessHash), dcId: doc.dcId },
  };
  if (stickerAttr || customEmoji) {
    const set = inputSetInfo((stickerAttr ?? customEmoji)?.["stickerset"]);
    info.sticker = { alt: (stickerAttr ?? customEmoji)?.["alt"] as string | undefined, setShortName: set.shortName, setId: set.id, customEmoji: Boolean(customEmoji), format: stickerFormat(mime) };
  }
  return info;
}

export function describeMedia(i: MediaInfo): string[] {
  const lines = [`Kind: ${i.kind}${i.mime ? ` (${i.mime})` : ""}`];
  if (i.name) lines.push(`Name: ${i.name}`);
  if (i.size !== undefined) lines.push(`Size: ${formatBytes(i.size)}`);
  if (i.width && i.height) lines.push(`Dimensions: ${i.width}×${i.height}`);
  if (i.duration !== undefined) lines.push(`Duration: ${i.duration}s`);
  if (i.title || i.performer) lines.push(`Track: ${[i.performer, i.title].filter(Boolean).join(" — ")}`);
  if (i.sticker) lines.push(`${i.sticker.customEmoji ? "Custom emoji" : "Sticker"}: ${i.sticker.format}${i.sticker.alt ? `, emoji ${i.sticker.alt}` : ""}${i.sticker.setShortName ? `, set ${i.sticker.setShortName}` : ""}`);
  return lines;
}
