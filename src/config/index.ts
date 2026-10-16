import path from "node:path";
import { z } from "zod";
import { ConfigError } from "../core/errors";

/** Treat empty strings (e.g. `FOO=` in .env) as "not set". */
const emptyToUndefined = (v: unknown): unknown => (typeof v === "string" && v.trim() === "" ? undefined : v);
const opt = <T extends z.ZodType>(schema: T) => z.preprocess(emptyToUndefined, schema);

const boolish = (def: boolean) =>
  z.preprocess((v) => {
    if (v === undefined) return def;
    if (typeof v === "string") {
      const s = v.trim().toLowerCase();
      if (["1", "true", "yes", "on"].includes(s)) return true;
      if (["0", "false", "no", "off", ""].includes(s)) return false;
    }
    return v;
  }, z.boolean());

const int = (def: number, min: number, max: number) => opt(z.coerce.number().int().min(min).max(max).default(def));

const EnvSchema = z.object({
  TG_API_ID: z.coerce.number().int().positive(),
  TG_API_HASH: z.string().min(16, "looks too short"),
  MASTER_ADMIN_ID: z.coerce.number().int().positive(),
  BOT_TOKEN: opt(z.string().regex(/^\d{5,}:[A-Za-z0-9_-]{30,}$/, "does not look like a BotFather token").optional()),

  DATA_DIR: opt(z.string().optional()),
  PLUGINS_DIR: opt(z.string().default("./plugins")),
  SESSION_ENCRYPTION_KEY: opt(z.string().min(16, "use at least 16 characters").optional()),

  DB_DRIVER: opt(z.enum(["sqlite", "postgres"]).default("sqlite")),
  SQLITE_PATH: opt(z.string().optional()),
  DATABASE_URL: opt(z.string().url().optional()),

  STORE_MESSAGE_CONTENT: boolish(false),

  COMMAND_PREFIX: opt(z.string().min(1).max(3).default(".")),
  DRY_RUN_DEFAULT: boolish(true),
  CONFIRM_TTL_SEC: int(60, 10, 600),

  MAX_CONCURRENCY: int(4, 1, 32),
  QUEUE_MAX_SIZE: int(200, 1, 10_000),
  SEND_INTERVAL_MS: int(1100, 250, 60_000),
  FLOOD_WAIT_MAX_SEC: int(900, 1, 86_400),
  RETRY_ATTEMPTS: int(4, 0, 10),

  DASHBOARD_ENABLED: boolish(true),
  DASHBOARD_HOST: opt(z.string().optional()),
  DASHBOARD_PORT: opt(z.coerce.number().int().min(1).max(65_535).optional()),
  PORT: opt(z.coerce.number().int().min(1).max(65_535).optional()),
  RAILWAY_VOLUME_MOUNT_PATH: opt(z.string().optional()),
  WEB_LOGIN: boolish(false),
  DASHBOARD_PASSWORD: opt(z.string().min(12, "use at least 12 characters").optional()),
  DASHBOARD_SESSION_MIN: int(60, 5, 1440),
  DASHBOARD_ALLOWED_HOSTS: opt(z.string().optional()),

  SCHEDULER_TICK_SEC: int(5, 1, 300),
  SCHEDULER_MAX_LATE_SEC: int(3600, 0, 604_800),
  AUTOREPLY_MAX_PER_CHAT_PER_MIN: int(3, 1, 60),

  MEDIA_NAME_TEMPLATE: opt(z.string().default("{date}_{chat}_{id}_{name}")),
  MEDIA_MAX_DOWNLOAD_MB: int(2048, 1, 4096),

  AI_ENABLED: boolish(false),
  ANTHROPIC_API_KEY: opt(z.string().min(10).optional()),
  AI_MODEL: opt(z.string().default("claude-sonnet-5-5")),
  AI_BASE_URL: opt(z.string().url().default("https://api.anthropic.com")),
  AI_MAX_INPUT_CHARS: int(12_000, 500, 200_000),

  TRANSLATE_PROVIDER: opt(z.enum(["none", "libretranslate", "telegram"]).default("none")),
  TRANSLATE_URL: opt(z.string().url().optional()),
  TRANSLATE_API_KEY: opt(z.string().optional()),

  LOG_LEVEL: opt(z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info")),
});

export interface AppConfig {
  telegram: { apiId: number; apiHash: string; masterAdminId: number; botToken?: string };
  paths: {
    dataDir: string;
    sessionFile: string;
    botSessionFile: string;
    downloadsDir: string;
    exportsDir: string;
    backupsDir: string;
    pluginsDir: string;
  };
  security: { sessionEncryptionKey?: string };
  db: { driver: "sqlite" | "postgres"; sqlitePath: string; databaseUrl?: string };
  privacy: { storeMessageContent: boolean };
  commands: { prefix: string; dryRunDefault: boolean; confirmTtlSec: number };
  limits: { concurrency: number; queueMaxSize: number; sendIntervalMs: number; floodWaitMaxSec: number; retryAttempts: number };
  dashboard: { enabled: boolean; host: string; port: number; password?: string; sessionMinutes: number; allowedHosts: string[] };
  /** One-time browser-based sign-in (for hosts without a terminal). Off by default. */
  webLogin: boolean;
  automation: { tickSec: number; maxLateSec: number; autoReplyPerChatPerMin: number };
  media: { nameTemplate: string; maxDownloadMb: number };
  ai: { enabled: boolean; apiKey?: string; model: string; baseUrl: string; maxInputChars: number };
  translate: { provider: "none" | "libretranslate" | "telegram"; url?: string; apiKey?: string };
  logging: { level: string };
  /** Secret values that must never reach logs or the dashboard. */
  secrets: string[];
}

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(h);
}

/**
 * Parses and validates the environment. Never echoes values in error messages.
 * `lenient` skips the dashboard-password requirement for CLI tools (login, backup, matrix) that do not start it.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd(), opts: { lenient?: boolean } = {}): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => {
      const key = String(i.path[0] ?? "(env)");
      const missing = env[key] === undefined || String(env[key]).trim() === "";
      return `  - ${key}: ${missing ? "required but not set" : i.message}`;
    });
    throw new ConfigError(`Invalid configuration:\n${lines.join("\n")}`, "Copy .env.example to .env and fill in the missing values (see docs/SETUP.md).");
  }
  const e = parsed.data;
  const problems: string[] = [];

  if (e.DB_DRIVER === "postgres" && !e.DATABASE_URL) problems.push("DATABASE_URL is required when DB_DRIVER=postgres");
  if (e.AI_ENABLED && !e.ANTHROPIC_API_KEY) problems.push("ANTHROPIC_API_KEY is required when AI_ENABLED=true");
  if (e.TRANSLATE_PROVIDER === "libretranslate" && !e.TRANSLATE_URL) problems.push("TRANSLATE_URL is required when TRANSLATE_PROVIDER=libretranslate");
  if (e.WEB_LOGIN && !e.DASHBOARD_PASSWORD) problems.push("DASHBOARD_PASSWORD is required when WEB_LOGIN=true (it protects the setup page)");
  if (!opts.lenient && e.DASHBOARD_ENABLED && !e.DASHBOARD_PASSWORD) problems.push("DASHBOARD_PASSWORD is required when DASHBOARD_ENABLED=true (or set DASHBOARD_ENABLED=false)");
  if (/[a-z0-9\s]/i.test(e.COMMAND_PREFIX)) problems.push("COMMAND_PREFIX must be punctuation such as '.' or '!'");
  if (problems.length) {
    throw new ConfigError(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`, "See .env.example for every option.");
  }

  // On hosts like Railway the platform provides the volume path and the public port; use them when not set explicitly.
  const dataDir = path.resolve(cwd, e.DATA_DIR ?? e.RAILWAY_VOLUME_MOUNT_PATH ?? "./data");
  const dashboardHost = e.DASHBOARD_HOST ?? (e.PORT !== undefined ? "0.0.0.0" : "127.0.0.1");
  const secrets = [e.TG_API_HASH, e.BOT_TOKEN, e.SESSION_ENCRYPTION_KEY, e.DASHBOARD_PASSWORD, e.ANTHROPIC_API_KEY, e.TRANSLATE_API_KEY, e.DATABASE_URL].filter(
    (s): s is string => typeof s === "string" && s.length >= 6,
  );

  return {
    telegram: { apiId: e.TG_API_ID, apiHash: e.TG_API_HASH, masterAdminId: e.MASTER_ADMIN_ID, botToken: e.BOT_TOKEN },
    paths: {
      dataDir,
      sessionFile: path.join(dataDir, "session.bin"),
      botSessionFile: path.join(dataDir, "bot-session.bin"),
      downloadsDir: path.join(dataDir, "downloads"),
      exportsDir: path.join(dataDir, "exports"),
      backupsDir: path.join(dataDir, "backups"),
      pluginsDir: path.resolve(cwd, e.PLUGINS_DIR),
    },
    security: { sessionEncryptionKey: e.SESSION_ENCRYPTION_KEY },
    db: { driver: e.DB_DRIVER, sqlitePath: e.SQLITE_PATH ? path.resolve(cwd, e.SQLITE_PATH) : path.join(dataDir, "userbot.sqlite"), databaseUrl: e.DATABASE_URL },
    privacy: { storeMessageContent: e.STORE_MESSAGE_CONTENT },
    commands: { prefix: e.COMMAND_PREFIX, dryRunDefault: e.DRY_RUN_DEFAULT, confirmTtlSec: e.CONFIRM_TTL_SEC },
    limits: {
      concurrency: e.MAX_CONCURRENCY,
      queueMaxSize: e.QUEUE_MAX_SIZE,
      sendIntervalMs: e.SEND_INTERVAL_MS,
      floodWaitMaxSec: e.FLOOD_WAIT_MAX_SEC,
      retryAttempts: e.RETRY_ATTEMPTS,
    },
    dashboard: { enabled: e.DASHBOARD_ENABLED, host: dashboardHost, port: e.DASHBOARD_PORT ?? e.PORT ?? 8787, password: e.DASHBOARD_PASSWORD, sessionMinutes: e.DASHBOARD_SESSION_MIN, allowedHosts: (e.DASHBOARD_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean) },
    webLogin: e.WEB_LOGIN,
    automation: { tickSec: e.SCHEDULER_TICK_SEC, maxLateSec: e.SCHEDULER_MAX_LATE_SEC, autoReplyPerChatPerMin: e.AUTOREPLY_MAX_PER_CHAT_PER_MIN },
    media: { nameTemplate: e.MEDIA_NAME_TEMPLATE, maxDownloadMb: e.MEDIA_MAX_DOWNLOAD_MB },
    ai: { enabled: e.AI_ENABLED, apiKey: e.ANTHROPIC_API_KEY, model: e.AI_MODEL, baseUrl: e.AI_BASE_URL.replace(/\/+$/, ""), maxInputChars: e.AI_MAX_INPUT_CHARS },
    translate: { provider: e.TRANSLATE_PROVIDER, url: e.TRANSLATE_URL, apiKey: e.TRANSLATE_API_KEY },
    logging: { level: e.LOG_LEVEL },
    secrets,
  };
}

/** Config view that is safe to show in the dashboard: no secrets, only operational settings. */
export function publicConfigView(cfg: AppConfig): Record<string, unknown> {
  return {
    controlBotEnabled: Boolean(cfg.telegram.botToken),
    database: cfg.db.driver,
    storeMessageContent: cfg.privacy.storeMessageContent,
    commandPrefix: cfg.commands.prefix,
    dryRunDefault: cfg.commands.dryRunDefault,
    limits: cfg.limits,
    dashboard: { host: cfg.dashboard.host, port: cfg.dashboard.port, sessionMinutes: cfg.dashboard.sessionMinutes, allowedHosts: cfg.dashboard.allowedHosts },
    automation: cfg.automation,
    media: cfg.media,
    ai: { enabled: cfg.ai.enabled, model: cfg.ai.model },
    translate: { provider: cfg.translate.provider },
    sessionEncrypted: Boolean(cfg.security.sessionEncryptionKey),
    logLevel: cfg.logging.level,
  };
}
