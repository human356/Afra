import { QueueFullError } from "./errors";
import { sleep } from "./retry";

export interface QueueStats {
  running: number;
  pending: number;
  completed: number;
  failed: number;
  rejected: number;
  concurrency: number;
  maxSize: number;
}

interface Job {
  name: string;
  run: () => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

/** Async task queue with a concurrency limit and a hard cap on pending work (back-pressure). */
export class BoundedQueue {
  private readonly pending: Job[] = [];
  private running = 0;
  private completed = 0;
  private failed = 0;
  private rejected = 0;
  private paused = false;
  private idleWaiters: Array<() => void> = [];

  constructor(
    private readonly concurrency: number,
    private readonly maxSize: number,
    private readonly onError?: (name: string, err: unknown) => void,
  ) {}

  add<T>(name: string, run: () => Promise<T>): Promise<T> {
    if (this.pending.length >= this.maxSize) {
      this.rejected++;
      return Promise.reject(new QueueFullError(name));
    }
    return new Promise<T>((resolve, reject) => {
      this.pending.push({ name, run, resolve: resolve as (v: unknown) => void, reject });
      this.pump();
    });
  }

  private pump(): void {
    while (!this.paused && this.running < this.concurrency && this.pending.length > 0) {
      const job = this.pending.shift() as Job;
      this.running++;
      job
        .run()
        .then((v) => {
          this.completed++;
          job.resolve(v);
        })
        .catch((e: unknown) => {
          this.failed++;
          this.onError?.(job.name, e);
          job.reject(e);
        })
        .finally(() => {
          this.running--;
          this.pump();
          this.notifyIdle();
        });
    }
  }

  private notifyIdle(): void {
    if (this.running === 0 && this.pending.length === 0) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const w of waiters) w();
    }
  }

  pause(): void {
    this.paused = true;
  }
  resume(): void {
    this.paused = false;
    this.pump();
  }

  /** Resolves true when nothing is running or pending, or false after `timeoutMs`. */
  async drain(timeoutMs = 10_000): Promise<boolean> {
    if (this.running === 0 && this.pending.length === 0) return true;
    let timedOut = false;
    await Promise.race([
      new Promise<void>((r) => this.idleWaiters.push(r)),
      sleep(timeoutMs).then(() => {
        timedOut = true;
      }),
    ]);
    return !timedOut;
  }

  get stats(): QueueStats {
    return { running: this.running, pending: this.pending.length, completed: this.completed, failed: this.failed, rejected: this.rejected, concurrency: this.concurrency, maxSize: this.maxSize };
  }
}

/** Enforces a minimum spacing between actions (per key) so bulk operations stay well within Telegram limits. */
export class Pacer {
  private readonly nextAt = new Map<string, number>();
  constructor(
    private readonly intervalMs: number,
    private readonly now: () => number = Date.now,
    private readonly delay: (ms: number) => Promise<void> = (ms) => sleep(ms),
  ) {}

  async wait(key = "global"): Promise<void> {
    const t = this.now();
    const at = Math.max(this.nextAt.get(key) ?? 0, t);
    this.nextAt.set(key, at + this.intervalMs);
    if (at > t) await this.delay(at - t);
  }
}
