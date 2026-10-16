import type { Api } from "teleproto";
import { UsageError } from "../core/errors";
import { parseWhen } from "../core/time";
import { parseChatRef, toNum } from "../core/tg";
import type { Services } from "../core/services";
import type { CommandContext } from "./types";

export function intArg(value: string | undefined, name: string, opts: { min?: number; max?: number; def?: number } = {}): number {
  if (value === undefined || value === "") {
    if (opts.def !== undefined) return opts.def;
    throw new UsageError(`Missing ${name}`);
  }
  const n = Number(value);
  if (!Number.isInteger(n)) throw new UsageError(`${name} must be a whole number`);
  if (opts.min !== undefined && n < opts.min) throw new UsageError(`${name} must be at least ${opts.min}`);
  if (opts.max !== undefined && n > opts.max) throw new UsageError(`${name} must be at most ${opts.max}`);
  return n;
}

/** Text after the first `skip` whitespace-separated tokens of the raw command text. */
export function textAfter(rest: string, skip: number): string {
  let s = rest.trimStart();
  for (let i = 0; i < skip; i++) s = s.replace(/^\S+\s*/, "");
  return s.trim();
}

/** Reads a "when" from the start of `args`: a duration/time token, or two tokens like `tomorrow 09:00` / `2026-12-31 23:59`. */
export function extractWhen(args: string[], now: Date = new Date()): { when: Date; consumed: number } {
  const first = args[0];
  if (!first) throw new UsageError("Say when", "Examples: 10m, 2h30m, 18:30, tomorrow 09:00, 2026-12-31 23:59");
  const two = args[1] ? parseWhen(`${first} ${args[1]}`, now) : undefined;
  if (two && /^(tomorrow|\d{4}-\d{2}-\d{2})$/i.test(first)) return { when: two, consumed: 2 };
  const one = parseWhen(first, now);
  if (one) return { when: one, consumed: 1 };
  throw new UsageError(`Could not understand the time "${first}"`, "Examples: 10m, 2h30m, 18:30, tomorrow 09:00, 2026-12-31 23:59");
}

/** The message a command refers to: the replied-to message (userbot) or `--chat=` + `--id=`. */
export async function resolveTargetMessage(ctx: CommandContext, s: Services): Promise<{ msg: Api.Message; peer: string | number }> {
  const replied = await ctx.getRepliedMessage();
  if (replied) {
    const chatNum = toNum(replied.chatId);
    return { msg: replied, peer: chatNum ?? parseChatRef(ctx.chatId) };
  }
  const idOpt = ctx.cmd.options["id"];
  if (!idOpt) throw new UsageError("Reply to a message, or pass --chat=<chat> --id=<message id>");
  const peer = ctx.targetChat();
  const msg = await s.messenger.getById(peer, intArg(idOpt, "--id", { min: 1 }));
  if (!msg) throw new UsageError("That message was not found (or is not visible to this account)");
  return { msg, peer };
}

export const chatKey = (peer: string | number): string => String(peer).replace(/^@/, "");

export const bullet = (items: string[]): string => items.map((i) => `• ${i}`).join("\n");

export function shortId(n: number | undefined): string {
  return n === undefined ? "?" : String(n);
}
