import type { Logger } from "pino";
import type { Api, TelegramClient } from "teleproto";
import type { AppConfig } from "../config";
import { AppError } from "../core/errors";
import { lib } from "../core/library";
import { SessionStore } from "./sessionStore";

export function buildClient(cfg: AppConfig, sessionString: string): TelegramClient {
  const client = new lib.TelegramClient(new lib.sessions.StringSession(sessionString), cfg.telegram.apiId, cfg.telegram.apiHash, {
    connectionRetries: 10,
    retryDelay: 2000,
    requestRetries: 3,
    autoReconnect: true,
    // Short waits are slept off by the library; longer ones surface to our retry layer (which honours them exactly).
    floodSleepThreshold: 30,
    deviceModel: "tg-userbot",
    appVersion: "1.0.0",
  });
  client.setLogLevel("error" as never);
  return client;
}

const DEAD_SESSION = /AUTH_KEY_UNREGISTERED|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED|AUTH_KEY_INVALID|AuthKey(Unregistered|Invalid)Error|SessionRevokedError|SessionExpiredError/;

export interface UserConnection {
  client: TelegramClient;
  me: Api.User;
}

/** Connects with the stored user session. Never prompts: login is a separate, interactive CLI step. */
export async function connectUser(cfg: AppConfig, store: SessionStore, logger: Logger): Promise<UserConnection> {
  const session = store.load();
  if (!session) throw new AppError("No Telegram session found", "NO_SESSION", "Run `npm run login` once to sign in (or, on a host without a terminal, set WEB_LOGIN=true to sign in from the browser).");
  const client = buildClient(cfg, session);
  try {
    await client.connect();
    if (!(await client.isUserAuthorized())) throw new AppError("The stored session is not authorised", "SESSION_INVALID");
  } catch (err) {
    const text = `${(err as Error).name} ${(err as Error).message}`;
    if (err instanceof AppError || DEAD_SESSION.test(text)) {
      const moved = store.quarantine();
      logger.error({ module: "auth", moved }, "session unusable; moved aside");
      await client.disconnect().catch(() => undefined);
      throw new AppError("The Telegram session is no longer valid", "SESSION_INVALID", "It was moved aside. Run `npm run login` to create a new session.", { cause: err });
    }
    await client.disconnect().catch(() => undefined);
    throw err;
  }
  store.save(client.session.save() as unknown as string);
  const me = (await client.getMe()) as Api.User;
  return { client, me };
}

/** Starts the optional control bot (Bot API token). Reuses its saved session to avoid repeated bot logins. */
export async function connectBot(cfg: AppConfig, store: SessionStore, logger: Logger): Promise<{ client: TelegramClient; me: Api.User }> {
  const token = cfg.telegram.botToken as string;
  const client = buildClient(cfg, store.load() ?? "");
  try {
    await client.start({ botAuthToken: token } as never);
  } catch (err) {
    await client.disconnect().catch(() => undefined);
    throw new AppError("Could not start the control bot", "BOT_START_FAILED", "Check BOT_TOKEN with @BotFather (a revoked token fails here).", { cause: err });
  }
  store.save(client.session.save() as unknown as string);
  const me = (await client.getMe()) as Api.User;
  logger.info({ module: "auth", bot: me.username }, "control bot connected");
  return { client, me };
}
