import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import type { Database, SqlParam } from "./types";

type SqliteValue = string | number | bigint | Uint8Array | null;
const bind = (params: SqlParam[] = []): SqliteValue[] => params.map((p) => (typeof p === "boolean" ? (p ? 1 : 0) : p));

/**
 * Loads Node's built-in SQLite (no native add-on to compile — important on hosts like Railway).
 * Node prints a one-line "experimental" warning for it on some versions; that single notice is filtered here.
 */
function loadSqlite(): typeof import("node:sqlite") {
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    if (String(warning).includes("SQLite")) return;
    return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded lazily so the warning filter is active
    return require("node:sqlite") as typeof import("node:sqlite");
  } finally {
    process.emitWarning = original;
  }
}

const plain = <T>(row: unknown): T | undefined => (row === undefined || row === null ? undefined : ({ ...(row as object) } as T));

class SqliteOps {
  constructor(private readonly db: DatabaseSyncType) {}
  exec(sql: string): void {
    this.db.exec(sql);
  }
  run(sql: string, params?: SqlParam[]): { changes: number } {
    return { changes: Number(this.db.prepare(sql).run(...bind(params)).changes) };
  }
  insert(sql: string, params?: SqlParam[]): number {
    return Number(this.db.prepare(sql).run(...bind(params)).lastInsertRowid);
  }
  get<T>(sql: string, params?: SqlParam[]): T | undefined {
    return plain<T>(this.db.prepare(sql).get(...bind(params)));
  }
  all<T>(sql: string, params?: SqlParam[]): T[] {
    return this.db.prepare(sql).all(...bind(params)).map((r) => plain<T>(r) as T);
  }
}

/** Handle used inside a transaction: the lock is already held, so calls run directly. */
class SqliteTx implements Database {
  readonly dialect = "sqlite" as const;
  constructor(private readonly ops: SqliteOps) {}
  async exec(sql: string): Promise<void> {
    this.ops.exec(sql);
  }
  async run(sql: string, params?: SqlParam[]): Promise<{ changes: number }> {
    return this.ops.run(sql, params);
  }
  async insert(sql: string, params?: SqlParam[]): Promise<number> {
    return this.ops.insert(sql, params);
  }
  async get<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<T | undefined> {
    return this.ops.get<T>(sql, params);
  }
  async all<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<T[]> {
    return this.ops.all<T>(sql, params);
  }
  async transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
    return fn(this); // already inside a transaction; nested calls join it
  }
  async ping(): Promise<void> {}
  async backup(): Promise<string | undefined> {
    return undefined;
  }
  async close(): Promise<void> {}
}

export class SqliteDatabase implements Database {
  readonly dialect = "sqlite" as const;
  private readonly db: DatabaseSyncType;
  private readonly ops: SqliteOps;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const { DatabaseSync } = loadSqlite();
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.ops = new SqliteOps(this.db);
    if (file !== ":memory:") {
      try {
        fs.chmodSync(file, 0o600);
      } catch {
        /* best effort */
      }
    }
  }

  /** Serialises all access so an open transaction is never interleaved with other callers. */
  private locked<T>(fn: () => T | Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  exec(sql: string): Promise<void> {
    return this.locked(() => this.ops.exec(sql));
  }
  run(sql: string, params?: SqlParam[]): Promise<{ changes: number }> {
    return this.locked(() => this.ops.run(sql, params));
  }
  insert(sql: string, params?: SqlParam[]): Promise<number> {
    return this.locked(() => this.ops.insert(sql, params));
  }
  get<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<T | undefined> {
    return this.locked(() => this.ops.get<T>(sql, params));
  }
  all<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<T[]> {
    return this.locked(() => this.ops.all<T>(sql, params));
  }

  transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
    return this.locked(async () => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const result = await fn(new SqliteTx(this.ops));
        this.db.exec("COMMIT");
        return result;
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
    });
  }

  async ping(): Promise<void> {
    await this.get("SELECT 1 AS ok");
  }

  async backup(destFile: string): Promise<string> {
    fs.mkdirSync(path.dirname(destFile), { recursive: true, mode: 0o700 });
    // VACUUM INTO writes a consistent, compacted copy even while the database is in use (WAL).
    await this.locked(() => this.db.exec(`VACUUM INTO '${destFile.replace(/'/g, "''")}'`));
    try {
      fs.chmodSync(destFile, 0o600);
    } catch {
      /* best effort */
    }
    return destFile;
  }

  async close(): Promise<void> {
    await this.chain;
    this.db.close();
  }
}
