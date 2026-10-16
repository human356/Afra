import fs from "node:fs";
import type { Logger } from "pino";
import type { TelegramClient } from "teleproto";
import type { SessionStore } from "../auth/sessionStore";
import type { AppConfig } from "../config";
import type { Metrics } from "../core/metrics";
import type { BoundedQueue } from "../core/queue";
import { sleep } from "../core/retry";
import type { Scheduler } from "../automation/scheduler";
import type { Database } from "../storage/types";

export type CheckStatus = "ok" | "warn" | "fail";
export interface HealthCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}
export interface HealthReport {
  status: "healthy" | "degraded" | "unhealthy";
  checkedAt: number;
  checks: HealthCheck[];
}

export interface HealthDeps {
  cfg: AppConfig;
  logger: Logger;
  metrics: Metrics;
  db: Database;
  queue: BoundedQueue;
  scheduler: Scheduler;
  session: SessionStore;
  client: TelegramClient;
  bot?: TelegramClient;
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e: unknown) => (clearTimeout(t), reject(e)),
    );
  });

/** Health checks + a connection watchdog that reconnects with backoff (the library also reconnects on its own). */
export class HealthMonitor {
  private watchdog: NodeJS.Timeout | undefined;
  private lastApiProbe: { at: number; ok: boolean; detail: string } | undefined;
  private reconnecting = false;

  constructor(private readonly d: HealthDeps) {}

  /** Real API round-trip, cached for 60 s so dashboard polling can't turn into API traffic. */
  private async probeTelegram(): Promise<{ ok: boolean; detail: string }> {
    const now = Date.now();
    if (this.lastApiProbe && now - this.lastApiProbe.at < 60_000) return this.lastApiProbe;
    let result: { ok: boolean; detail: string };
    if (!this.d.client.connected) result = { ok: false, detail: "not connected" };
    else {
      const t0 = Date.now();
      try {
        await withTimeout(this.d.client.getMe(), 8000);
        result = { ok: true, detail: `connected, round-trip ${Date.now() - t0} ms` };
      } catch (err) {
        result = { ok: false, detail: `API call failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    this.lastApiProbe = { at: now, ...result };
    return result;
  }

  async check(): Promise<HealthReport> {
    const checks: HealthCheck[] = [];
    const add = (name: string, status: CheckStatus, detail: string): void => void checks.push({ name, status, detail });

    const tg = await this.probeTelegram();
    add("telegram", tg.ok ? "ok" : "fail", tg.detail);
    if (this.d.bot) add("control bot", this.d.bot.connected ? "ok" : "warn", this.d.bot.connected ? "connected" : "not connected");

    try {
      await withTimeout(this.d.db.ping(), 3000);
      add("database", "ok", this.d.db.dialect);
    } catch (err) {
      add("database", "fail", err instanceof Error ? err.message : String(err));
    }

    const q = this.d.queue.stats;
    add("queue", q.pending > q.maxSize * 0.8 ? "warn" : "ok", `${q.running} running, ${q.pending}/${q.maxSize} pending, ${q.rejected} rejected`);

    const tick = this.d.cfg.automation.tickSec;
    add("scheduler", !this.d.scheduler.running ? "fail" : this.d.scheduler.lagSec > tick * 4 + 10 ? "warn" : "ok", this.d.scheduler.running ? `last tick ${this.d.scheduler.lagSec}s ago` : "stopped");

    const s = this.d.session.info();
    add("session file", !s.exists ? "fail" : s.looseMode ? "warn" : "ok", !s.exists ? "missing" : `${s.encrypted ? "encrypted" : "plaintext (set SESSION_ENCRYPTION_KEY to encrypt)"}${s.looseMode ? ", permissions too open (expected 0600)" : ""}`);

    try {
      const st = await fs.promises.statfs(this.d.cfg.paths.dataDir);
      const freeMb = Math.floor((Number(st.bavail) * Number(st.bsize)) / 1048576);
      add("disk", freeMb < 50 ? "fail" : freeMb < 500 ? "warn" : "ok", `${freeMb} MB free in data dir`);
    } catch {
      add("disk", "warn", "could not read free space");
    }

    const rssMb = Math.round(process.memoryUsage().rss / 1048576);
    add("memory", rssMb > 1024 ? "warn" : "ok", `${rssMb} MB resident`);

    const status = checks.some((c) => c.status === "fail") ? "unhealthy" : checks.some((c) => c.status === "warn") ? "degraded" : "healthy";
    return { status, checkedAt: Date.now(), checks };
  }

  /** Checks the connection every `intervalMs`; if the client is down, reconnects with exponential backoff. */
  startWatchdog(intervalMs = 30_000): void {
    if (this.watchdog) return;
    this.watchdog = setInterval(() => void this.ensureConnected(), intervalMs);
    this.watchdog.unref();
  }

  stopWatchdog(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = undefined;
  }

  async ensureConnected(): Promise<void> {
    if (this.reconnecting || this.d.client.connected) return;
    this.reconnecting = true;
    try {
      for (let attempt = 1; attempt <= 6; attempt++) {
        this.d.logger.warn({ module: "watchdog", attempt }, "Telegram connection is down; reconnecting");
        try {
          await this.d.client.connect();
          this.d.metrics.inc("telegram.reconnects");
          this.lastApiProbe = undefined;
          this.d.logger.info({ module: "watchdog" }, "reconnected");
          return;
        } catch (err) {
          this.d.logger.warn({ module: "watchdog", attempt, err: err instanceof Error ? err.message : String(err) }, "reconnect failed");
          await sleep(Math.min(60_000, 2000 * 2 ** attempt));
        }
      }
      this.d.logger.error({ module: "watchdog" }, "could not reconnect; will retry on the next check");
    } finally {
      this.reconnecting = false;
    }
  }
}
