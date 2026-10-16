import fs from "node:fs";
import path from "node:path";
import type { Database } from "./types";

const SNAPSHOT_TABLES = ["settings", "authorized_users", "rules", "tasks", "plugin_state"] as const;
const stamp = (d = new Date()): string => d.toISOString().replace(/[:.]/g, "-");

export interface BackupResult {
  snapshotFile: string;
  databaseFile?: string;
  pruned: string[];
}

/**
 * Backs up local configuration: a JSON snapshot of settings/grants/rules/tasks/plugin state
 * (works for every backend) plus a native SQLite copy when available. Message content,
 * audit logs and session files are intentionally not part of the snapshot.
 */
export async function backupConfig(db: Database, backupsDir: string, keep = 10): Promise<BackupResult> {
  fs.mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
  const snapshot: Record<string, unknown> = { version: 1, createdAt: new Date().toISOString(), dialect: db.dialect };
  for (const t of SNAPSHOT_TABLES) snapshot[t] = await db.all(`SELECT * FROM ${t}`);
  const snapshotFile = path.join(backupsDir, `config-${stamp()}.json`);
  fs.writeFileSync(snapshotFile, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
  const databaseFile = await db.backup(path.join(backupsDir, `db-${stamp()}.sqlite`));
  return { snapshotFile, databaseFile, pruned: pruneBackups(backupsDir, keep) };
}

export function pruneBackups(dir: string, keep: number): string[] {
  const removed: string[] = [];
  for (const prefix of ["config-", "db-"]) {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(prefix))
      .sort();
    for (const f of files.slice(0, Math.max(0, files.length - keep))) {
      fs.rmSync(path.join(dir, f), { force: true });
      removed.push(f);
    }
  }
  return removed;
}
