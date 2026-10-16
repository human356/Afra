import pg from "pg";
import type { Database, SqlParam } from "./types";

// BIGINT (OID 20) comes back as string by default; Telegram ids and timestamps fit in a JS number.
pg.types.setTypeParser(20, (v: string) => Number(v));

/** Converts `?` placeholders to PostgreSQL `$n` form. SQL in this project never uses `?` inside string literals. */
export function toPgPlaceholders(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

type Queryable = Pick<pg.Pool, "query">;

class PgOps implements Database {
  readonly dialect = "postgres" as const;
  constructor(
    protected readonly q: Queryable,
    private readonly inTx: boolean,
    private readonly pool?: pg.Pool,
  ) {}

  async exec(sql: string): Promise<void> {
    await this.q.query(sql);
  }
  async run(sql: string, params: SqlParam[] = []): Promise<{ changes: number }> {
    const r = await this.q.query(toPgPlaceholders(sql), params);
    return { changes: r.rowCount ?? 0 };
  }
  async insert(sql: string, params: SqlParam[] = []): Promise<number> {
    const withReturning = /\breturning\b/i.test(sql) ? sql : `${sql} RETURNING id`;
    const r = await this.q.query(toPgPlaceholders(withReturning), params);
    return Number((r.rows[0] as { id: number | string }).id);
  }
  async get<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []): Promise<T | undefined> {
    const r = await this.q.query(toPgPlaceholders(sql), params);
    return r.rows[0] as T | undefined;
  }
  async all<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []): Promise<T[]> {
    const r = await this.q.query(toPgPlaceholders(sql), params);
    return r.rows as T[];
  }
  async transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
    if (this.inTx || !this.pool) return fn(this);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(new PgOps(client as unknown as Queryable, true));
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
  async ping(): Promise<void> {
    await this.q.query("SELECT 1");
  }
  async backup(): Promise<string | undefined> {
    return undefined; // use pg_dump for full backups; the config snapshot covers app settings
  }
  async close(): Promise<void> {
    await this.pool?.end();
  }
}

export class PostgresDatabase extends PgOps {
  constructor(connectionString: string) {
    const pool = new pg.Pool({ connectionString, max: 5, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 });
    super(pool, false, pool);
  }
}
