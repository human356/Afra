import type { Api } from "teleproto";
import { UsageError } from "./errors";

/** big-integer / bigint / number / string → JS number (Telegram ids fit in 2^53). */
export function toNum(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  const maybe = v as { toJSNumber?: () => number; toString: () => string };
  if (typeof maybe.toJSNumber === "function") return maybe.toJSNumber();
  const n = Number(maybe.toString());
  return Number.isFinite(n) ? n : undefined;
}

/** Turns user input into something `client.getEntity` accepts. */
export function parseChatRef(input: string | undefined, fallback?: string): string | number {
  const ref = (input ?? "").trim() || fallback;
  if (!ref) throw new UsageError("No chat given", "Pass a numeric id, @username, or `me` for Saved Messages.");
  const low = ref.toLowerCase();
  if (low === "me" || low === "saved") return "me";
  if (/^-?\d+$/.test(ref)) return Number(ref);
  if (/^@?[A-Za-z][\w]{3,31}$/.test(ref)) return ref.startsWith("@") ? ref : `@${ref}`;
  const link = /^(?:https?:\/\/)?t\.me\/([A-Za-z][\w]{3,31})$/.exec(ref);
  if (link) return `@${link[1]}`;
  throw new UsageError(`"${ref}" is not a valid chat reference`, "Use a numeric id, @username, a t.me link, or `me`.");
}

export type MediaKind = "photo" | "video" | "video_note" | "voice" | "audio" | "sticker" | "gif" | "document" | "other";

export function truncate(text: string, max = 80): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "?";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** Splits long text at line/word boundaries into Telegram-sized chunks (limit 4096 chars). */
export function chunkText(text: string, max = 4000): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  if (rest) out.push(rest);
  return out;
}

export type MessageSummary = { id: number; date: number; senderId?: number; text: string; media?: string };

export function summarizeMessage(m: Api.Message, maxText = 120): MessageSummary {
  const media = m.media ? (m.media.className ?? "media").replace(/^MessageMedia/, "").toLowerCase() : undefined;
  return { id: m.id, date: (m.date ?? 0) * 1000, senderId: toNum(m.senderId), text: truncate(m.message ?? "", maxText), media };
}
