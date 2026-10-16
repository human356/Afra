import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SessionStore } from "../src/auth/sessionStore";
import { tmpDir } from "./helpers";

const SESSION = "1BAAOMTQ5LjE1NC4xNzUuNTUBu".repeat(10);

describe("session store", () => {
  it("encrypts at rest and round-trips with the right key", () => {
    const file = path.join(tmpDir(), "s.bin");
    const store = new SessionStore(file, "a-strong-passphrase-123");
    store.save(SESSION);
    const raw = fs.readFileSync(file, "utf8");
    expect(raw.startsWith("TGUB1:")).toBe(true);
    expect(raw).not.toContain(SESSION.slice(0, 20));
    expect(store.load()).toBe(SESSION);
    expect(store.info()).toMatchObject({ exists: true, encrypted: true, looseMode: false });
  });

  it("fails clearly with a wrong or missing key", () => {
    const file = path.join(tmpDir(), "s.bin");
    new SessionStore(file, "a-strong-passphrase-123").save(SESSION);
    expect(() => new SessionStore(file, "another-passphrase-456").load()).toThrow(/decrypt/i);
    expect(() => new SessionStore(file).load()).toThrow(/SESSION_ENCRYPTION_KEY/);
  });

  it("detects tampering", () => {
    const file = path.join(tmpDir(), "s.bin");
    const store = new SessionStore(file, "a-strong-passphrase-123");
    store.save(SESSION);
    const raw = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, `${raw.slice(0, -4)}AAAA`);
    expect(() => store.load()).toThrow();
  });

  it("writes plaintext with mode 0600 when no key is set, and flags loose permissions", () => {
    const file = path.join(tmpDir(), "s.bin");
    const store = new SessionStore(file);
    store.save(SESSION);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(store.load()).toBe(SESSION);
    fs.chmodSync(file, 0o644);
    expect(store.info().looseMode).toBe(true);
  });

  it("quarantines and removes", () => {
    const file = path.join(tmpDir(), "s.bin");
    const store = new SessionStore(file);
    expect(store.load()).toBeUndefined();
    store.save(SESSION);
    const moved = store.quarantine();
    expect(moved && fs.existsSync(moved)).toBe(true);
    expect(store.exists()).toBe(false);
    store.save(SESSION);
    expect(store.remove()).toBe(true);
  });
});
