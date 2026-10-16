import crypto from "node:crypto";

/** Password check with scrypt + constant-time comparison. The plain password is never kept after construction. */
export class PasswordVerifier {
  private readonly salt = crypto.randomBytes(16);
  private readonly hash: Buffer;

  constructor(password: string) {
    this.hash = crypto.scryptSync(password, this.salt, 32);
  }

  verify(candidate: string): boolean {
    const h = crypto.scryptSync(candidate, this.salt, 32);
    return crypto.timingSafeEqual(h, this.hash);
  }
}

export interface Session {
  id: string;
  csrf: string;
  expiresAt: number;
}

/** In-memory sessions; cookie value is `<id>.<hmac>`, so forged ids are rejected without a lookup. */
export class SessionManager {
  private readonly secret = crypto.randomBytes(32);
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  private sign(id: string): string {
    return crypto.createHmac("sha256", this.secret).update(id).digest("base64url");
  }

  create(): { cookie: string; session: Session } {
    this.sweep();
    const id = crypto.randomBytes(24).toString("base64url");
    const session: Session = { id, csrf: crypto.randomBytes(24).toString("base64url"), expiresAt: this.now() + this.ttlMs };
    this.sessions.set(id, session);
    return { cookie: `${id}.${this.sign(id)}`, session };
  }

  get(cookie: string | undefined): Session | undefined {
    if (!cookie) return undefined;
    const dot = cookie.lastIndexOf(".");
    if (dot < 1) return undefined;
    const id = cookie.slice(0, dot);
    const sig = Buffer.from(cookie.slice(dot + 1));
    const expected = Buffer.from(this.sign(id));
    if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) return undefined;
    const s = this.sessions.get(id);
    if (!s) return undefined;
    if (s.expiresAt <= this.now()) {
      this.sessions.delete(id);
      return undefined;
    }
    return s;
  }

  destroy(cookie: string | undefined): void {
    const s = this.get(cookie);
    if (s) this.sessions.delete(s.id);
  }

  private sweep(): void {
    const t = this.now();
    for (const [id, s] of this.sessions) if (s.expiresAt <= t) this.sessions.delete(id);
  }
}

/** Throttles failed logins per client address: 5 failures lock that address out for 10 minutes. */
export class LoginThrottle {
  private readonly failures = new Map<string, { count: number; first: number; lockedUntil: number }>();

  constructor(
    private readonly max = 5,
    private readonly windowMs = 10 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Seconds the caller must wait, or 0 if allowed. */
  retryAfterSec(key: string): number {
    const f = this.failures.get(key);
    if (!f) return 0;
    const t = this.now();
    if (f.lockedUntil > t) return Math.ceil((f.lockedUntil - t) / 1000);
    if (t - f.first > this.windowMs) this.failures.delete(key);
    return 0;
  }

  fail(key: string): void {
    const t = this.now();
    const f = this.failures.get(key);
    if (!f || t - f.first > this.windowMs) this.failures.set(key, { count: 1, first: t, lockedUntil: 0 });
    else {
      f.count++;
      if (f.count >= this.max) f.lockedUntil = t + this.windowMs;
    }
  }

  success(key: string): void {
    this.failures.delete(key);
  }
}
