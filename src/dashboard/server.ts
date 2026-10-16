import http from "node:http";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { publicConfigView, isLoopbackHost } from "../config";
import type { Services } from "../core/services";
import { LoginThrottle, PasswordVerifier, SessionManager } from "./auth";

export type DashboardDeps = Pick<Services, "cfg" | "logger" | "ring" | "metrics" | "queue" | "health" | "plugins" | "repos" | "scheduler" | "features" | "account" | "registry" | "access"> & {
  isConnected(): boolean;
  hasBot: boolean;
};

export interface DashboardHandle {
  host: string;
  port: number;
  close(): Promise<void>;
}

const COOKIE = "ub_session";
const PUBLIC_DIR = path.join(__dirname, "public");

function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

export function createDashboardApp(d: DashboardDeps): express.Express {
  const cfg = d.cfg;
  const verifier = new PasswordVerifier(cfg.dashboard.password as string);
  const sessions = new SessionManager(cfg.dashboard.sessionMinutes * 60_000);
  const throttle = new LoginThrottle();
  const loopback = isLoopbackHost(cfg.dashboard.host);
  const actorId = cfg.telegram.masterAdminId;

  const app = express();
  app.disable("x-powered-by");

  // Security headers on every response.
  app.use((_req, res, next) => {
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    next();
  });

  // DNS-rebinding protection: only accept expected Host headers. Explicit DASHBOARD_ALLOWED_HOSTS wins;
  // otherwise a loopback bind accepts only loopback names. (A deliberate non-loopback bind without a list is not checked.)
  const allowedHosts = cfg.dashboard.allowedHosts.length ? cfg.dashboard.allowedHosts : loopback ? ["localhost", "127.0.0.1", "[::1]"] : [];
  app.use((req, res, next) => {
    if (allowedHosts.length) {
      const host = (req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
      if (!allowedHosts.includes(host)) {
        res.status(400).type("text").send("Bad host header");
        return;
      }
    }
    next();
  });

  // Liveness probe for container orchestrators: reveals nothing about the account or configuration.
  app.get("/healthz", (_req, res) => void res.type("text").send("ok"));

  app.use(express.json({ limit: "4kb" }));

  const clientKey = (req: Request): string => req.socket.remoteAddress ?? "unknown";

  /* ------------------------------ public: login + static assets ------------------------------ */
  app.post("/login", (req, res) => {
    const key = clientKey(req);
    const wait = throttle.retryAfterSec(key);
    if (wait > 0) {
      res.setHeader("Retry-After", String(wait));
      res.status(429).json({ error: `Too many attempts. Try again in ${wait}s.` });
      return;
    }
    const pw = (req.body as { password?: unknown } | undefined)?.password;
    if (typeof pw !== "string" || pw.length === 0 || pw.length > 256 || !verifier.verify(pw)) {
      throttle.fail(key);
      d.logger.warn({ module: "dashboard", ip: key }, "dashboard login failed");
      res.status(401).json({ error: "Wrong password." });
      return;
    }
    throttle.success(key);
    const { cookie, session } = sessions.create();
    const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
    res.setHeader("Set-Cookie", `${COOKIE}=${encodeURIComponent(cookie)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${cfg.dashboard.sessionMinutes * 60}${secure ? "; Secure" : ""}`);
    res.json({ ok: true, csrf: session.csrf });
  });

  for (const f of ["app.css", "login.js", "login.html"]) app.get(`/${f === "login.html" ? "login" : f}`, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, f), { dotfiles: "deny" }));

  const authed = (req: Request): ReturnType<SessionManager["get"]> => sessions.get(readCookie(req, COOKIE));

  app.get("/", (req, res) => {
    if (!authed(req)) return void res.redirect("/login");
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(path.join(PUBLIC_DIR, "index.html"), { dotfiles: "deny" });
  });
  app.get("/app.js", (req, res) => {
    if (!authed(req)) return void res.status(401).type("text").send("Unauthorized");
    res.sendFile(path.join(PUBLIC_DIR, "app.js"), { dotfiles: "deny" });
  });

  /* ------------------------------ authenticated API ------------------------------ */
  const api = express.Router();
  api.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Cache-Control", "no-store");
    const session = authed(req);
    if (!session) return void res.status(401).json({ error: "Not signed in" });
    if (req.method !== "GET") {
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) return void res.status(403).json({ error: "Cross-origin request refused" });
      if (req.headers["x-csrf-token"] !== session.csrf) return void res.status(403).json({ error: "Missing or wrong CSRF token" });
    }
    res.locals["session"] = session;
    next();
  });

  const limit = (v: unknown, def: number, max: number): number => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? Math.min(n, max) : def;
  };

  api.get("/session", (_req, res) => void res.json({ csrf: (res.locals["session"] as { csrf: string }).csrf }));

  api.post("/logout", (req, res) => {
    sessions.destroy(readCookie(req, COOKIE));
    res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    res.json({ ok: true });
  });

  api.get("/status", (_req, res) => {
    const q = d.queue.stats;
    res.json({
      account: { name: d.account.name, username: d.account.username ?? null },
      masterAdminId: cfg.telegram.masterAdminId,
      connected: d.isConnected(),
      controlBot: d.hasBot,
      uptimeSec: d.metrics.uptimeSec(),
      queue: q,
      metrics: d.metrics.snapshot(),
      library: d.features.library,
      featureSummary: d.features.summary,
      now: Date.now(),
    });
  });

  api.get("/health", async (_req, res) => void res.json(await d.health.check()));

  api.get("/modules", async (_req, res) => {
    const rules = await d.repos.rules.list();
    const users = await d.repos.users.list();
    const media = await d.repos.media.stats();
    res.json({
      modules: [
        { name: "authentication", enabled: true, detail: "user session + optional control bot" },
        { name: "messaging", enabled: true, detail: "paced, retried sending" },
        { name: "chats", enabled: true, detail: "dialogs, mute, archive, folders" },
        { name: "media", enabled: true, detail: `${media.files} file(s) stored` },
        { name: "stickers", enabled: true, detail: "metadata, sets, export" },
        { name: "search", enabled: true, detail: cfg.privacy.storeMessageContent ? "live + opt-in local archive" : "live only (archive off)" },
        { name: "automation", enabled: true, detail: `${rules.filter((r) => r.enabled).length}/${rules.length} rules active; scheduler ${d.scheduler.running ? "running" : "stopped"}` },
        { name: "administration", enabled: true, detail: `${users.filter((u) => u.enabled).length} self-mode user(s)` },
        { name: "ai", enabled: cfg.ai.enabled, detail: cfg.ai.enabled ? cfg.ai.model : "disabled" },
        { name: "translation", enabled: cfg.translate.provider !== "none", detail: cfg.translate.provider },
        { name: "dashboard", enabled: true, detail: `${cfg.dashboard.host}:${cfg.dashboard.port}` },
      ],
      plugins: d.plugins.list(),
      commands: d.registry.list().length,
    });
  });

  api.get("/tasks", async (req, res) => {
    res.json({
      pending: await d.repos.tasks.list({ status: "pending", limit: limit(req.query["limit"], 50, 200) }),
      runs: await d.repos.tasks.recentRuns(limit(req.query["limit"], 50, 200)),
    });
  });

  api.post("/tasks/:id/cancel", async (req, res) => {
    const ok = await d.repos.tasks.cancel(Number(req.params["id"]));
    await d.repos.audit.add({ actorId, action: "dashboard.task.cancel", target: String(req.params["id"]), result: ok ? "ok" : "not-found" });
    res.json({ ok });
  });

  api.get("/logs", (req, res) => {
    const level = typeof req.query["level"] === "string" && ["debug", "info", "warn", "error"].includes(req.query["level"]) ? req.query["level"] : undefined;
    res.json({ entries: d.ring.recent(limit(req.query["limit"], 200, 1000), level) });
  });

  api.get("/settings", async (_req, res) => {
    res.json({ config: publicConfigView(cfg), users: (await d.repos.users.list()).map((u) => ({ userId: u.userId, scopes: u.scopes, enabled: u.enabled, note: u.note ?? null })) });
  });

  api.get("/audit", async (req, res) => void res.json({ entries: await d.repos.audit.recent(limit(req.query["limit"], 50, 200)) }));

  api.post("/plugins/:name/:action", async (req, res) => {
    const { name, action } = req.params as { name: string; action: string };
    try {
      if (action === "enable") await d.plugins.enable(name, actorId);
      else if (action === "disable") await d.plugins.disable(name, actorId);
      else return void res.status(400).json({ error: "Unknown action" });
      res.json({ ok: true, plugins: d.plugins.list() });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.use("/api", api);
  app.use((_req, res) => void res.status(404).type("text").send("Not found"));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    d.logger.error({ module: "dashboard", err: err instanceof Error ? err.message : String(err) }, "dashboard error");
    res.status(500).json({ error: "Internal error" });
  });
  return app;
}

export async function startDashboard(d: DashboardDeps): Promise<DashboardHandle> {
  const { host, port } = d.cfg.dashboard;
  if (!isLoopbackHost(host)) d.logger.warn({ module: "dashboard", host }, "dashboard is bound to a non-loopback address: put it behind TLS (reverse proxy) and a firewall");
  const server = http.createServer(createDashboardApp(d));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  d.logger.info({ module: "dashboard", url: `http://${host}:${actualPort}` }, "dashboard listening");
  return {
    host,
    port: actualPort,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
