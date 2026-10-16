import type { Database } from "./types";

interface Migration {
  id: number;
  name: string;
  up(db: Database): Promise<void>;
}

const pk = (db: Database): string => (db.dialect === "sqlite" ? "INTEGER PRIMARY KEY AUTOINCREMENT" : "BIGSERIAL PRIMARY KEY");

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: "initial schema",
    async up(db) {
      const P = pk(db);
      await db.exec(`
        CREATE TABLE settings (
          key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at BIGINT NOT NULL
        );
        CREATE TABLE authorized_users (
          user_id BIGINT PRIMARY KEY, scopes TEXT NOT NULL, note TEXT,
          added_by BIGINT NOT NULL, added_at BIGINT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE rules (
          id ${P}, owner_id BIGINT NOT NULL, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
          definition TEXT NOT NULL, hit_count BIGINT NOT NULL DEFAULT 0, last_hit_at BIGINT,
          created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL
        );
        CREATE TABLE tasks (
          id ${P}, owner_id BIGINT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, payload TEXT NOT NULL,
          run_at BIGINT NOT NULL, repeat_sec BIGINT, status TEXT NOT NULL DEFAULT 'pending',
          attempts INTEGER NOT NULL DEFAULT 0, last_run_at BIGINT, last_error TEXT, created_at BIGINT NOT NULL
        );
        CREATE INDEX idx_tasks_due ON tasks(status, run_at);
        CREATE TABLE task_runs (
          id ${P}, task_id BIGINT NOT NULL, started_at BIGINT NOT NULL, finished_at BIGINT,
          status TEXT NOT NULL, error TEXT, late_sec INTEGER
        );
        CREATE INDEX idx_task_runs_task ON task_runs(task_id);
        CREATE TABLE audit_log (
          id ${P}, ts BIGINT NOT NULL, actor_id BIGINT NOT NULL, action TEXT NOT NULL,
          target TEXT, details TEXT, dry_run INTEGER NOT NULL DEFAULT 0, result TEXT NOT NULL
        );
        CREATE INDEX idx_audit_ts ON audit_log(ts);
        CREATE TABLE media_files (
          id ${P}, sha256 TEXT NOT NULL UNIQUE, path TEXT NOT NULL, size BIGINT NOT NULL, mime TEXT,
          kind TEXT NOT NULL, chat_id BIGINT, message_id BIGINT, original_name TEXT, created_at BIGINT NOT NULL
        );
        CREATE TABLE plugin_state (
          name TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, config TEXT NOT NULL DEFAULT '{}',
          version TEXT, updated_at BIGINT NOT NULL
        );
        CREATE TABLE message_archive (
          id ${P}, chat_id BIGINT NOT NULL, message_id BIGINT NOT NULL, sender_id BIGINT,
          sent_at BIGINT NOT NULL, text TEXT, has_media INTEGER NOT NULL DEFAULT 0, stored_at BIGINT NOT NULL,
          UNIQUE (chat_id, message_id)
        );
      `);
    },
  },
];

/** Applies pending migrations inside transactions. Safe to call on every start. */
export async function migrate(db: Database): Promise<number[]> {
  await db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id BIGINT PRIMARY KEY, name TEXT NOT NULL, applied_at BIGINT NOT NULL)");
  const done = new Set((await db.all<{ id: number }>("SELECT id FROM schema_migrations")).map((r) => Number(r.id)));
  const applied: number[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    await db.transaction(async (tx) => {
      await m.up(tx);
      await tx.run("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)", [m.id, m.name, Date.now()]);
    });
    applied.push(m.id);
  }
  return applied;
}
