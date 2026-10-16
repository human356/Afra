import type { Logger } from "pino";
import { Api } from "teleproto";
import { z } from "zod";
import type { AppConfig } from "../config";
import { UsageError } from "../core/errors";
import type { Metrics } from "../core/metrics";
import type { Messenger, Peer } from "../messaging/messenger";
import type { RuleRow, RulesRepo } from "../storage/repositories";

export const RuleSchema = z.object({
  trigger: z.object({
    type: z.enum(["contains", "exact", "regex"]),
    patterns: z.array(z.string().min(1).max(200)).min(1).max(20),
    caseSensitive: z.boolean().default(false),
    wholeWord: z.boolean().default(false),
  }),
  scope: z.object({
    mode: z.enum(["allowlist", "blocklist"]),
    chatIds: z.array(z.number().int()).max(500),
  }),
  filters: z.object({
    chatTypes: z.array(z.enum(["private", "group", "channel"])).optional(),
    fromUserIds: z.array(z.number().int()).max(500).optional(),
    blockUserIds: z.array(z.number().int()).max(500),
    minLength: z.number().int().min(0).max(4000),
  }),
  action: z.discriminatedUnion("type", [
    z.object({ type: z.literal("reply"), text: z.string().min(1).max(1000) }),
    z.object({ type: z.literal("react"), emoji: z.string().min(1).max(8) }),
    z.object({ type: z.literal("notify"), text: z.string().min(1).max(500) }),
    z.object({ type: z.literal("forward"), to: z.union([z.literal("me"), z.number().int()]) }),
  ]),
  cooldownSec: z.number().int().min(5).max(86_400),
});
export type RuleDefinition = z.infer<typeof RuleSchema>;

export function parseRuleDefinition(raw: unknown): RuleDefinition {
  const r = RuleSchema.safeParse(raw);
  if (!r.success) throw new UsageError(`Invalid rule: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return r.data;
}

/** Heuristic guard against catastrophic-backtracking patterns such as (a+)+ or (.*)*. */
export function isSafeRegex(pattern: string): boolean {
  if (pattern.length > 200) return false;
  if (/\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+,\d*\})/.test(pattern)) return false;
  if (/\\[1-9]/.test(pattern)) return false; // backreferences
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

export interface MessageFacts {
  text: string;
  chatId: number;
  chatType: "private" | "group" | "channel";
  senderId?: number;
  isOut: boolean;
  isBot: boolean;
  messageId: number;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const MAX_TEXT = 2000;

/** Pure matching logic (no I/O). Never matches own messages or messages from bots. */
export function matchRule(def: RuleDefinition, f: MessageFacts): { matched: boolean; match?: string } {
  if (f.isOut || f.isBot || !f.text) return { matched: false };
  const inScope = def.scope.chatIds.includes(f.chatId);
  if (def.scope.mode === "allowlist" ? !inScope : inScope) return { matched: false };
  const flt = def.filters;
  if (flt.chatTypes && !flt.chatTypes.includes(f.chatType)) return { matched: false };
  if (f.senderId !== undefined && flt.blockUserIds.includes(f.senderId)) return { matched: false };
  if (flt.fromUserIds?.length && (f.senderId === undefined || !flt.fromUserIds.includes(f.senderId))) return { matched: false };
  const text = f.text.slice(0, MAX_TEXT);
  if (text.length < flt.minLength) return { matched: false };

  const flags = def.trigger.caseSensitive ? "" : "i";
  for (const p of def.trigger.patterns) {
    let re: RegExp;
    if (def.trigger.type === "regex") {
      if (!isSafeRegex(p)) continue;
      re = new RegExp(p, flags);
    } else if (def.trigger.type === "exact") {
      re = new RegExp(`^\\s*${escapeRe(p)}\\s*$`, flags);
    } else {
      const body = escapeRe(p);
      re = new RegExp(def.trigger.wholeWord ? `(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])` : body, `${flags}u`);
    }
    const m = re.exec(text);
    if (m) return { matched: true, match: m[0].slice(0, 100) };
  }
  return { matched: false };
}

const render = (tpl: string, vars: Record<string, string>): string => tpl.replace(/\{(\w+)\}/g, (_m, k: string) => vars[k] ?? `{${k}}`);

export interface RuleEngineDeps {
  rules: RulesRepo;
  messenger: Messenger;
  cfg: AppConfig;
  logger: Logger;
  metrics: Metrics;
  now?: () => number;
}

/**
 * Executes auto-reply rules. Safety limits (not configurable per rule): never answers itself or bots,
 * per-rule per-chat cooldown, and a global cap on automatic actions per chat per minute.
 */
export class RuleEngine {
  private cache: { at: number; rules: Array<{ row: RuleRow; def: RuleDefinition }> } | undefined;
  private readonly cooldowns = new Map<string, number>();
  private readonly windows = new Map<number, number[]>();
  private readonly now: () => number;

  constructor(private readonly d: RuleEngineDeps) {
    this.now = d.now ?? Date.now;
  }

  invalidate(): void {
    this.cache = undefined;
  }

  private async load(): Promise<Array<{ row: RuleRow; def: RuleDefinition }>> {
    if (this.cache && this.now() - this.cache.at < 5000) return this.cache.rules;
    const rows = await this.d.rules.list();
    const rules: Array<{ row: RuleRow; def: RuleDefinition }> = [];
    for (const row of rows) {
      if (!row.enabled) continue;
      const parsed = RuleSchema.safeParse(row.definition);
      if (parsed.success) rules.push({ row, def: parsed.data });
      else this.d.logger.warn({ module: "rules", ruleId: row.id }, "skipping rule with invalid definition");
    }
    this.cache = { at: this.now(), rules };
    return rules;
  }

  private underCap(chatId: number): boolean {
    const t = this.now();
    const recent = (this.windows.get(chatId) ?? []).filter((x) => t - x < 60_000);
    this.windows.set(chatId, recent);
    return recent.length < this.d.cfg.automation.autoReplyPerChatPerMin;
  }

  /** Cheap pre-check so callers can skip expensive lookups (e.g. fetching the sender) when no rule can apply. */
  async mightApply(chatId: number): Promise<boolean> {
    return (await this.load()).some(({ def }) => (def.scope.mode === "allowlist" ? def.scope.chatIds.includes(chatId) : !def.scope.chatIds.includes(chatId)));
  }

  /** Returns how many actions were executed for this message. */
  async handle(f: MessageFacts, peer: Peer): Promise<number> {
    let executed = 0;
    for (const { row, def } of await this.load()) {
      const m = matchRule(def, f);
      if (!m.matched) continue;
      const key = `${row.id}:${f.chatId}`;
      const t = this.now();
      if (t - (this.cooldowns.get(key) ?? 0) < def.cooldownSec * 1000) continue;
      const toChat = def.action.type !== "notify";
      if (toChat && !this.underCap(f.chatId)) {
        this.d.metrics.inc("rules.capped");
        continue;
      }
      this.cooldowns.set(key, t);
      try {
        await this.run(def, row, f, peer, m.match ?? "");
        if (toChat) this.windows.get(f.chatId)?.push(t);
        await this.d.rules.recordHit(row.id);
        this.d.metrics.inc("rules.fired");
        executed++;
      } catch (err) {
        this.d.metrics.inc("rules.errors");
        this.d.logger.warn({ module: "rules", ruleId: row.id, err: err instanceof Error ? err.message : String(err) }, "rule action failed");
      }
    }
    return executed;
  }

  private async run(def: RuleDefinition, row: RuleRow, f: MessageFacts, peer: Peer, match: string): Promise<void> {
    const vars = { sender: String(f.senderId ?? "?"), chat: String(f.chatId), match, rule: row.name };
    const a = def.action;
    switch (a.type) {
      case "reply":
        await this.d.messenger.sendText(peer, render(a.text, vars), { replyTo: f.messageId });
        break;
      case "notify":
        await this.d.messenger.sendSaved(render(a.text, vars));
        break;
      case "forward":
        await this.d.messenger.forward(a.to === "me" ? "me" : a.to, peer, [f.messageId]);
        break;
      case "react":
        await this.d.messenger.call("sendReaction", () => this.d.messenger.client.sendReaction(peer, f.messageId, [new Api.ReactionEmoji({ emoticon: a.emoji })]));
        break;
    }
  }
}
