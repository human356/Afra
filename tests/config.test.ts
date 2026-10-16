import { describe, expect, it } from "vitest";
import { isLoopbackHost, loadConfig, publicConfigView } from "../src/config";
import { ConfigError } from "../src/core/errors";
import { BASE_ENV, testConfig } from "./helpers";

describe("config", () => {
  it("applies safe defaults", () => {
    const c = testConfig();
    expect(c.dashboard.host).toBe("127.0.0.1");
    expect(c.privacy.storeMessageContent).toBe(false);
    expect(c.commands.dryRunDefault).toBe(true);
    expect(c.db.driver).toBe("sqlite");
    expect(c.ai.enabled).toBe(false);
    expect(c.translate.provider).toBe("none");
    expect(c.commands.prefix).toBe(".");
  });

  it("lists every missing variable by name without echoing values", () => {
    try {
      loadConfig({ TG_API_HASH: "tooshort", DASHBOARD_ENABLED: "false" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const msg = (e as ConfigError).message;
      expect(msg).toContain("TG_API_ID");
      expect(msg).toContain("MASTER_ADMIN_ID");
      expect(msg).not.toContain("tooshort");
    }
  });

  it("requires a dashboard password unless the dashboard is disabled or the caller is lenient", () => {
    const env = { ...BASE_ENV };
    delete (env as Record<string, string | undefined>)["DASHBOARD_PASSWORD"];
    expect(() => loadConfig(env)).toThrow(/DASHBOARD_PASSWORD/);
    expect(() => loadConfig({ ...env, DASHBOARD_ENABLED: "false" })).not.toThrow();
    expect(() => loadConfig(env, process.cwd(), { lenient: true })).not.toThrow();
  });

  it("rejects short dashboard passwords, bad bot tokens and alphanumeric prefixes", () => {
    expect(() => loadConfig({ ...BASE_ENV, DASHBOARD_PASSWORD: "short" })).toThrow(/DASHBOARD_PASSWORD/);
    expect(() => loadConfig({ ...BASE_ENV, BOT_TOKEN: "nope" })).toThrow(/BOT_TOKEN/);
    expect(() => loadConfig({ ...BASE_ENV, COMMAND_PREFIX: "a" })).toThrow(/COMMAND_PREFIX/);
  });

  it("requires DATABASE_URL for postgres and a key for AI", () => {
    expect(() => loadConfig({ ...BASE_ENV, DB_DRIVER: "postgres" })).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ ...BASE_ENV, AI_ENABLED: "true" })).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => loadConfig({ ...BASE_ENV, TRANSLATE_PROVIDER: "libretranslate" })).toThrow(/TRANSLATE_URL/);
  });

  it("treats empty values as unset and parses booleans", () => {
    const c = loadConfig({ ...BASE_ENV, SESSION_ENCRYPTION_KEY: "", STORE_MESSAGE_CONTENT: "yes", DRY_RUN_DEFAULT: "off" });
    expect(c.security.sessionEncryptionKey).toBeUndefined();
    expect(c.privacy.storeMessageContent).toBe(true);
    expect(c.commands.dryRunDefault).toBe(false);
  });

  it("collects secrets for redaction and keeps them out of the public view", () => {
    const c = testConfig({ SESSION_ENCRYPTION_KEY: "a-long-encryption-key-123", ANTHROPIC_API_KEY: "sk-ant-secretsecret", AI_ENABLED: "true" });
    for (const secret of [BASE_ENV["TG_API_HASH"], BASE_ENV["BOT_TOKEN"], BASE_ENV["DASHBOARD_PASSWORD"], "a-long-encryption-key-123", "sk-ant-secretsecret"]) {
      expect(c.secrets).toContain(secret);
      expect(JSON.stringify(publicConfigView(c))).not.toContain(secret as string);
    }
  });

  it("recognises loopback hosts", () => {
    for (const h of ["127.0.0.1", "localhost", "::1", "127.1.2.3"]) expect(isLoopbackHost(h)).toBe(true);
    for (const h of ["0.0.0.0", "192.168.1.5", "example.com"]) expect(isLoopbackHost(h)).toBe(false);
  });
});
