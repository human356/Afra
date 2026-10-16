import type { Logger } from "pino";
import type { TelegramClient } from "teleproto";
import type { AccessControl } from "../auth/access";
import type { SessionStore } from "../auth/sessionStore";
import type { AdminService } from "../admin/service";
import type { AiService } from "../automation/ai";
import type { RuleEngine } from "../automation/rules";
import type { Scheduler, TaskService } from "../automation/scheduler";
import type { Translator } from "../automation/translate";
import type { ChatService } from "../chats/service";
import type { CommandDispatcher } from "../commands/dispatcher";
import type { ConfirmationManager } from "../commands/confirmations";
import type { CommandRegistry } from "../commands/registry";
import type { AppConfig } from "../config";
import type { MediaService } from "../media/service";
import type { Messenger } from "../messaging/messenger";
import type { HealthMonitor } from "../monitoring/health";
import type { PluginManager } from "../plugins/manager";
import type { SearchService } from "../search/service";
import type { StickerService } from "../stickers/service";
import type { Repos } from "../storage/repositories";
import type { Database } from "../storage/types";
import type { ProbeResult } from "./features";
import type { Metrics } from "./metrics";
import type { LogRing } from "./logger";
import type { BoundedQueue, Pacer } from "./queue";

export interface AccountInfo {
  id: number;
  username?: string;
  name: string;
}

/** Everything a command, the dashboard or a plugin may need, wired once at startup. */
export interface Services {
  cfg: AppConfig;
  logger: Logger;
  ring: LogRing;
  metrics: Metrics;
  db: Database;
  repos: Repos;
  access: AccessControl;
  queue: BoundedQueue;
  pacer: Pacer;
  session: SessionStore;
  client: TelegramClient;
  account: AccountInfo;
  bot?: { client: TelegramClient; account: AccountInfo };
  messenger: Messenger;
  botMessenger?: Messenger;
  media: MediaService;
  stickers: StickerService;
  search: SearchService;
  chats: ChatService;
  admin: AdminService;
  rules: RuleEngine;
  scheduler: Scheduler;
  tasks: TaskService;
  translator: Translator;
  ai: AiService;
  plugins: PluginManager;
  registry: CommandRegistry;
  confirmations: ConfirmationManager;
  dispatcher: CommandDispatcher;
  health: HealthMonitor;
  features: ProbeResult;
  /** Sends text through the user account or the control bot (reminders created via the bot are answered by the bot). */
  deliver(via: "bot" | "userbot", chat: string | number, text: string): Promise<void>;
}
