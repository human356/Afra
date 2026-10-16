/** Base class for errors the app raises on purpose; carries recovery guidance. */
export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string = "APP_ERROR",
    public readonly hint?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}
export class ConfigError extends AppError {
  constructor(message: string, hint?: string) {
    super(message, "CONFIG_INVALID", hint);
  }
}
export class PermissionError extends AppError {
  constructor(message: string, hint?: string) {
    super(message, "PERMISSION_DENIED", hint);
  }
}
export class FeatureUnavailableError extends AppError {
  constructor(feature: string, detail?: string) {
    super(`Feature "${feature}" is not available${detail ? `: ${detail}` : ""}`, "FEATURE_UNAVAILABLE", "Check docs/FEATURE_MATRIX.md for the supported feature list.");
  }
}
export class QueueFullError extends AppError {
  constructor(name: string) {
    super(`Task queue is full; rejected "${name}"`, "QUEUE_FULL", "Wait for running work to finish, or raise QUEUE_MAX_SIZE.");
  }
}
export class UsageError extends AppError {
  constructor(message: string, hint?: string) {
    super(message, "USAGE", hint);
  }
}
export class FloodWaitTooLongError extends AppError {
  constructor(
    public readonly seconds: number,
    max: number,
  ) {
    super(`Telegram asked to wait ${seconds}s (limit ${max}s); not retrying automatically`, "FLOOD_WAIT_TOO_LONG", "Try again later. Telegram rate limits are never bypassed by this tool.");
  }
}

interface RpcLike {
  name?: string;
  message?: string;
  errorMessage?: string;
  seconds?: number;
  code?: number;
}

/** Turns any thrown value into a short, actionable message that is safe to show in chat. */
export function userMessage(err: unknown): string {
  if (err instanceof AppError) return err.hint ? `${err.message}\n↳ ${err.hint}` : err.message;
  const e = (err ?? {}) as RpcLike;
  const rpc = (e.errorMessage ?? e.message ?? "").toString();
  const name = e.name ?? "";
  if (name === "FloodWaitError" || /^FLOOD_WAIT/.test(rpc)) return `Telegram rate limit: wait ${e.seconds ?? "a few"}s before trying again.`;
  if (name === "PeerFloodError" || /PEER_FLOOD/.test(rpc)) return "Telegram limited this account's outgoing contact attempts (PEER_FLOOD). Stop sending and wait; check @SpamBot for status.";
  if (/CHAT_ADMIN_REQUIRED|CHAT_WRITE_FORBIDDEN|USER_NOT_PARTICIPANT/.test(rpc)) return "The account lacks the rights for that action in this chat.";
  if (/USER_PRIVACY_RESTRICTED|PRIVACY/.test(rpc)) return "That user's privacy settings do not allow this action.";
  if (/MESSAGE_ID_INVALID|MESSAGE_NOT_MODIFIED/.test(rpc)) return `Telegram rejected the message reference (${rpc}).`;
  if (/AUTH_KEY_UNREGISTERED|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED/.test(rpc))
    return "The Telegram session is no longer valid. Run `npm run login` again to create a new one.";
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|TIMEOUT/i.test(rpc)) return "Network problem while talking to Telegram; the client will reconnect automatically.";
  if (/Cannot find any entity|Could not find the input entity/i.test(rpc)) return "Could not resolve that chat or user. Use a numeric ID, @username, or a chat the account has seen.";
  return `Unexpected error: ${rpc || name || "unknown"}`;
}
