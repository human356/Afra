import fs from "node:fs";
import path from "node:path";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { SessionStore } from "../src/auth/sessionStore";
import { startWebSetup, type WebSetupHandle } from "../src/auth/webLogin";
import type { LoginIO } from "../src/auth/login";
import { loadConfig } from "../src/config";
import { BASE_ENV, testConfig, tmpDir } from "./helpers";

const PASSWORD = BASE_ENV["DASHBOARD_PASSWORD"] as string;

async function setup(login: (io: LoginIO, store: SessionStore) => Promise<unknown>, extra: { timeoutMs?: number } = {}) {
  const dir = tmpDir();
  const cfg = testConfig({ WEB_LOGIN: "true", DASHBOARD_HOST: "127.0.0.1" }, dir);
  cfg.dashboard.port = 0;
  const store = new SessionStore(cfg.paths.sessionFile, cfg.security.sessionEncryptionKey);
  const logs: string[] = [];
  const logger = pino({ level: "debug" }, { write: (s: string) => void logs.push(s) });
  const h: WebSetupHandle = await startWebSetup({ cfg, store, logger, login: (io) => login(io, store) as never, timeoutMs: extra.timeoutMs });
  const base = `http://127.0.0.1:${h.port}`;
  const auth = async (pw = PASSWORD) => {
    const res = await fetch(`${base}/setup/auth`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: pw }) });
    const body = (await res.json()) as { csrf?: string };
    return { status: res.status, cookie: (res.headers.get("set-cookie") ?? "").split(";")[0] as string, csrf: body.csrf ?? "" };
  };
  const api = (s: { cookie: string; csrf: string }) => ({
    state: async () => (await (await fetch(`${base}/setup/state`, { headers: { cookie: s.cookie } })).json()) as { step: string; error?: string; account?: string; attemptsLeft: number },
    submit: (value: unknown, csrf = s.csrf) => fetch(`${base}/setup/submit`, { method: "POST", headers: { "content-type": "application/json", cookie: s.cookie, "x-csrf-token": csrf }, body: JSON.stringify({ value }) }),
    retry: () => fetch(`${base}/setup/retry`, { method: "POST", headers: { "content-type": "application/json", cookie: s.cookie, "x-csrf-token": s.csrf }, body: "{}" }),
  });
  const until = async (fn: () => Promise<boolean>) => { for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 10)); } throw new Error("condition not reached"); };
  return { h, base, store, cfg, logs, auth, api, until, close: () => h.close() };
}

describe("web setup (one-time sign-in without a terminal)", () => {
  it("is protected by the dashboard password, with lockout", async () => {
    const t = await setup(async () => new Promise(() => undefined));
    expect((await fetch(`${t.base}/setup/state`)).status).toBe(401);
    expect((await t.auth("nope")).status).toBe(401);
    expect((await fetch(`${t.base}/setup`)).status).toBe(200); // the static form is public; it contains no data
    for (let i = 0; i < 5; i++) await t.auth("nope");
    expect((await t.auth()).status).toBe(429);
    await t.close();
  });

  it("walks phone → code → done, saves the session (0600), and resolves", async () => {
    const seen: string[] = [];
    const t = await setup(async (io, store) => {
      seen.push(await io.ask("q", "phone"));
      seen.push(await io.askSecret("q", "code"));
      store.save("SESSION-STRING-VALUE");
      return { id: 7, firstName: "Ann", username: "ann" };
    });
    const s = await t.auth();
    const api = t.api(s);
    await t.until(async () => (await api.state()).step === "phone");

    expect((await api.submit("12ab")).status).toBe(400); // rejected, nothing advanced
    expect((await api.state()).step).toBe("phone");
    expect((await api.submit("+49 (170) 123-4567")).status).toBe(200);
    await t.until(async () => (await api.state()).step === "code");
    expect((await api.submit("12")).status).toBe(400);
    expect((await api.submit("12345")).status).toBe(200);

    await t.h.done;
    expect(seen).toEqual(["+491701234567", "12345"]);
    const st = await api.state();
    expect(st).toMatchObject({ step: "done", account: "Ann @ann" });
    expect(t.store.load()).toBe("SESSION-STRING-VALUE");
    expect(fs.statSync(t.cfg.paths.sessionFile).mode & 0o077).toBe(0);
    await t.close();
  });

  it("asks for the two-step password when Telegram needs it, passing it unmodified", async () => {
    let got = "";
    const t = await setup(async (io, store) => {
      await io.ask("q", "phone");
      await io.askSecret("q", "code");
      got = await io.askSecret("q", "password");
      store.save("S");
      return { id: 1 };
    });
    const s = await t.auth();
    const api = t.api(s);
    await t.until(async () => (await api.state()).step === "phone");
    await api.submit("+4915112345678");
    await t.until(async () => (await api.state()).step === "code");
    await api.submit("123456");
    await t.until(async () => (await api.state()).step === "password");
    await api.submit("  pa ss word  ");
    await t.h.done;
    expect(got).toBe("  pa ss word  ");
    await t.close();
  });

  it("shows an error, lets the user retry, and stops retrying after 5 attempts", async () => {
    let attempts = 0;
    const t = await setup(async (io) => {
      attempts++;
      await io.ask("q", "phone");
      throw Object.assign(new Error("x"), { errorMessage: "PHONE_NUMBER_INVALID" });
    });
    const s = await t.auth();
    const api = t.api(s);
    for (let i = 1; i <= 5; i++) {
      await t.until(async () => (await api.state()).step === "phone");
      await api.submit("+4915112345678");
      await t.until(async () => (await api.state()).step === "error");
      expect((await api.state()).error).toBeTruthy();
      if (i < 5) expect((await api.retry()).status).toBe(200);
    }
    expect((await api.retry()).status).toBe(429);
    expect(attempts).toBe(5);
    await t.close();
  });

  it("requires the CSRF token and refuses input when nothing is waiting", async () => {
    const t = await setup(async (io) => { await io.ask("q", "phone"); });
    const s = await t.auth();
    const api = t.api(s);
    await t.until(async () => (await api.state()).step === "phone");
    expect((await api.submit("+4915112345678", "wrong")).status).toBe(403);
    expect((await api.state()).step).toBe("phone");
    await api.submit("+4915112345678");
    await t.until(async () => (await api.state()).step === "working" || (await api.state()).step === "done");
    expect((await api.submit("+4915112345678")).status).toBe(409);
    await t.close();
  });

  it("never logs or returns the phone number, code or password", async () => {
    const t = await setup(async (io) => {
      await io.ask("q", "phone");
      await io.askSecret("q", "code");
      await io.askSecret("q", "password");
      throw new Error("failed after prompts");
    });
    const s = await t.auth();
    const api = t.api(s);
    const responses: string[] = [];
    await t.until(async () => (await api.state()).step === "phone");
    responses.push(await (await api.submit("+4915198765432")).text());
    await t.until(async () => (await api.state()).step === "code");
    responses.push(await (await api.submit("987654")).text());
    await t.until(async () => (await api.state()).step === "password");
    responses.push(await (await api.submit("my-2fa-secret")).text());
    await t.until(async () => (await api.state()).step === "error");
    responses.push(JSON.stringify(await api.state()));
    const everything = [...responses, ...t.logs].join("\n");
    for (const secret of ["+4915198765432", "4915198765432", "987654", "my-2fa-secret"]) expect(everything).not.toContain(secret);
    await t.close();
  });

  it("gives up cleanly when nobody finishes the setup in time", async () => {
    const t = await setup(async () => new Promise(() => undefined), { timeoutMs: 60 });
    await expect(t.h.done).rejects.toMatchObject({ code: "SETUP_TIMEOUT" });
    await t.close();
  });

  it("the static page is bilingual, uses no inline scripts, and builds output as text", () => {
    const html = fs.readFileSync(path.join(__dirname, "..", "src", "dashboard", "public", "setup.html"), "utf8");
    expect(html).not.toMatch(/<script(?![^>]*src=)/);
    expect(html).toContain("شماره");
    const js = fs.readFileSync(path.join(__dirname, "..", "src", "dashboard", "public", "setup.js"), "utf8");
    expect(js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });
});

describe("platform-aware configuration (Railway)", () => {
  it("WEB_LOGIN requires the password that protects the setup page", () => {
    const env = { ...BASE_ENV, WEB_LOGIN: "true" } as Record<string, string | undefined>;
    delete env["DASHBOARD_PASSWORD"];
    expect(() => loadConfig(env as NodeJS.ProcessEnv, process.cwd(), { lenient: true })).toThrow(/WEB_LOGIN/);
  });

  it("uses the platform's volume path and PORT when nothing is set explicitly", () => {
    const c = loadConfig({ ...BASE_ENV, RAILWAY_VOLUME_MOUNT_PATH: "/data", PORT: "8080" }, "/app");
    expect(c.paths.dataDir).toBe("/data");
    expect(c.paths.sessionFile).toBe("/data/session.bin");
    expect(c.dashboard.port).toBe(8080);
    expect(c.dashboard.host).toBe("0.0.0.0");
  });

  it("explicit settings win over platform values; local default stays loopback", () => {
    const c = loadConfig({ ...BASE_ENV, RAILWAY_VOLUME_MOUNT_PATH: "/data", PORT: "8080", DATA_DIR: "/custom", DASHBOARD_PORT: "9000", DASHBOARD_HOST: "127.0.0.1" }, "/app");
    expect(c.paths.dataDir).toBe("/custom");
    expect(c.dashboard.port).toBe(9000);
    expect(c.dashboard.host).toBe("127.0.0.1");
    const local = loadConfig({ ...BASE_ENV }, "/app");
    expect(local.dashboard.host).toBe("127.0.0.1");
    expect(local.dashboard.port).toBe(8787);
    expect(local.paths.dataDir).toBe("/app/data");
  });
});
