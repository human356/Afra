import type { Api } from "teleproto";
import type { Principal, Scope } from "../auth/access";
import type { ParsedCommand } from "../core/args";

export type Transport = "userbot" | "bot";

export interface ConfirmSpec {
  /** Stable action name used in the audit log, e.g. "msg.delete". */
  action: string;
  target?: string;
  /** Human-readable description of exactly what will happen. */
  preview: string;
  details?: unknown;
  /** Performs the action and returns a result message. Called only after confirmation. */
  run: () => Promise<string>;
}

export interface CommandContext {
  readonly transport: Transport;
  readonly principal: Principal;
  readonly chatId: string;
  readonly messageId?: number;
  readonly replyToId?: number;
  readonly cmd: ParsedCommand;
  reply(text: string): Promise<void>;
  /** Sends a status message and returns a function that updates it (throttled by the caller). */
  progress(initial: string): Promise<(text: string) => Promise<void>>;
  getRepliedMessage(): Promise<Api.Message | undefined>;
  /** Chat the command acts on: `--chat=...`, else `explicit`, else the current chat (userbot transport only). */
  targetChat(explicit?: string): string | number;
  /** Dry-run preview + explicit confirmation flow for destructive actions. */
  requireConfirmation(spec: ConfirmSpec): Promise<void>;
}

export interface CommandDef {
  name: string;
  aliases?: string[];
  group: string;
  usage: string;
  description: string;
  /** Required scope, or "master" for master-admin-only commands. */
  scope: Scope | "master";
  run(ctx: CommandContext): Promise<void>;
}
