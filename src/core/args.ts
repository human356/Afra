export interface ParsedCommand {
  name: string;
  args: string[];
  options: Record<string, string>;
  flags: Set<string>;
  /** Everything after the command name, unmodified (useful for free-text commands). */
  rest: string;
}

/** Splits text into tokens, honouring "double" and 'single' quotes and backslash escapes. */
export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i] as string;
    if (quote) {
      if (ch === "\\" && i + 1 < input.length) cur += input[++i];
      else if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) tokens.push(cur);
      cur = "";
      has = false;
    } else if (ch === "\\" && i + 1 < input.length) {
      cur += input[++i];
    } else {
      cur += ch;
    }
  }
  if (has || cur) tokens.push(cur);
  return tokens;
}

/**
 * Parses "<prefix>name arg1 --opt=value --flag". Returns undefined if `text` is not a command.
 * For bot-style commands ("/name@MyBot") the "@bot" suffix is dropped.
 */
export function parseCommand(text: string, prefix: string): ParsedCommand | undefined {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith(prefix)) return undefined;
  const afterPrefix = trimmed.slice(prefix.length);
  const m = /^([A-Za-z][\w-]*)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(afterPrefix);
  if (!m) return undefined;
  const name = (m[1] as string).toLowerCase();
  const rest = (m[2] ?? "").trim();
  const args: string[] = [];
  const options: Record<string, string> = {};
  const flags = new Set<string>();
  for (const tok of tokenize(rest)) {
    const opt = /^--([A-Za-z][\w-]*)=([\s\S]*)$/.exec(tok);
    const flag = /^--([A-Za-z][\w-]*)$/.exec(tok);
    if (opt) options[(opt[1] as string).toLowerCase()] = opt[2] as string;
    else if (flag) flags.add((flag[1] as string).toLowerCase());
    else args.push(tok);
  }
  return { name, args, options, flags, rest };
}

/** Removes `--options` and `--flags` from free text, leaving the message body. */
export function stripOptions(text: string): string {
  return text.replace(/(?:^|\s)--[A-Za-z][\w-]*(?:=(?:"[^"]*"|'[^']*'|\S*))?(?=\s|$)/g, " ").replace(/\s+/g, " ").trim();
}
