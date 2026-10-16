import type { Logger } from "pino";
import type { AppConfig } from "../config";
import { UsageError, userMessage } from "../core/errors";
import type { Metrics } from "../core/metrics";
import type { BoundedQueue } from "../core/queue";
import { backoffDelay } from "../core/retry";
import type { TaskRow, TasksRepo } from "../storage/repositories";

export const MIN_REPEAT_SEC = 60;
export const MAX_PENDING_PER_USER = 50;

export interface TaskContext {
  /** How many seconds after its due time the task actually started. */
  lateSec: number;
}
export type TaskHandler = (task: TaskRow, ctx: TaskContext) => Promise<void>;

interface KindEntry {
  handler: TaskHandler;
  owner: string;
  /** If false, a one-off task that is later than SCHEDULER_MAX_LATE_SEC is marked missed instead of run. */
  runIfLate: boolean;
}

export interface SchedulerDeps {
  tasks: TasksRepo;
  queue: BoundedQueue;
  cfg: AppConfig;
  logger: Logger;
  metrics: Metrics;
  now?: () => number;
}

const MAX_ATTEMPTS = 3;

/** Persistent scheduler: due tasks are claimed atomically, run through the bounded queue, retried with backoff. */
export class Scheduler {
  private readonly kinds = new Map<string, KindEntry>();
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;
  private lastTickAt = 0;
  private readonly now: () => number;

  constructor(private readonly d: SchedulerDeps) {
    this.now = d.now ?? Date.now;
  }

  registerKind(kind: string, handler: TaskHandler, opts: { owner?: string; runIfLate?: boolean } = {}): void {
    this.kinds.set(kind, { handler, owner: opts.owner ?? "core", runIfLate: opts.runIfLate ?? false });
  }
  unregisterOwner(owner: string): void {
    for (const [k, v] of this.kinds) if (v.owner === owner) this.kinds.delete(k);
  }
  kindNames(): string[] {
    return [...this.kinds.keys()];
  }

  async start(): Promise<void> {
    const recovered = await this.d.tasks.recoverStuck();
    if (recovered) this.d.logger.warn({ module: "scheduler", recovered }, "recovered tasks interrupted by a previous shutdown");
    this.timer = setInterval(() => void this.tick().catch((e: unknown) => this.d.logger.error({ module: "scheduler", err: String(e) }, "tick failed")), this.d.cfg.automation.tickSec * 1000);
    this.timer.unref();
    this.d.logger.info({ module: "scheduler", tickSec: this.d.cfg.automation.tickSec }, "scheduler started");
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Seconds since the last tick (health check). */
  get lagSec(): number {
    return this.lastTickAt ? Math.round((this.now() - this.lastTickAt) / 1000) : 0;
  }
  get running(): boolean {
    return this.timer !== undefined;
  }

  /** Runs every due task once. Exposed for tests and for the interval timer. */
  async tick(): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    try {
      this.lastTickAt = this.now();
      const due = await this.d.tasks.due(this.now(), 20);
      const jobs: Array<Promise<void>> = [];
      for (const task of due) {
        if (!(await this.d.tasks.claim(task.id))) continue;
        jobs.push(this.d.queue.add(`task:${task.kind}:${task.id}`, () => this.runTask(task)).catch(() => undefined));
      }
      await Promise.all(jobs);
      return jobs.length;
    } finally {
      this.ticking = false;
    }
  }

  private nextOccurrence(task: TaskRow): number {
    const step = (task.repeatSec as number) * 1000;
    const now = this.now();
    return task.runAt + Math.max(1, Math.ceil((now - task.runAt + 1) / step)) * step;
  }

  private async runTask(task: TaskRow): Promise<void> {
    const t0 = this.now();
    const lateSec = Math.max(0, Math.round((t0 - task.runAt) / 1000));
    const kind = this.kinds.get(task.kind);
    const runId = await this.d.tasks.startRun(task.id, lateSec);

    const finishRepeatOrDone = async (ok: boolean, error?: string): Promise<void> => {
      if (task.repeatSec) await this.d.tasks.setState(task.id, { status: "pending", runAt: this.nextOccurrence(task), attempts: 0, lastRunAt: t0, lastError: error ?? null });
      else await this.d.tasks.setState(task.id, { status: ok ? "done" : "failed", lastRunAt: t0, lastError: error ?? null });
    };

    if (!kind) {
      await this.d.tasks.finishRun(runId, "error", `no handler for kind "${task.kind}"`);
      await this.d.tasks.setState(task.id, { status: "failed", lastError: `no handler for kind "${task.kind}" (plugin disabled?)` });
      return;
    }
    if (!task.repeatSec && !kind.runIfLate && lateSec > this.d.cfg.automation.maxLateSec) {
      const msg = `missed: ${lateSec}s late (limit ${this.d.cfg.automation.maxLateSec}s)`;
      await this.d.tasks.finishRun(runId, "error", msg);
      await finishRepeatOrDone(false, msg);
      this.d.metrics.inc("tasks.missed");
      return;
    }

    try {
      await kind.handler(task, { lateSec });
      await this.d.tasks.finishRun(runId, "ok");
      await finishRepeatOrDone(true);
      this.d.metrics.inc("tasks.ok");
    } catch (err) {
      const msg = userMessage(err).slice(0, 300);
      await this.d.tasks.finishRun(runId, "error", msg);
      this.d.metrics.inc("tasks.errors");
      // `task` was read before claim() incremented the counter, so this run is attempt number task.attempts + 1.
      const attempt = task.attempts + 1;
      this.d.logger.warn({ module: "scheduler", taskId: task.id, kind: task.kind, attempt, err: msg }, "task failed");
      if (attempt < MAX_ATTEMPTS) {
        await this.d.tasks.setState(task.id, { status: "pending", runAt: this.now() + backoffDelay(attempt, 5000, 300_000), lastError: msg });
      } else {
        await finishRepeatOrDone(false, msg);
      }
    }
  }
}

/** Validation + creation of tasks, shared by commands and plugins. */
export class TaskService {
  constructor(private readonly tasks: TasksRepo, private readonly now: () => number = Date.now) {}

  async create(t: { ownerId: number; kind: string; name: string; payload: Record<string, unknown>; when: Date; repeatSec?: number; maxPending?: number }): Promise<number> {
    if (t.when.getTime() < this.now() - 1000) throw new UsageError("That time is in the past");
    if (t.repeatSec !== undefined && t.repeatSec < MIN_REPEAT_SEC) throw new UsageError(`Repeats must be at least ${MIN_REPEAT_SEC}s apart`, "This keeps scheduled activity well inside Telegram's limits.");
    const pending = await this.tasks.list({ ownerId: t.ownerId, status: "pending", limit: 1000 });
    if (pending.length >= (t.maxPending ?? MAX_PENDING_PER_USER)) throw new UsageError(`Too many pending tasks (${pending.length}); cancel some first`);
    return this.tasks.create({ ownerId: t.ownerId, kind: t.kind, name: t.name, payload: t.payload, runAt: t.when.getTime(), repeatSec: t.repeatSec });
  }
}
