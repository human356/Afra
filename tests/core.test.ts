import { describe, expect, it, vi } from "vitest";
import { parseCommand, stripOptions, tokenize } from "../src/core/args";
import { FloodWaitTooLongError, QueueFullError, userMessage } from "../src/core/errors";
import { createLogger } from "../src/core/logger";
import { BoundedQueue, Pacer } from "../src/core/queue";
import { makeRedactor } from "../src/core/redact";
import { backoffDelay, classifyError, floodWaitSeconds, withRetry } from "../src/core/retry";
import { chunkText, formatBytes, parseChatRef } from "../src/core/tg";
import { formatDuration, parseDuration, parseWhen } from "../src/core/time";
import { extractWhen } from "../src/commands/helpers";

describe("redaction", () => {
  it("masks configured secrets, bot tokens, API keys, db passwords", () => {
    const r = makeRedactor(["supersecretvalue"]);
    const out = r("a supersecretvalue b 123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi c sk-ant-abcdefghijk d postgres://user:hunter2@host/db");
    expect(out).not.toContain("supersecretvalue");
    expect(out).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi");
    expect(out).not.toContain("sk-ant-abcdefghijk");
    expect(out).not.toContain("hunter2");
    expect(out).toContain("postgres://user:[REDACTED]@host/db");
  });

  it("logger redacts secrets before writing and in the ring buffer", () => {
    const lines: string[] = [];
    const { logger, ring } = createLogger({ level: "info", secrets: ["topsecret-token-xyz"], destination: { write: (s) => void lines.push(s) } });
    logger.info({ module: "t", note: "value topsecret-token-xyz here" }, "hello topsecret-token-xyz");
    expect(lines.join("")).not.toContain("topsecret-token-xyz");
    expect(JSON.stringify(ring.recent())).not.toContain("topsecret-token-xyz");
    expect(ring.recent()[0]?.msg).toContain("[REDACTED]");
  });
});

describe("retry / flood wait", () => {
  const flood = (s: number) => Object.assign(new Error("FLOOD"), { name: "FloodWaitError", seconds: s });

  it("extracts wait seconds from error shapes", () => {
    expect(floodWaitSeconds(flood(7))).toBe(7);
    expect(floodWaitSeconds({ errorMessage: "FLOOD_WAIT_12" })).toBe(12);
    expect(floodWaitSeconds({ errorMessage: "SLOWMODE_WAIT_5" })).toBe(5);
    expect(floodWaitSeconds(new Error("nope"))).toBeUndefined();
  });

  it("classifies errors", () => {
    expect(classifyError(flood(1))).toBe("flood");
    expect(classifyError(new Error("ETIMEDOUT"))).toBe("transient");
    expect(classifyError({ errorMessage: "PEER_FLOOD" })).toBe("fatal");
    expect(classifyError({ errorMessage: "AUTH_KEY_UNREGISTERED" })).toBe("fatal");
    expect(classifyError(new Error("something odd"))).toBe("fatal");
  });

  it("waits AT LEAST the requested FloodWait time, then succeeds", async () => {
    const waits: number[] = [];
    let n = 0;
    const result = await withRetry(
      async () => {
        if (n++ === 0) throw flood(30);
        return "ok";
      },
      { retries: 3, sleep: async (ms) => void waits.push(ms), random: () => 0 },
    );
    expect(result).toBe("ok");
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThanOrEqual(30_000);
  });

  it("refuses to sit out a FloodWait longer than the configured maximum", async () => {
    await expect(withRetry(async () => { throw flood(5000); }, { retries: 3, maxFloodWaitSec: 900, sleep: async () => undefined })).rejects.toBeInstanceOf(FloodWaitTooLongError);
  });

  it("retries transient errors with exponential backoff and gives up after `retries`", async () => {
    const waits: number[] = [];
    let calls = 0;
    await expect(
      withRetry(async () => { calls++; throw new Error("ECONNRESET"); }, { retries: 3, baseMs: 100, maxMs: 10_000, sleep: async (ms) => void waits.push(ms), random: () => 1 }),
    ).rejects.toThrow("ECONNRESET");
    expect(calls).toBe(4);
    expect(waits).toEqual([100, 200, 400]);
  });

  it("does not retry fatal errors", async () => {
    let calls = 0;
    await expect(withRetry(async () => { calls++; throw new Error("bad input"); }, { retries: 5, sleep: async () => undefined })).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("backoff grows and is capped", () => {
    expect(backoffDelay(1, 500, 30_000, () => 1)).toBe(500);
    expect(backoffDelay(10, 500, 30_000, () => 1)).toBe(30_000);
    expect(backoffDelay(3, 500, 30_000, () => 0)).toBe(1000);
  });

  it("maps errors to actionable user messages", () => {
    expect(userMessage(flood(9))).toMatch(/wait 9s/);
    expect(userMessage({ errorMessage: "CHAT_ADMIN_REQUIRED" })).toMatch(/rights/);
    expect(userMessage({ errorMessage: "AUTH_KEY_UNREGISTERED" })).toMatch(/npm run login/);
  });
});

describe("bounded queue", () => {
  it("never exceeds the concurrency limit", async () => {
    const q = new BoundedQueue(2, 100);
    let running = 0;
    let peak = 0;
    const job = async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 10));
      running--;
    };
    await Promise.all(Array.from({ length: 8 }, (_, i) => q.add(`j${i}`, job)));
    expect(peak).toBe(2);
    expect(q.stats.completed).toBe(8);
  });

  it("rejects work beyond maxSize instead of growing without bound", async () => {
    const q = new BoundedQueue(1, 2);
    const gate = new Promise<void>((r) => setTimeout(r, 30));
    const jobs = [q.add("a", () => gate), q.add("b", () => gate), q.add("c", () => gate)];
    await expect(q.add("overflow", async () => 1)).rejects.toBeInstanceOf(QueueFullError);
    await Promise.all(jobs);
    expect(q.stats.rejected).toBe(1);
  });

  it("reports failures and keeps running", async () => {
    const errors: string[] = [];
    const q = new BoundedQueue(1, 10, (n) => errors.push(n));
    await expect(q.add("bad", async () => { throw new Error("x"); })).rejects.toThrow("x");
    await expect(q.add("good", async () => 5)).resolves.toBe(5);
    expect(errors).toEqual(["bad"]);
    expect(await q.drain(100)).toBe(true);
  });
});

describe("pacer", () => {
  it("spaces actions by the configured interval", async () => {
    let t = 0;
    const waits: number[] = [];
    const p = new Pacer(1000, () => t, async (ms) => { waits.push(ms); t += ms; });
    await p.wait("k");
    await p.wait("k");
    await p.wait("k");
    expect(waits).toEqual([1000, 1000]);
    await p.wait("other");
    expect(waits).toHaveLength(2);
  });
});

describe("command parsing", () => {
  it("tokenizes quotes and escapes", () => {
    expect(tokenize(`a "b c" 'd e' f\\ g`)).toEqual(["a", "b c", "d e", "f g"]);
    expect(tokenize(`"" x`)).toEqual(["", "x"]);
  });

  it("parses commands, options and flags", () => {
    const c = parseCommand(`.rule add "my rule" --on=hi,hello --here --cooldown=30`, ".");
    expect(c?.name).toBe("rule");
    expect(c?.args).toEqual(["add", "my rule"]);
    expect(c?.options).toEqual({ on: "hi,hello", cooldown: "30" });
    expect([...(c?.flags ?? [])]).toEqual(["here"]);
  });

  it("handles bot-style /cmd@botname and rejects non-commands", () => {
    expect(parseCommand("/help@MyBot now", "/")?.name).toBe("help");
    expect(parseCommand("hello", ".")).toBeUndefined();
    expect(parseCommand(". nothing", ".")).toBeUndefined();
    expect(parseCommand("..", ".")).toBeUndefined();
  });

  it("stripOptions leaves the message body", () => {
    expect(stripOptions("find cats --limit=5 --chat=@x now")).toBe("find cats now");
  });
});

describe("time parsing", () => {
  const now = new Date("2026-10-12T10:00:00");
  it("parses durations", () => {
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("2h30m")).toBe(9_000_000);
    expect(parseDuration("in 1d")).toBe(86_400_000);
    expect(parseDuration("soon")).toBeUndefined();
    expect(parseDuration("0m")).toBeUndefined();
  });
  it("parses clock times and absolute dates", () => {
    expect(parseWhen("18:30", now)?.getHours()).toBe(18);
    expect(parseWhen("09:00", now)?.getDate()).toBe(13); // already past today -> tomorrow
    expect(parseWhen("tomorrow 09:00", now)?.getDate()).toBe(13);
    expect(parseWhen("2026-12-31 23:59", now)?.getMonth()).toBe(11);
    expect(parseWhen("25:99", now)).toBeUndefined();
    expect(parseWhen("garbage", now)).toBeUndefined();
  });
  it("extractWhen consumes one or two tokens", () => {
    expect(extractWhen(["10m", "buy", "milk"], now).consumed).toBe(1);
    expect(extractWhen(["tomorrow", "09:00", "x"], now).consumed).toBe(2);
    expect(() => extractWhen(["whenever", "x"], now)).toThrow();
  });
  it("formats durations", () => {
    expect(formatDuration(3_661_000)).toBe("1h 1m 1s");
  });
});

describe("tg helpers", () => {
  it("parses chat references", () => {
    expect(parseChatRef("me")).toBe("me");
    expect(parseChatRef("-1001234567890")).toBe(-1001234567890);
    expect(parseChatRef("durov")).toBe("@durov");
    expect(parseChatRef("https://t.me/somechannel")).toBe("@somechannel");
    expect(() => parseChatRef("not valid!")).toThrow();
    expect(() => parseChatRef("")).toThrow();
    expect(parseChatRef(undefined, "42")).toBe(42);
  });
  it("chunks long text under the limit and loses nothing", () => {
    const text = Array.from({ length: 900 }, (_, i) => `line ${i}`).join("\n");
    const parts = chunkText(text, 1000);
    expect(parts.every((p) => p.length <= 1000)).toBe(true);
    expect(parts.join("\n").replace(/\s+/g, "")).toBe(text.replace(/\s+/g, ""));
  });
  it("formats bytes", () => {
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(0)).toBe("0 B");
  });
});

it("vi is available", () => expect(vi).toBeDefined());
