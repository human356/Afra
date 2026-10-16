import type { Logger } from "pino";

interface Hook {
  name: string;
  priority: number;
  fn: () => Promise<void> | void;
}

/** Runs registered cleanup hooks (highest priority first) on SIGINT/SIGTERM with an overall timeout. */
export class ShutdownManager {
  private readonly hooks: Hook[] = [];
  private shuttingDown = false;
  private installed = false;

  constructor(
    private readonly logger: Logger,
    private readonly timeoutMs = 15_000,
  ) {}

  register(name: string, fn: () => Promise<void> | void, priority = 0): void {
    this.hooks.push({ name, fn, priority });
  }

  install(exit: (code: number) => void = (c) => process.exit(c)): void {
    if (this.installed) return;
    this.installed = true;
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      process.on(sig, () => {
        this.logger.info({ module: "lifecycle", signal: sig }, "shutdown requested");
        void this.run().then(() => exit(0));
      });
    }
    process.on("unhandledRejection", (reason) => this.logger.error({ module: "lifecycle", err: String(reason) }, "unhandled promise rejection"));
    process.on("uncaughtException", (err) => {
      this.logger.fatal({ module: "lifecycle", err: err.message }, "uncaught exception; shutting down");
      void this.run().then(() => exit(1));
    });
  }

  async run(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const ordered = [...this.hooks].sort((a, b) => b.priority - a.priority);
    const all = (async () => {
      for (const h of ordered) {
        try {
          await h.fn();
          this.logger.debug({ module: "lifecycle", hook: h.name }, "shutdown hook done");
        } catch (err) {
          this.logger.error({ module: "lifecycle", hook: h.name, err: err instanceof Error ? err.message : String(err) }, "shutdown hook failed");
        }
      }
    })();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        this.logger.warn({ module: "lifecycle" }, "shutdown timed out; forcing exit");
        resolve();
      }, this.timeoutMs);
    });
    await Promise.race([all, timeout]);
    if (timer) clearTimeout(timer);
  }
}
