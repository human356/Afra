import fs from "node:fs";
import type { Api } from "teleproto";
import { AdminService } from "../admin/service";
import { AccessControl } from "../auth/access";
import { connectBot, connectUser } from "../auth/clients";
import { SessionStore } from "../auth/sessionStore";
import { AiService } from "../automation/ai";
import { registerCoreTaskKinds } from "../automation/kinds";
import { RuleEngine } from "../automation/rules";
import { Scheduler, TaskService } from "../automation/scheduler";
import { Translator } from "../automation/translate";
import { ChatService } from "../chats/service";
import { ConfirmationManager } from "../commands/confirmations";
import { CommandDispatcher } from "../commands/dispatcher";
import { registerAllCommands } from "../commands";
import { CommandRegistry } from "../commands/registry";
import type { AppConfig } from "../config";
import { startDashboard, type DashboardHandle } from "../dashboard/server";
import { probeFeatures } from "../core/features";
import { libInfo } from "../core/library";
import { createLogger } from "../core/logger";
import { Metrics } from "../core/metrics";
import { BoundedQueue, Pacer } from "../core/queue";
import type { AccountInfo, Services } from "../core/services";
import { ShutdownManager } from "../core/lifecycle";
import { toNum } from "../core/tg";
import { clientFetchers, MediaService } from "../media/service";
import { Messenger } from "../messaging/messenger";
import { HealthMonitor } from "../monitoring/health";
import { PluginManager } from "../plugins/manager";
import { timePlugin } from "../plugins/builtin/time";
import { SearchService } from "../search/service";
import { StickerService } from "../stickers/service";
import { createRepos, openDatabase } from "../storage";
import { attachBotTransport, attachUserbotTransport } from "./transports";

export interface RunningApp {
  services: Services;
  dashboard?: DashboardHandle;
  shutdown: ShutdownManager;
  stop(): Promise<void>;
}

const accountOf = (u: Api.User): AccountInfo => ({ id: toNum(u.id) as number, username: u.username ?? undefined, name: [u.firstName, u.lastName].filter(Boolean).join(" ") || "(unnamed)" });

/** Wires every module together and starts the userbot. Throws AppError with recovery hints on startup problems. */
export async function startApp(cfg: AppConfig): Promise<RunningApp> {
  fs.mkdirSync(cfg.paths.dataDir, { recursive: true, mode: 0o700 });
  const { logger, ring } = createLogger({ level: cfg.logging.level, secrets: cfg.secrets });
  const shutdown = new ShutdownManager(logger);
  const features = probeFeatures(libInfo());
  logger.info({ module: "boot", library: features.library, features: features.summary }, "capability probe");
  if (features.summary.unavailable > 0) logger.warn({ module: "boot", unavailable: features.features.filter((f) => f.status === "unavailable").map((f) => f.id) }, "some features are unavailable in this library version");

  const db = await openDatabase(cfg);
  shutdown.register("database", () => db.close(), 10);
  const repos = createRepos(db);
  const metrics = new Metrics();
  const access = new AccessControl(cfg.telegram.masterAdminId, repos.users, repos.audit);
  const queue = new BoundedQueue(cfg.limits.concurrency, cfg.limits.queueMaxSize, (name, err) => logger.debug({ module: "queue", job: name, err: err instanceof Error ? err.message : String(err) }, "job failed"));
  const pacer = new Pacer(cfg.limits.sendIntervalMs);

  const session = new SessionStore(cfg.paths.sessionFile, cfg.security.sessionEncryptionKey);
  const { client, me } = await connectUser(cfg, session, logger);
  shutdown.register("telegram user client", async () => {
    session.save(client.session.save() as unknown as string);
    await client.disconnect();
  }, 20);
  const account = accountOf(me);
  logger.info({ module: "boot", account: account.username ?? account.id, isMaster: account.id === cfg.telegram.masterAdminId }, "user account connected");

  let bot: Services["bot"];
  let botMessenger: Messenger | undefined;
  if (cfg.telegram.botToken) {
    const b = await connectBot(cfg, new SessionStore(cfg.paths.botSessionFile, cfg.security.sessionEncryptionKey), logger);
    bot = { client: b.client, account: accountOf(b.me) };
    shutdown.register("control bot client", () => b.client.disconnect(), 20);
    botMessenger = new Messenger({ client: b.client, cfg, logger, metrics, pacer: new Pacer(cfg.limits.sendIntervalMs) });
  } else logger.warn({ module: "boot" }, "BOT_TOKEN not set: access can only be managed by the master admin from the userbot account");

  const messenger = new Messenger({ client, cfg, logger, metrics, pacer });
  const registry = new CommandRegistry();
  const confirmations = new ConfirmationManager(cfg.commands.confirmTtlSec);
  const dispatcher = new CommandDispatcher({ cfg, logger, registry, access, confirmations, audit: repos.audit, metrics, queue });
  const scheduler = new Scheduler({ tasks: repos.tasks, queue, cfg, logger, metrics });
  const health = new HealthMonitor({ cfg, logger, metrics, db, queue, scheduler, session, client, bot: bot?.client });
  const plugins = new PluginManager({ registry, scheduler, repo: repos.plugins, settings: repos.settings, audit: repos.audit, messenger, logger, metrics });

  const services: Services = {
    cfg,
    logger,
    ring,
    metrics,
    db,
    repos,
    access,
    queue,
    pacer,
    session,
    client,
    account,
    bot,
    messenger,
    botMessenger,
    media: new MediaService({ cfg, logger, repo: repos.media, fetchers: clientFetchers(client) }),
    stickers: new StickerService(messenger, cfg.paths.exportsDir),
    search: new SearchService({ messenger, archive: repos.archive, settings: repos.settings, cfg, logger }),
    chats: new ChatService(messenger),
    admin: new AdminService(messenger),
    rules: new RuleEngine({ rules: repos.rules, messenger, cfg, logger, metrics }),
    scheduler,
    tasks: new TaskService(repos.tasks),
    translator: new Translator(cfg, messenger),
    ai: new AiService(cfg),
    plugins,
    registry,
    confirmations,
    dispatcher,
    health,
    features,
    deliver: async (via, chat, text) => {
      await (via === "bot" && botMessenger ? botMessenger : messenger).sendText(chat, text);
    },
  };

  registerAllCommands(registry, services);
  registerCoreTaskKinds(services);
  plugins.register(timePlugin, true);
  const external = await plugins.loadDirectory(cfg.paths.pluginsDir);
  await plugins.activateConfigured();
  logger.info({ module: "boot", commands: registry.list().length, plugins: plugins.list().length, externalPlugins: external }, "commands and plugins ready");
  shutdown.register("plugins", () => plugins.shutdown(), 70);

  attachUserbotTransport(services);
  attachBotTransport(services);

  await scheduler.start();
  shutdown.register("scheduler", () => scheduler.stop(), 100);
  health.startWatchdog();
  shutdown.register("watchdog", () => health.stopWatchdog(), 100);
  shutdown.register("queue drain", async () => {
    queue.pause();
    const drained = await queue.drain(10_000);
    if (!drained) logger.warn({ module: "lifecycle" }, "queue did not drain in time");
  }, 80);

  let dashboard: DashboardHandle | undefined;
  if (cfg.dashboard.enabled) {
    dashboard = await startDashboard({ cfg, logger, ring, metrics, queue, health, plugins, repos, scheduler, features, account, registry, access, isConnected: () => client.connected === true, hasBot: Boolean(bot) });
    shutdown.register("dashboard", () => dashboard?.close(), 90);
  }

  logger.info({ module: "boot", masterAdminId: cfg.telegram.masterAdminId, prefix: cfg.commands.prefix }, "userbot is running");
  return { services, dashboard, shutdown, stop: () => shutdown.run() };
}
