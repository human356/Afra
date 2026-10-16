import crypto from "node:crypto";

export interface PendingAction {
  userId: number;
  action: string;
  target?: string;
  preview: string;
  details?: unknown;
  run: () => Promise<string>;
}

/** Short-lived, single-use confirmation tokens for destructive actions. Bound to the user who requested them. */
export class ConfirmationManager {
  private readonly pending = new Map<string, PendingAction & { expiresAt: number }>();

  constructor(
    private readonly ttlSec: number,
    private readonly now: () => number = Date.now,
  ) {}

  create(p: PendingAction): { token: string; expiresAt: number } {
    this.sweep();
    let token = crypto.randomBytes(3).toString("hex");
    while (this.pending.has(token)) token = crypto.randomBytes(3).toString("hex");
    const expiresAt = this.now() + this.ttlSec * 1000;
    this.pending.set(token, { ...p, expiresAt });
    return { token, expiresAt };
  }

  /** Returns the pending action once (and removes it) if the token is valid, unexpired, and belongs to `userId`. */
  take(userId: number, token: string): PendingAction | undefined {
    this.sweep();
    const p = this.pending.get(token.toLowerCase());
    if (!p || p.userId !== userId) return undefined;
    this.pending.delete(token.toLowerCase());
    return p;
  }

  cancelAll(userId: number): number {
    let n = 0;
    for (const [t, p] of this.pending) {
      if (p.userId !== userId) continue;
      this.pending.delete(t);
      n++;
    }
    return n;
  }

  get size(): number {
    this.sweep();
    return this.pending.size;
  }

  private sweep(): void {
    const t = this.now();
    for (const [token, p] of this.pending) if (p.expiresAt <= t) this.pending.delete(token);
  }
}
