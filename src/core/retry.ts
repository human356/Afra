import { FloodWaitTooLongError } from "./errors";

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

interface ErrLike {
  name?: string;
  message?: string;
  errorMessage?: string;
  seconds?: number;
  code?: number | string;
}

/** Seconds Telegram asked us to wait (FLOOD_WAIT_x / SLOWMODE_WAIT_x), if this error is a wait request. */
export function floodWaitSeconds(err: unknown): number | undefined {
  const e = (err ?? {}) as ErrLike;
  const text = e.errorMessage ?? e.message ?? "";
  if (typeof e.seconds === "number" && (e.name === "FloodWaitError" || e.name === "SlowModeWaitError" || /FLOOD_WAIT|SLOWMODE_WAIT/.test(text))) return e.seconds;
  const m = /(?:FLOOD_WAIT|SLOWMODE_WAIT)_?(\d+)/.exec(text);
  return m ? Number(m[1]) : undefined;
}

export type ErrorClass = "flood" | "transient" | "fatal";

export function classifyError(err: unknown): ErrorClass {
  if (floodWaitSeconds(err) !== undefined) return "flood";
  const e = (err ?? {}) as ErrLike;
  const text = `${e.name ?? ""} ${e.errorMessage ?? ""} ${e.message ?? ""}`;
  if (/PEER_FLOOD|PeerFloodError|AUTH_KEY|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED|PHONE_NUMBER_BANNED|CHAT_ADMIN_REQUIRED|USER_PRIVACY|FROZEN_METHOD/i.test(text)) return "fatal";
  if (/ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|ENETUNREACH|EAI_AGAIN|TIMEOUT|Timeout|Connection closed|not connected|RpcCallFail|InternalServerError|ServerError|-503|-500|RPC_CALL_FAIL|MSG_WAIT_FAILED/i.test(text)) return "transient";
  if (typeof e.code === "number" && e.code >= 500) return "transient";
  return "fatal";
}

export interface RetryOptions {
  /** Retries after the first attempt. */
  retries: number;
  baseMs?: number;
  maxMs?: number;
  /** Largest FLOOD_WAIT we are willing to sit out automatically. */
  maxFloodWaitSec?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  signal?: AbortSignal;
  onRetry?: (info: { attempt: number; delayMs: number; reason: "flood" | "transient"; error: unknown }) => void;
}

/** Delay for the n-th retry (1-based): exponential with jitter, capped. */
export function backoffDelay(attempt: number, baseMs: number, maxMs: number, random: () => number = Math.random): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

/**
 * Runs `fn`, retrying transient failures with exponential backoff.
 * FloodWait errors are honoured exactly (we wait the requested time, never less) and are never evaded.
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const { retries, baseMs = 500, maxMs = 30_000, maxFloodWaitSec = 900, random = Math.random } = opts;
  const wait = opts.sleep ?? ((ms: number) => sleep(ms, opts.signal));
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      const kind = classifyError(err);
      if (kind === "fatal" || attempt > retries) throw err;
      let delayMs: number;
      if (kind === "flood") {
        const secs = floodWaitSeconds(err) ?? 1;
        if (secs > maxFloodWaitSec) throw new FloodWaitTooLongError(secs, maxFloodWaitSec);
        delayMs = (secs + 1) * 1000 + Math.round(random() * 500);
      } else {
        delayMs = backoffDelay(attempt, baseMs, maxMs, random);
      }
      opts.onRetry?.({ attempt, delayMs, reason: kind, error: err });
      await wait(delayMs);
    }
  }
}
