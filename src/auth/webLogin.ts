import http from "node:http";
import path from "node:path";
import type { Logger } from "pino";
import express, { type NextFunction, type Request, type Response } from "express";
import type { AppConfig } from "../config";
import { LoginThrottle, PasswordVerifier, SessionManager } from "../dashboard/auth";
import { AppError, userMessage } from "../core/errors";
import { interactiveLogin, type LoginIO, type LoginStep } from "./login";
import type { SessionStore } from "./sessionStore";

export type SetupStep = "idle" | LoginStep | "working" | "done" | "error";

export interface SetupState {
  step: SetupStep;
  error?: string;
  account?: string;
  attemptsLeft: number;
}

type LoginFn = (io: LoginIO) => Promise<{ id?: unknown; username?: string | null; firstName?: string | null } | void>;

export interface WebSetupDeps {
  cfg: AppConfig;
  store: SessionStore;
  logger: Logger;
  /** Replaceable in tests; defaults to the real interactive Telegram sign-in. */
  login?: LoginFn;
  timeoutMs?: number;
}

export interface WebSetupHandle {
  /** Resolves when the session has been saved. Rejects (code SETUP_TIMEOUT) if nobody finished in time. */
  done: Promise<void>;
  port: number;
  close(): Promise<void>;
}

const PUBLIC_DIR = path.join(__dirname, "..", "dashboard", "public");
const COOKIE = "ub_setup";
const MAX_LOGIN_ATTEMPTS = 5;

/** Bridges the terminal-style LoginIO prompts to HTTP: each prompt becomes a pending step the page fills in. */
class WebLoginIO implements LoginIO {
  step: SetupStep = "idle";
  notice: string | undefined;
  private resolver: ((v: string) => void) | undefined;

  private wait(kind: LoginStep): Promise<string> {
    this.step = kind;
    return new Promise<string>((resolve) => {
      this.resolver = resolve;
    });
  }
  ask(_q: string, kind: LoginStep = "phone"): Promise<string> {
    return this.wait(kind);
  }
  askSecret(_q: string, kind: LoginStep = "code"): Promise<string> {
    return this.wait(kind);
  }
  print(line: string): void {
    this.notice = line;
  }
  submit(value: string): boolean {
    const r = this.resolver;
    if (!r) return false;
    this.resolver = undefined;
    this.step = "working";
    r(value);
    return true;
  }
}

const VALIDATORS: Partial<Record<LoginStep, (v: string) => boolean>> = {
  phone: (v) => /^\+?\d{6,16}$/.test(v),
  code: (v) => /^\d{4,8}$/.test(v),
  password: (v) => v.length <= 256,
};

/**
 * One-time, browser-based sign-in for hosts that give no terminal (e.g. Railway). Only started when WEB_LOGIN=true and
 * no session exists. Protected by the dashboard password; the phone number, login code and 2FA password are passed
 * straight to Telegram and are never logged or stored. After the session is saved the server is closed by the caller.
 */
export async function startWebSetup(deps: WebSetupDeps): Promise<WebSetupHandle> {
  const { cfg, store, logger } = deps;
  const login: LoginFn = deps.login ?? ((io) => interactiveLogin(cfg, store, io));
  const verifier = new PasswordVerifier(cfg.dashboard.password as string);
  const sessions = new SessionManager(30 * 60_000);
  const throttle = new LoginThrottle();

  let io = new WebLoginIO();
  let attemptsLeft = MAX_LOGIN_ATTEMPTS;
  const state: SetupState = { step: "idle", attemptsLeft };
  let finish!: () => void;
  let abort!: (e: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    finish = resolve;
    abort = reject;
  });
  done.catch(() => undefined);

  const begin = (): void => {
    io = new WebLoginIO();
    attemptsLeft--;
    state.error = undefined;
    state.attemptsLeft = attemptsLeft;
    login(io).then(
      (me) => {
        state.step = "done";
        state.account = me ? [me.firstName, me.username ? `@${me.username}` : ""].filter(Boolean).join(" ") || undefined : undefined;
        logger.info({ module: "setup" }, "web sign-in completed; session saved");
        finish();
      },
      (err: unknown) => {
        state.step = "error";
        state.error = io.notice ?? userMessage(err);
        logger.warn({ module: "setup", err: err instanceof Error ? err.name : "error" }, "web sign-in failed");
      },
    );
  };
  begin();

  const app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use(express.json({ limit: "2kb" }));

  const cookieOf = (req: Request): string | undefined => {
    for (const part of (req.headers.cookie ?? "").split(";")) {
      const i = part.indexOf("=");
      if (i > 0 && part.slice(0, i).trim() === COOKIE) return decodeURIComponent(part.slice(i + 1).trim());
    }
    return undefined;
  };
  const clientKey = (req: Request): string => req.socket.remoteAddress ?? "unknown";

  app.get("/healthz", (_req, res) => void res.type("text").send("ok"));
  app.get("/", (_req, res) => void res.redirect("/setup"));
  app.get("/setup", (_req, res) => void res.sendFile(path.join(PUBLIC_DIR, "setup.html"), { dotfiles: "deny" }));
  app.get("/setup.js", (_req, res) => void res.sendFile(path.join(PUBLIC_DIR, "setup.js"), { dotfiles: "deny" }));
  app.get("/app.css", (_req, res) => void res.sendFile(path.join(PUBLIC_DIR, "app.css"), { dotfiles: "deny" }));

  app.post("/setup/auth", (req, res) => {
    const key = clientKey(req);
    const wait = throttle.retryAfterSec(key);
    if (wait > 0) {
      res.setHeader("Retry-After", String(wait));
      return void res.status(429).json({ error: `Too many attempts. Try again in ${wait}s.` });
    }
    const pw = (req.body as { password?: unknown } | undefined)?.password;
    if (typeof pw !== "string" || !pw || pw.length > 256 || !verifier.verify(pw)) {
      throttle.fail(key);
      logger.warn({ module: "setup", ip: key }, "setup page: wrong password");
      return void res.status(401).json({ error: "Wrong password." });
    }
    throttle.success(key);
    const { cookie, session } = sessions.create();
    const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
    res.setHeader("Set-Cookie", `${COOKIE}=${encodeURIComponent(cookie)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=1800${secure ? "; Secure" : ""}`);
    res.json({ ok: true, csrf: session.csrf });
  });

  const guard = (req: Request, res: Response, next: NextFunction): void => {
    const session = sessions.get(cookieOf(req));
    if (!session) return void res.status(401).json({ error: "Not signed in" });
    if (req.method !== "GET") {
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) return void res.status(403).json({ error: "Cross-origin request refused" });
      if (req.headers["x-csrf-token"] !== session.csrf) return void res.status(403).json({ error: "Missing or wrong CSRF token" });
    }
    next();
  };

  app.get("/setup/state", guard, (_req, res) => {
    const step = state.step === "error" || state.step === "done" ? state.step : io.step;
    res.json({ step, error: state.error, account: state.account, attemptsLeft });
  });

  app.post("/setup/submit", guard, (req, res) => {
    const value = (req.body as { value?: unknown } | undefined)?.value;
    const step = io.step;
    const validate = VALIDATORS[step as LoginStep];
    if (typeof value !== "string" || !validate) return void res.status(409).json({ error: "Nothing is waiting for input right now." });
    const clean = step === "phone" ? value.replace(/[\s()-]/g, "") : value.trim();
    if (!validate(clean)) return void res.status(400).json({ error: step === "phone" ? "Use the international format, e.g. +491701234567." : step === "code" ? "The code is 4–8 digits." : "Invalid input." });
    res.json({ ok: io.submit(step === "password" ? value : clean) });
  });

  app.post("/setup/retry", guard, (_req, res) => {
    if (state.step !== "error") return void res.status(409).json({ error: "Nothing to retry." });
    if (attemptsLeft <= 0) return void res.status(429).json({ error: "Too many failed attempts. Restart the service to try again." });
    state.step = "idle";
    begin();
    res.json({ ok: true });
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.dashboard.port, cfg.dashboard.host, () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : cfg.dashboard.port;
  logger.warn({ module: "setup", host: cfg.dashboard.host, port }, "WEB_LOGIN setup page is open — finish signing in, then remove WEB_LOGIN");

  const timer = setTimeout(() => abort(new AppError("Setup was not completed in time", "SETUP_TIMEOUT", "Redeploy/restart the service to open the setup page again.")), deps.timeoutMs ?? 30 * 60_000);
  timer.unref();
  void done.finally(() => clearTimeout(timer)).catch(() => undefined);

  return {
    done,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
