import type { Database } from "./types";

const now = (): number => Date.now();
const toBool = (v: unknown): boolean => Number(v) === 1;

/* ------------------------------ settings ------------------------------ */
export class SettingsRepo {
  constructor(private readonly db: Database) {}

  async get(key: string): Promise<string | undefined> {
    return (await this.db.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", [key]))?.value;
  }
  async set(key: string, value: string): Promise<void> {
    await this.db.run(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      [key, value, now()],
    );
  }
  async delete(key: string): Promise<boolean> {
    return (await this.db.run("DELETE FROM settings WHERE key = ?", [key])).changes > 0;
  }
  async getJson<T>(key: string, fallback: T): Promise<T> {
    const raw = await this.get(key);
    if (raw === undefined) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }
  async setJson(key: string, value: unknown): Promise<void> {
    await this.set(key, JSON.stringify(value));
  }
  async list(prefix = ""): Promise<Array<{ key: string; value: string; updatedAt: number }>> {
    const rows = await this.db.all<{ key: string; value: string; updated_at: number }>("SELECT key, value, updated_at FROM settings WHERE key LIKE ? ORDER BY key", [`${prefix}%`]);
    return rows.map((r) => ({ key: r.key, value: r.value, updatedAt: Number(r.updated_at) }));
  }
}

/* ------------------------------ users (self-mode grants) ------------------------------ */
export interface UserGrant {
  userId: number;
  scopes: string[];
  note?: string;
  addedBy: number;
  addedAt: number;
  enabled: boolean;
}
interface UserRow {
  user_id: number;
  scopes: string;
  note: string | null;
  added_by: number;
  added_at: number;
  enabled: number;
}
const toGrant = (r: UserRow): UserGrant => ({
  userId: Number(r.user_id),
  scopes: JSON.parse(r.scopes) as string[],
  note: r.note ?? undefined,
  addedBy: Number(r.added_by),
  addedAt: Number(r.added_at),
  enabled: toBool(r.enabled),
});

export class UsersRepo {
  constructor(private readonly db: Database) {}
  async list(): Promise<UserGrant[]> {
    return (await this.db.all<UserRow>("SELECT * FROM authorized_users ORDER BY added_at")).map(toGrant);
  }
  async get(userId: number): Promise<UserGrant | undefined> {
    const r = await this.db.get<UserRow>("SELECT * FROM authorized_users WHERE user_id = ?", [userId]);
    return r ? toGrant(r) : undefined;
  }
  async upsert(g: { userId: number; scopes: string[]; note?: string; addedBy: number }): Promise<void> {
    await this.db.run(
      `INSERT INTO authorized_users (user_id, scopes, note, added_by, added_at, enabled) VALUES (?, ?, ?, ?, ?, 1)
       ON CONFLICT (user_id) DO UPDATE SET scopes = excluded.scopes, note = excluded.note, enabled = 1`,
      [g.userId, JSON.stringify(g.scopes), g.note ?? null, g.addedBy, now()],
    );
  }
  async setEnabled(userId: number, enabled: boolean): Promise<boolean> {
    return (await this.db.run("UPDATE authorized_users SET enabled = ? WHERE user_id = ?", [enabled ? 1 : 0, userId])).changes > 0;
  }
  async remove(userId: number): Promise<boolean> {
    return (await this.db.run("DELETE FROM authorized_users WHERE user_id = ?", [userId])).changes > 0;
  }
}

/* ------------------------------ rules ------------------------------ */
export interface RuleRow {
  id: number;
  ownerId: number;
  name: string;
  enabled: boolean;
  definition: unknown;
  hitCount: number;
  lastHitAt?: number;
  createdAt: number;
}
interface RawRule {
  id: number;
  owner_id: number;
  name: string;
  enabled: number;
  definition: string;
  hit_count: number;
  last_hit_at: number | null;
  created_at: number;
}
const toRule = (r: RawRule): RuleRow => ({
  id: Number(r.id),
  ownerId: Number(r.owner_id),
  name: r.name,
  enabled: toBool(r.enabled),
  definition: JSON.parse(r.definition) as unknown,
  hitCount: Number(r.hit_count),
  lastHitAt: r.last_hit_at === null ? undefined : Number(r.last_hit_at),
  createdAt: Number(r.created_at),
});

export class RulesRepo {
  constructor(private readonly db: Database) {}
  async create(ownerId: number, name: string, definition: unknown): Promise<number> {
    const t = now();
    return this.db.insert("INSERT INTO rules (owner_id, name, enabled, definition, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?)", [ownerId, name, JSON.stringify(definition), t, t]);
  }
  async list(ownerId?: number): Promise<RuleRow[]> {
    const rows = ownerId === undefined ? await this.db.all<RawRule>("SELECT * FROM rules ORDER BY id") : await this.db.all<RawRule>("SELECT * FROM rules WHERE owner_id = ? ORDER BY id", [ownerId]);
    return rows.map(toRule);
  }
  async get(id: number): Promise<RuleRow | undefined> {
    const r = await this.db.get<RawRule>("SELECT * FROM rules WHERE id = ?", [id]);
    return r ? toRule(r) : undefined;
  }
  async update(id: number, definition: unknown): Promise<boolean> {
    return (await this.db.run("UPDATE rules SET definition = ?, updated_at = ? WHERE id = ?", [JSON.stringify(definition), now(), id])).changes > 0;
  }
  async setEnabled(id: number, enabled: boolean): Promise<boolean> {
    return (await this.db.run("UPDATE rules SET enabled = ?, updated_at = ? WHERE id = ?", [enabled ? 1 : 0, now(), id])).changes > 0;
  }
  async delete(id: number): Promise<boolean> {
    return (await this.db.run("DELETE FROM rules WHERE id = ?", [id])).changes > 0;
  }
  async recordHit(id: number): Promise<void> {
    await this.db.run("UPDATE rules SET hit_count = hit_count + 1, last_hit_at = ? WHERE id = ?", [now(), id]);
  }
}

/* ------------------------------ tasks ------------------------------ */
export type TaskStatus = "pending" | "running" | "done" | "failed" | "cancelled";
export interface TaskRow {
  id: number;
  ownerId: number;
  kind: string;
  name: string;
  payload: Record<string, unknown>;
  runAt: number;
  repeatSec?: number;
  status: TaskStatus;
  attempts: number;
  lastRunAt?: number;
  lastError?: string;
  createdAt: number;
}
interface RawTask {
  id: number;
  owner_id: number;
  kind: string;
  name: string;
  payload: string;
  run_at: number;
  repeat_sec: number | null;
  status: TaskStatus;
  attempts: number;
  last_run_at: number | null;
  last_error: string | null;
  created_at: number;
}
const toTask = (r: RawTask): TaskRow => ({
  id: Number(r.id),
  ownerId: Number(r.owner_id),
  kind: r.kind,
  name: r.name,
  payload: JSON.parse(r.payload) as Record<string, unknown>,
  runAt: Number(r.run_at),
  repeatSec: r.repeat_sec === null ? undefined : Number(r.repeat_sec),
  status: r.status,
  attempts: Number(r.attempts),
  lastRunAt: r.last_run_at === null ? undefined : Number(r.last_run_at),
  lastError: r.last_error ?? undefined,
  createdAt: Number(r.created_at),
});

export interface TaskRunRow {
  id: number;
  taskId: number;
  taskName?: string;
  startedAt: number;
  finishedAt?: number;
  status: string;
  error?: string;
  lateSec?: number;
}

export class TasksRepo {
  constructor(private readonly db: Database) {}

  async create(t: { ownerId: number; kind: string; name: string; payload: Record<string, unknown>; runAt: number; repeatSec?: number }): Promise<number> {
    return this.db.insert("INSERT INTO tasks (owner_id, kind, name, payload, run_at, repeat_sec, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)", [
      t.ownerId,
      t.kind,
      t.name,
      JSON.stringify(t.payload),
      t.runAt,
      t.repeatSec ?? null,
      now(),
    ]);
  }
  async get(id: number): Promise<TaskRow | undefined> {
    const r = await this.db.get<RawTask>("SELECT * FROM tasks WHERE id = ?", [id]);
    return r ? toTask(r) : undefined;
  }
  async list(opts: { ownerId?: number; status?: TaskStatus; kind?: string; limit?: number } = {}): Promise<TaskRow[]> {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (opts.ownerId !== undefined) {
      where.push("owner_id = ?");
      params.push(opts.ownerId);
    }
    if (opts.status) {
      where.push("status = ?");
      params.push(opts.status);
    }
    if (opts.kind) {
      where.push("kind = ?");
      params.push(opts.kind);
    }
    const sql = `SELECT * FROM tasks ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY run_at DESC LIMIT ?`;
    return (await this.db.all<RawTask>(sql, [...params, opts.limit ?? 50])).map(toTask);
  }
  async due(at: number, limit = 20): Promise<TaskRow[]> {
    return (await this.db.all<RawTask>("SELECT * FROM tasks WHERE status = 'pending' AND run_at <= ? ORDER BY run_at LIMIT ?", [at, limit])).map(toTask);
  }
  /** Atomically moves a pending task to running; returns false if another worker already took it. */
  async claim(id: number): Promise<boolean> {
    return (await this.db.run("UPDATE tasks SET status = 'running', attempts = attempts + 1 WHERE id = ? AND status = 'pending'", [id])).changes === 1;
  }
  async setState(id: number, s: { status: TaskStatus; runAt?: number; attempts?: number; lastRunAt?: number; lastError?: string | null }): Promise<void> {
    await this.db.run(
      `UPDATE tasks SET status = ?, run_at = COALESCE(?, run_at), attempts = COALESCE(?, attempts),
       last_run_at = COALESCE(?, last_run_at), last_error = ? WHERE id = ?`,
      [s.status, s.runAt ?? null, s.attempts ?? null, s.lastRunAt ?? null, s.lastError ?? null, id],
    );
  }
  async cancel(id: number, ownerId?: number): Promise<boolean> {
    const sql = ownerId === undefined ? "UPDATE tasks SET status = 'cancelled' WHERE id = ? AND status IN ('pending','running')" : "UPDATE tasks SET status = 'cancelled' WHERE id = ? AND owner_id = ? AND status IN ('pending','running')";
    return (await this.db.run(sql, ownerId === undefined ? [id] : [id, ownerId])).changes > 0;
  }
  /** Recovers tasks left in `running` by a crash so they can be picked up again. */
  async recoverStuck(): Promise<number> {
    return (await this.db.run("UPDATE tasks SET status = 'pending' WHERE status = 'running'")).changes;
  }
  async startRun(taskId: number, lateSec: number): Promise<number> {
    return this.db.insert("INSERT INTO task_runs (task_id, started_at, status, late_sec) VALUES (?, ?, 'running', ?)", [taskId, now(), lateSec]);
  }
  async finishRun(runId: number, status: "ok" | "error", error?: string): Promise<void> {
    await this.db.run("UPDATE task_runs SET finished_at = ?, status = ?, error = ? WHERE id = ?", [now(), status, error ?? null, runId]);
  }
  async recentRuns(limit = 50): Promise<TaskRunRow[]> {
    const rows = await this.db.all<{ id: number; task_id: number; name: string | null; started_at: number; finished_at: number | null; status: string; error: string | null; late_sec: number | null }>(
      `SELECT r.id, r.task_id, t.name, r.started_at, r.finished_at, r.status, r.error, r.late_sec
       FROM task_runs r LEFT JOIN tasks t ON t.id = r.task_id ORDER BY r.id DESC LIMIT ?`,
      [limit],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      taskId: Number(r.task_id),
      taskName: r.name ?? undefined,
      startedAt: Number(r.started_at),
      finishedAt: r.finished_at === null ? undefined : Number(r.finished_at),
      status: r.status,
      error: r.error ?? undefined,
      lateSec: r.late_sec === null ? undefined : Number(r.late_sec),
    }));
  }
}

/* ------------------------------ audit ------------------------------ */
export interface AuditEntry {
  id: number;
  ts: number;
  actorId: number;
  action: string;
  target?: string;
  details?: unknown;
  dryRun: boolean;
  result: string;
}
export class AuditRepo {
  constructor(private readonly db: Database) {}
  async add(e: { actorId: number; action: string; target?: string; details?: unknown; dryRun?: boolean; result: string }): Promise<number> {
    return this.db.insert("INSERT INTO audit_log (ts, actor_id, action, target, details, dry_run, result) VALUES (?, ?, ?, ?, ?, ?, ?)", [
      now(),
      e.actorId,
      e.action,
      e.target ?? null,
      e.details === undefined ? null : JSON.stringify(e.details),
      e.dryRun ? 1 : 0,
      e.result,
    ]);
  }
  async recent(limit = 50): Promise<AuditEntry[]> {
    const rows = await this.db.all<{ id: number; ts: number; actor_id: number; action: string; target: string | null; details: string | null; dry_run: number; result: string }>(
      "SELECT * FROM audit_log ORDER BY id DESC LIMIT ?",
      [limit],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      ts: Number(r.ts),
      actorId: Number(r.actor_id),
      action: r.action,
      target: r.target ?? undefined,
      details: r.details === null ? undefined : (JSON.parse(r.details) as unknown),
      dryRun: toBool(r.dry_run),
      result: r.result,
    }));
  }
}

/* ------------------------------ media ------------------------------ */
export interface MediaRecord {
  id: number;
  sha256: string;
  path: string;
  size: number;
  mime?: string;
  kind: string;
  chatId?: number;
  messageId?: number;
  originalName?: string;
  createdAt: number;
}
interface RawMedia {
  id: number;
  sha256: string;
  path: string;
  size: number;
  mime: string | null;
  kind: string;
  chat_id: number | null;
  message_id: number | null;
  original_name: string | null;
  created_at: number;
}
const toMedia = (r: RawMedia): MediaRecord => ({
  id: Number(r.id),
  sha256: r.sha256,
  path: r.path,
  size: Number(r.size),
  mime: r.mime ?? undefined,
  kind: r.kind,
  chatId: r.chat_id === null ? undefined : Number(r.chat_id),
  messageId: r.message_id === null ? undefined : Number(r.message_id),
  originalName: r.original_name ?? undefined,
  createdAt: Number(r.created_at),
});
export class MediaRepo {
  constructor(private readonly db: Database) {}
  async findBySha(sha256: string): Promise<MediaRecord | undefined> {
    const r = await this.db.get<RawMedia>("SELECT * FROM media_files WHERE sha256 = ?", [sha256]);
    return r ? toMedia(r) : undefined;
  }
  async insert(m: Omit<MediaRecord, "id" | "createdAt">): Promise<number> {
    return this.db.insert("INSERT INTO media_files (sha256, path, size, mime, kind, chat_id, message_id, original_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [
      m.sha256,
      m.path,
      m.size,
      m.mime ?? null,
      m.kind,
      m.chatId ?? null,
      m.messageId ?? null,
      m.originalName ?? null,
      now(),
    ]);
  }
  async recent(limit = 50): Promise<MediaRecord[]> {
    return (await this.db.all<RawMedia>("SELECT * FROM media_files ORDER BY id DESC LIMIT ?", [limit])).map(toMedia);
  }
  async stats(): Promise<{ files: number; bytes: number }> {
    const r = await this.db.get<{ n: number; b: number | null }>("SELECT COUNT(*) AS n, SUM(size) AS b FROM media_files");
    return { files: Number(r?.n ?? 0), bytes: Number(r?.b ?? 0) };
  }
}

/* ------------------------------ plugin state ------------------------------ */
export interface PluginState {
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
  version?: string;
}
export class PluginRepo {
  constructor(private readonly db: Database) {}
  async get(name: string): Promise<PluginState | undefined> {
    const r = await this.db.get<{ name: string; enabled: number; config: string; version: string | null }>("SELECT * FROM plugin_state WHERE name = ?", [name]);
    return r ? { name: r.name, enabled: toBool(r.enabled), config: JSON.parse(r.config) as Record<string, unknown>, version: r.version ?? undefined } : undefined;
  }
  async list(): Promise<PluginState[]> {
    const rows = await this.db.all<{ name: string; enabled: number; config: string; version: string | null }>("SELECT * FROM plugin_state ORDER BY name");
    return rows.map((r) => ({ name: r.name, enabled: toBool(r.enabled), config: JSON.parse(r.config) as Record<string, unknown>, version: r.version ?? undefined }));
  }
  async upsert(name: string, patch: { enabled?: boolean; config?: Record<string, unknown>; version?: string }): Promise<void> {
    const existing = await this.get(name);
    const next = { enabled: patch.enabled ?? existing?.enabled ?? true, config: patch.config ?? existing?.config ?? {}, version: patch.version ?? existing?.version };
    await this.db.run(
      `INSERT INTO plugin_state (name, enabled, config, version, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (name) DO UPDATE SET enabled = excluded.enabled, config = excluded.config, version = excluded.version, updated_at = excluded.updated_at`,
      [name, next.enabled ? 1 : 0, JSON.stringify(next.config), next.version ?? null, now()],
    );
  }
}

/* ------------------------------ message archive (opt-in) ------------------------------ */
export interface ArchivedMessage {
  chatId: number;
  messageId: number;
  senderId?: number;
  sentAt: number;
  text?: string;
  hasMedia: boolean;
}
const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export class ArchiveRepo {
  constructor(private readonly db: Database) {}
  async upsert(m: ArchivedMessage): Promise<void> {
    await this.db.run(
      `INSERT INTO message_archive (chat_id, message_id, sender_id, sent_at, text, has_media, stored_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (chat_id, message_id) DO UPDATE SET text = excluded.text, has_media = excluded.has_media`,
      [m.chatId, m.messageId, m.senderId ?? null, m.sentAt, m.text ?? null, m.hasMedia ? 1 : 0, now()],
    );
  }
  async search(query: string, opts: { chatId?: number; limit?: number } = {}): Promise<ArchivedMessage[]> {
    const params: Array<string | number> = [`%${escapeLike(query)}%`];
    let sql = "SELECT * FROM message_archive WHERE LOWER(text) LIKE LOWER(?) ESCAPE '\\'";
    if (opts.chatId !== undefined) {
      sql += " AND chat_id = ?";
      params.push(opts.chatId);
    }
    sql += " ORDER BY sent_at DESC LIMIT ?";
    params.push(opts.limit ?? 20);
    const rows = await this.db.all<{ chat_id: number; message_id: number; sender_id: number | null; sent_at: number; text: string | null; has_media: number }>(sql, params);
    return rows.map((r) => ({ chatId: Number(r.chat_id), messageId: Number(r.message_id), senderId: r.sender_id === null ? undefined : Number(r.sender_id), sentAt: Number(r.sent_at), text: r.text ?? undefined, hasMedia: toBool(r.has_media) }));
  }
  async deleteChat(chatId: number): Promise<number> {
    return (await this.db.run("DELETE FROM message_archive WHERE chat_id = ?", [chatId])).changes;
  }
  async purgeAll(): Promise<number> {
    return (await this.db.run("DELETE FROM message_archive")).changes;
  }
  async count(): Promise<number> {
    return Number((await this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM message_archive"))?.n ?? 0);
  }
}

/* ------------------------------ bundle ------------------------------ */
export interface Repos {
  settings: SettingsRepo;
  users: UsersRepo;
  rules: RulesRepo;
  tasks: TasksRepo;
  audit: AuditRepo;
  media: MediaRepo;
  plugins: PluginRepo;
  archive: ArchiveRepo;
}
export function createRepos(db: Database): Repos {
  return {
    settings: new SettingsRepo(db),
    users: new UsersRepo(db),
    rules: new RulesRepo(db),
    tasks: new TasksRepo(db),
    audit: new AuditRepo(db),
    media: new MediaRepo(db),
    plugins: new PluginRepo(db),
    archive: new ArchiveRepo(db),
  };
}
