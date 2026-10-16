import { UsageError } from "../core/errors";

interface Transform {
  description: string;
  fn: (s: string) => string;
}

const words = (s: string): string[] =>
  s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);

export const TRANSFORMS: Record<string, Transform> = {
  upper: { description: "UPPERCASE", fn: (s) => s.toUpperCase() },
  lower: { description: "lowercase", fn: (s) => s.toLowerCase() },
  title: { description: "Title Case", fn: (s) => s.toLowerCase().replace(/(^|\s)(\p{L})/gu, (_m, a: string, b: string) => a + b.toUpperCase()) },
  reverse: { description: "reverse the text", fn: (s) => [...s].reverse().join("") },
  mock: { description: "aLtErNaTiNg cAsE", fn: (s) => [...s].map((c, i) => (i % 2 ? c.toUpperCase() : c.toLowerCase())).join("") },
  snake: { description: "snake_case", fn: (s) => words(s).map((w) => w.toLowerCase()).join("_") },
  kebab: { description: "kebab-case", fn: (s) => words(s).map((w) => w.toLowerCase()).join("-") },
  camel: { description: "camelCase", fn: (s) => words(s).map((w, i) => (i ? w[0]?.toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join("") },
  slug: { description: "url-slug", fn: (s) => words(s).map((w) => w.toLowerCase()).join("-") },
  b64: {
    description: "Base64-encode",
    fn: (s) => Buffer.from(s, "utf8").toString("base64"),
  },
  unb64: {
    description: "Base64-decode",
    fn: (s) => {
      const t = s.trim();
      if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(t) || t.length === 0) throw new UsageError("That is not valid Base64");
      return Buffer.from(t.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    },
  },
  rot13: {
    description: "ROT13",
    fn: (s) =>
      s.replace(/[A-Za-z]/g, (c) => {
        const base = c <= "Z" ? 65 : 97;
        return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
      }),
  },
  trim: { description: "collapse whitespace", fn: (s) => s.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim() },
  sort: { description: "sort lines", fn: (s) => s.split("\n").sort((a, b) => a.localeCompare(b)).join("\n") },
  uniq: { description: "remove duplicate lines", fn: (s) => [...new Set(s.split("\n"))].join("\n") },
  numbered: { description: "number the lines", fn: (s) => s.split("\n").map((l, i) => `${i + 1}. ${l}`).join("\n") },
  count: { description: "count characters, words and lines", fn: (s) => `${[...s].length} characters, ${s.trim() ? s.trim().split(/\s+/).length : 0} words, ${s.split("\n").length} lines` },
};

export function applyTransform(name: string, text: string): string {
  const t = TRANSFORMS[name.toLowerCase()];
  if (!t) throw new UsageError(`Unknown transform "${name}"`, `Available: ${Object.keys(TRANSFORMS).join(", ")}`);
  return t.fn(text);
}

/** Applies several transforms in order, e.g. ["trim", "upper"]. */
export function applyChain(names: string[], text: string): string {
  return names.reduce((acc, n) => applyTransform(n, acc), text);
}
