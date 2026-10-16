import pino, { type Logger } from "pino";
import { makeRedactor } from "./redact";

export interface LogEntry {
  level: string;
  time: number;
  msg: string;
  module?: string;
  [k: string]: unknown;
}

const LEVELS: Record<number, string> = { 10: "trace", 20: "debug", 30: "info", 40: "warn", 50: "error", 60: "fatal" };
const ORDER = ["trace", "debug", "info", "warn", "error", "fatal"];

/** Fixed-size in-memory buffer of redacted log lines for the dashboard. */
export class LogRing {
  private readonly entries: LogEntry[] = [];
  constructor(private readonly capacity = 1000) {}

  write(line: string): void {
    try {
      const raw = JSON.parse(line) as Record<string, unknown>;
      const { level, time, msg, ...rest } = raw;
      this.entries.push({ level: LEVELS[Number(level)] ?? String(level), time: Number(time), msg: String(msg ?? ""), ...rest });
      if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
    } catch {
      /* non-JSON line: ignore */
    }
  }

  recent(limit = 200, minLevel?: string): LogEntry[] {
    const min = minLevel ? ORDER.indexOf(minLevel) : 0;
    const filtered = min > 0 ? this.entries.filter((e) => ORDER.indexOf(e.level) >= min) : this.entries;
    return filtered.slice(-limit);
  }
}

export interface LoggerBundle {
  logger: Logger;
  ring: LogRing;
}

export function createLogger(opts: { level: string; secrets: readonly string[]; destination?: { write(s: string): void } }): LoggerBundle {
  const redact = makeRedactor(opts.secrets);
  const ring = new LogRing();
  const out = opts.destination ?? process.stdout;
  const stream = {
    write(line: string): void {
      const clean = redact(line);
      out.write(clean);
      ring.write(clean);
    },
  };
  const logger = pino(
    {
      level: opts.level,
      base: undefined,
      redact: { paths: ["*.apiHash", "*.botToken", "*.password", "*.sessionString", "*.phoneCode", "apiHash", "botToken", "password"], censor: "[REDACTED]" },
      timestamp: pino.stdTimeFunctions.epochTime,
    },
    stream,
  );
  return { logger, ring };
}

export type { Logger };
