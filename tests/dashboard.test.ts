import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDashboardApp, type DashboardDeps } from "../src/dashboard/server";
import { PasswordVerifier, SessionManager, LoginThrottle } from "../src/dashboard/auth";
import { CommandRegistry } from "../src/commands/registry";
import { AccessControl } from "../src/auth/access";
import { createLogger } from "../src/core/logger";
import { Metrics } from "../src/core/metrics";
import { BoundedQueue } from "../src/core/queue";
import { memDb, BASE_ENV, testConfig } from "./helpers";

const PASSWORD = BASE_ENV["DASHBOARD_PASSWORD"] as string;
let server: http.Server;
let base: string;
let secrets: string[];

beforeAll(async () => {
  const { repos } = await memDb();
  const cfg = testConfig({ SESSION_ENCRYPTION_KEY: "an-encryption-key-for-tests" });
  secrets = cfg.secrets;
  const { logger, ring } = createLogger({ level: "info", secrets: cfg.secrets, destination: { write: () => undefined } });
  logger.info({ module: "test" }, `leak check ${cfg.telegram.apiHash}`);
  const deps = {
    cfg,
    logger,
    ring,
    metrics: new Metrics(),
    queue: new BoundedQueue(1, 5),
    health: { check: async () => ({ status: "healthy", checkedAt: 1, checks: [{ name: "database", status: "ok", detail: "sqlite" }] }) },
    plugins: { list: () => [], enable: async () => undefined, disable: async () => undefined },
    repos,
    scheduler: { running: true, lagSec: 0 },
    features: { library: { name: "teleproto", version: "x" }, features: [], summary: { supported: 1, partial: 0, unavailable: 0 } },
    account: { id: 1, name: "Test", username: "tester" },
    registry: new CommandRegistry(),
    access: new AccessControl(1000, repos.users),
    isConnected: () => true,
    hasBot: true,
  } as unknown as DashboardDeps;
  server = http.createServer(createDashboardApp(deps));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));

async function login(password = PASSWORD): Promise<{ cookie: string; csrf: string; status: number }> {
  const res = await fetch(`${base}/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
  const body = (await res.json()) as { csrf?: string };
  return { cookie: (res.headers.get("set-cookie") ?? "").split(";")[0] as string, csrf: body.csrf ?? "", status: res.status };
}

describe("dashboard security", () => {
  it("requires authentication for pages and API", async () => {
    const root = await fetch(`${base}/`, { redirect: "manual" });
    expect(root.status).toBe(302);
    expect(root.headers.get("location")).toBe("/login");
    expect((await fetch(`${base}/api/status`)).status).toBe(401);
    expect((await fetch(`${base}/api/logs`)).status).toBe(401);
    expect((await fetch(`${base}/app.js`)).status).toBe(401);
    expect((await fetch(`${base}/login`)).status).toBe(200);
  });

  it("sets strict security headers and an HttpOnly SameSite=Strict cookie", async () => {
    const res = await fetch(`${base}/login`);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("content-security-policy")).not.toContain("unsafe-inline");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const l = await fetch(`${base}/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: PASSWORD }) });
    const cookie = l.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
  });

  it("serves data to a signed-in user and never exposes secrets anywhere", async () => {
    const { cookie, csrf } = await login();
    expect(csrf.length).toBeGreaterThan(10);
    let all = "";
    for (const p of ["/api/status", "/api/health", "/api/modules", "/api/tasks", "/api/logs?level=debug", "/api/settings", "/api/audit", "/api/session"]) {
      const res = await fetch(`${base}${p}`, { headers: { cookie } });
      expect(res.status, p).toBe(200);
      all += await res.text();
    }
    for (const s of secrets) expect(all).not.toContain(s);
    expect(all).not.toMatch(/session\.bin|sessionString|api_hash/i);
    expect((await fetch(`${base}/`, { headers: { cookie } })).status).toBe(200);
  });

  it("log view redacts secrets that were logged", async () => {
    const { cookie } = await login();
    const text = await (await fetch(`${base}/api/logs?level=debug&limit=1000`, { headers: { cookie } })).text();
    expect(text).toContain("leak check");
    expect(text).not.toContain(BASE_ENV["TG_API_HASH"] as string);
  });

  it("rejects forged cookies and state changes without the CSRF token", async () => {
    expect((await fetch(`${base}/api/status`, { headers: { cookie: "ub_session=forged.value" } })).status).toBe(401);
    const { cookie, csrf } = await login();
    const noToken = await fetch(`${base}/api/plugins/x/enable`, { method: "POST", headers: { cookie } });
    expect(noToken.status).toBe(403);
    const crossOrigin = await fetch(`${base}/api/plugins/x/enable`, { method: "POST", headers: { cookie, "x-csrf-token": csrf, origin: "http://evil.example" } });
    expect(crossOrigin.status).toBe(403);
    const ok = await fetch(`${base}/api/plugins/x/enable`, { method: "POST", headers: { cookie, "x-csrf-token": csrf } });
    expect(ok.status).toBe(200);
  });

  it("logout invalidates the session", async () => {
    const { cookie, csrf } = await login();
    expect((await fetch(`${base}/api/logout`, { method: "POST", headers: { cookie, "x-csrf-token": csrf } })).status).toBe(200);
    expect((await fetch(`${base}/api/status`, { headers: { cookie } })).status).toBe(401);
  });

  it("rejects requests with a foreign Host header (DNS-rebinding protection)", async () => {
    const port = (server.address() as AddressInfo).port;
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/login", headers: { Host: "evil.example.com" } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(400);
  });

  it("exposes only a content-free liveness probe without authentication", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("enforces DASHBOARD_ALLOWED_HOSTS even when bound to all interfaces", async () => {
    const { repos } = await memDb();
    const cfg = testConfig({ DASHBOARD_HOST: "0.0.0.0", DASHBOARD_ALLOWED_HOSTS: "dash.internal, localhost" });
    expect(cfg.dashboard.allowedHosts).toEqual(["dash.internal", "localhost"]);
    const { logger, ring } = createLogger({ level: "info", secrets: [], destination: { write: () => undefined } });
    const deps = { cfg, logger, ring, metrics: new Metrics(), queue: new BoundedQueue(1, 5), health: {}, plugins: {}, repos, scheduler: {}, features: {}, account: {}, registry: new CommandRegistry(), access: new AccessControl(1, repos.users), isConnected: () => true, hasBot: false } as unknown as DashboardDeps;
    const srv = http.createServer(createDashboardApp(deps));
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as AddressInfo).port;
    const get = (host: string) => new Promise<number>((resolve, reject) => { const req = http.request({ host: "127.0.0.1", port, path: "/healthz", headers: { Host: host } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); }); req.on("error", reject); req.end(); });
    expect(await get("dash.internal")).toBe(200);
    expect(await get("evil.example")).toBe(400);
    srv.closeAllConnections();
    await new Promise<void>((r) => srv.close(() => r()));
  });

  it("locks out an address after repeated wrong passwords (checked last: it affects this client)", async () => {
    let last = 0;
    for (let i = 0; i < 7; i++) last = (await login("wrong password!!")).status;
    expect(last).toBe(429);
    expect((await login()).status).toBe(429); // even the right password is refused during lockout
  });
});

describe("dashboard auth primitives", () => {
  it("password verifier is exact", () => {
    const v = new PasswordVerifier("a-long-password-here");
    expect(v.verify("a-long-password-here")).toBe(true);
    expect(v.verify("a-long-password-herf")).toBe(false);
    expect(v.verify("")).toBe(false);
  });
  it("sessions expire and cookies are signed", () => {
    let now = 0;
    const sm = new SessionManager(1000, () => now);
    const { cookie } = sm.create();
    expect(sm.get(cookie)).toBeDefined();
    expect(sm.get(`${cookie.split(".")[0]}.AAAA`)).toBeUndefined();
    now = 1001;
    expect(sm.get(cookie)).toBeUndefined();
  });
  it("throttle locks after max failures and resets on success", () => {
    let now = 0;
    const t = new LoginThrottle(3, 60_000, () => now);
    t.fail("ip");
    t.fail("ip");
    expect(t.retryAfterSec("ip")).toBe(0);
    t.fail("ip");
    expect(t.retryAfterSec("ip")).toBeGreaterThan(0);
    now = 61_000;
    expect(t.retryAfterSec("ip")).toBe(0);
    t.fail("x");
    t.success("x");
    t.fail("x");
    t.fail("x");
    expect(t.retryAfterSec("x")).toBe(0);
  });
});
