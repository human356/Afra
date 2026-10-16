const PATTERNS: RegExp[] = [
  /\b\d{5,12}:[A-Za-z0-9_-]{30,}\b/g, // Bot API tokens
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g, // Anthropic API keys
  /\b1[A-Za-z0-9+/=_-]{180,}/g, // StringSession-looking blobs
  /\b[0-9a-f]{32}\b/g, // api_hash-like hex (32 chars)
  /(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+(@)/g, // DB URL passwords
];

/** Returns a function that masks configured secrets and secret-looking tokens in any string. */
export function makeRedactor(secrets: readonly string[]): (s: string) => string {
  const literals = [...new Set(secrets.filter((s) => s.length >= 6))].sort((a, b) => b.length - a.length);
  return (input: string): string => {
    let out = input;
    for (const lit of literals) if (out.includes(lit)) out = out.split(lit).join("[REDACTED]");
    for (const re of PATTERNS) out = out.replace(re, (m, a?: string, b?: string) => (typeof a === "string" && typeof b === "string" ? `${a}[REDACTED]${b}` : "[REDACTED]"));
    return out;
  };
}
