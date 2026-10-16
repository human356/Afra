import type { AppConfig } from "../config";
import { migrate } from "./migrations";
import { PostgresDatabase } from "./postgres";
import { SqliteDatabase } from "./sqlite";
import type { Database } from "./types";

export type { Database, SqlParam } from "./types";
export * from "./repositories";
export { migrate } from "./migrations";

/** Opens the configured backend and brings the schema up to date. */
export async function openDatabase(cfg: AppConfig): Promise<Database> {
  const db: Database = cfg.db.driver === "postgres" ? new PostgresDatabase(cfg.db.databaseUrl as string) : new SqliteDatabase(cfg.db.sqlitePath);
  await migrate(db);
  return db;
}
