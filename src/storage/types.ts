export type SqlParam = string | number | bigint | boolean | null | Buffer;

/** Minimal async SQL surface shared by the SQLite and PostgreSQL backends. Use `?` placeholders. */
export interface Database {
  readonly dialect: "sqlite" | "postgres";
  exec(sql: string): Promise<void>;
  run(sql: string, params?: SqlParam[]): Promise<{ changes: number }>;
  /** Runs an INSERT and returns the generated integer id. */
  insert(sql: string, params?: SqlParam[]): Promise<number>;
  get<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<T | undefined>;
  all<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<T[]>;
  /** Executes `fn` atomically. Inside `fn`, use the provided `tx`, not the outer database. */
  transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T>;
  ping(): Promise<void>;
  /** Native consistent copy of the database to `destFile` (SQLite only). Returns undefined if unsupported. */
  backup(destFile: string): Promise<string | undefined>;
  close(): Promise<void>;
}
