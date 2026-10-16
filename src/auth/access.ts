import { PermissionError, UsageError } from "../core/errors";
import type { AuditRepo, UserGrant, UsersRepo } from "../storage/repositories";

/**
 * Permission scopes for "self mode".
 * - self:       personal helpers only (reminders, notes, transforms, translate, AI on text you provide)
 * - automation: manage auto-reply rules and scheduled tasks
 * - search:     search / export chats the account can read
 * - media:      inspect and download media from chats
 * - messaging:  send / edit / delete / forward messages as the account
 * - chatadmin:  group & channel moderation (additionally requires real Telegram admin rights)
 */
export const SCOPES = ["self", "automation", "search", "media", "messaging", "chatadmin"] as const;
export type Scope = (typeof SCOPES)[number];
export const isScope = (s: string): s is Scope => (SCOPES as readonly string[]).includes(s);

export const SCOPE_HELP: Record<Scope, string> = {
  self: "personal helpers (reminders, transforms, translate, AI on text you provide)",
  automation: "auto-reply rules and scheduled tasks",
  search: "search and export chat history",
  media: "inspect and download media",
  messaging: "send/edit/delete/forward as the account",
  chatadmin: "group/channel moderation (needs real admin rights too)",
};

export interface Principal {
  userId: number;
  isMaster: boolean;
  scopes: ReadonlySet<Scope>;
}

/**
 * Who may command the userbot.
 * - The master admin (MASTER_ADMIN_ID in .env) always can, with every scope. It cannot be changed at runtime.
 * - Everyone else gets nothing until the master grants "self mode" to that user, with explicit scopes.
 */
export class AccessControl {
  private cache = new Map<number, { at: number; principal: Principal | undefined }>();

  constructor(
    private readonly masterId: number,
    private readonly users: UsersRepo,
    private readonly audit?: AuditRepo,
    private readonly ttlMs = 5000,
    private readonly now: () => number = Date.now,
  ) {}

  get masterAdminId(): number {
    return this.masterId;
  }

  async resolve(userId: number): Promise<Principal | undefined> {
    if (userId === this.masterId) return { userId, isMaster: true, scopes: new Set(SCOPES) };
    const hit = this.cache.get(userId);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.principal;
    const grant = await this.users.get(userId);
    const principal: Principal | undefined = grant?.enabled ? { userId, isMaster: false, scopes: new Set(grant.scopes.filter(isScope)) } : undefined;
    this.cache.set(userId, { at: this.now(), principal });
    return principal;
  }

  async can(userId: number, scope: Scope): Promise<boolean> {
    return (await this.resolve(userId))?.scopes.has(scope) ?? false;
  }

  parseScopes(input: string[]): Scope[] {
    const out: Scope[] = [];
    for (const s of input.flatMap((x) => x.split(",")).map((x) => x.trim().toLowerCase()).filter(Boolean)) {
      if (s === "all") throw new UsageError('"all" is not allowed; list scopes explicitly', `Valid scopes: ${SCOPES.join(", ")}`);
      if (!isScope(s)) throw new UsageError(`Unknown scope "${s}"`, `Valid scopes: ${SCOPES.join(", ")}`);
      if (!out.includes(s)) out.push(s);
    }
    return out.length ? out : ["self"];
  }

  async grant(actorId: number, targetId: number, scopes: Scope[] = ["self"], note?: string): Promise<void> {
    this.requireMaster(actorId);
    if (targetId === this.masterId) throw new UsageError("The master admin already has full access");
    if (!Number.isSafeInteger(targetId) || targetId <= 0) throw new UsageError("Invalid user id");
    await this.users.upsert({ userId: targetId, scopes, note, addedBy: actorId });
    this.cache.delete(targetId);
    await this.audit?.add({ actorId, action: "access.grant", target: String(targetId), details: { scopes }, result: "ok" });
  }

  async revoke(actorId: number, targetId: number): Promise<boolean> {
    this.requireMaster(actorId);
    const removed = await this.users.remove(targetId);
    this.cache.delete(targetId);
    await this.audit?.add({ actorId, action: "access.revoke", target: String(targetId), result: removed ? "ok" : "not-found" });
    return removed;
  }

  async setEnabled(actorId: number, targetId: number, enabled: boolean): Promise<boolean> {
    this.requireMaster(actorId);
    const ok = await this.users.setEnabled(targetId, enabled);
    this.cache.delete(targetId);
    await this.audit?.add({ actorId, action: enabled ? "access.enable" : "access.disable", target: String(targetId), result: ok ? "ok" : "not-found" });
    return ok;
  }

  list(): Promise<UserGrant[]> {
    return this.users.list();
  }

  private requireMaster(actorId: number): void {
    if (actorId !== this.masterId) throw new PermissionError("Only the master admin can change access", "Set MASTER_ADMIN_ID in .env to your Telegram user id.");
  }
}
