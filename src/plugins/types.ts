import type { Logger } from "pino";
import type { z } from "zod";
import type { Scope } from "../auth/access";
import type { TaskHandler } from "../automation/scheduler";
import type { CommandContext } from "../commands/types";
import type { Peer } from "../messaging/messenger";

/** Bump when the plugin interface changes incompatibly. Plugins declare the version they were written for. */
export const PLUGIN_API_VERSION = 1;

export interface PluginManifest {
  /** Lowercase slug, e.g. "daily-quote". */
  name: string;
  /** Semantic version of the plugin itself. */
  version: string;
  description: string;
  apiVersion: number;
  /** Optional zod schema validating this plugin's configuration object. */
  configSchema?: z.ZodType<Record<string, unknown>>;
  /** Defaults merged under the stored configuration. */
  defaults?: Record<string, unknown>;
}

export interface PluginMessage {
  text: string;
  chatId: number;
  chatType: "private" | "group" | "channel";
  senderId?: number;
  messageId: number;
  isOut: boolean;
}

export interface PluginCommand {
  name: string;
  aliases?: string[];
  usage: string;
  description: string;
  /** Default: "self". */
  scope?: Scope | "master";
  run(ctx: CommandContext): Promise<void>;
}

export interface PluginContext {
  readonly name: string;
  readonly logger: Logger;
  /** Validated configuration (defaults + stored values). */
  readonly config: Readonly<Record<string, unknown>>;
  registerCommand(cmd: PluginCommand): void;
  /** Receive incoming messages (text only, in memory only — the core never stores what plugins see). */
  onMessage(handler: (m: PluginMessage) => Promise<void> | void): void;
  registerTaskKind(kind: string, handler: TaskHandler, opts?: { runIfLate?: boolean }): void;
  send(peer: Peer, text: string): Promise<void>;
  /** Key/value storage private to this plugin. */
  storage: {
    get(key: string): Promise<string | undefined>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<boolean>;
  };
}

export interface Plugin {
  manifest: PluginManifest;
  activate(ctx: PluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

export type PluginStatus = "active" | "disabled" | "failed";

export interface PluginInfo {
  name: string;
  version: string;
  description: string;
  builtin: boolean;
  status: PluginStatus;
  failures: number;
  lastError?: string;
  commands: string[];
  config: Record<string, unknown>;
}
