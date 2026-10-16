import path from "node:path";

// eslint-disable-next-line no-control-regex -- stripping control characters from file names is the point
const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g;

/** Makes any string safe as a single file name component (no separators, no traversal, bounded length). */
export function sanitizeFileName(name: string, maxLen = 120): string {
  let n = name.replace(ILLEGAL, "_").replace(/\s+/g, " ").trim().replace(/^\.+/, "").replace(/\.{2,}/g, ".");
  if (!n) n = "file";
  if (n.length > maxLen) {
    const ext = path.extname(n).slice(0, 12);
    n = n.slice(0, maxLen - ext.length) + ext;
  }
  return n;
}

export interface NameContext {
  date: Date;
  chat: string;
  id: number;
  name?: string;
  ext?: string;
  sha8?: string;
  kind: string;
}

const pad = (n: number): string => String(n).padStart(2, "0");
export const dateStamp = (d: Date): string => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;

/**
 * Applies a naming template: {date} {chat} {id} {name} {ext} {sha8} {kind}.
 * The extension is appended automatically when the template doesn't contain {ext}.
 */
export function buildFileName(template: string, c: NameContext): string {
  const base = c.name ? c.name.replace(/\.[A-Za-z0-9]{1,8}$/, "") : c.kind;
  const ext = c.ext ?? "";
  let out = template
    .replaceAll("{date}", dateStamp(c.date))
    .replaceAll("{chat}", c.chat.replace(/^-/, "m"))
    .replaceAll("{id}", String(c.id))
    .replaceAll("{name}", base)
    .replaceAll("{sha8}", c.sha8 ?? "")
    .replaceAll("{kind}", c.kind)
    .replaceAll("{ext}", ext);
  if (!template.includes("{ext}") && ext && !out.toLowerCase().endsWith(ext.toLowerCase())) out += ext;
  return sanitizeFileName(out);
}

/** Directory layout: <root>/<kind>/<YYYY>/<MM>. */
export function relativeDir(kind: string, date: Date): string {
  return path.join(kind, String(date.getUTCFullYear()), pad(date.getUTCMonth() + 1));
}
