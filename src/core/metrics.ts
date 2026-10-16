/** Tiny in-process counters surfaced in the dashboard and health checks. */
export class Metrics {
  private readonly counters = new Map<string, number>();
  readonly startedAt = Date.now();

  inc(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }
  get(name: string): number {
    return this.counters.get(name) ?? 0;
  }
  snapshot(): Record<string, number> {
    return Object.fromEntries([...this.counters.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }
  uptimeSec(): number {
    return Math.floor((Date.now() - this.startedAt) / 1000);
  }
}
