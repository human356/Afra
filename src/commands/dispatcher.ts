import type { Logger } from "pino";
import type { Api } from "teleproto";
import type { AccessControl } from "../auth/access";
import type { AppConfig } from "../config";
import { parseCommand } from "../core/args";
import { AppError, PermissionError, userMessage } from "../core/errors";
import { parseChatRef } from "../core/tg";
import type { Metrics } from "../core/metrics";
import type { BoundedQueue } from "../core/queue";
import type { AuditRepo } from "../storage/repositories";
import type { ConfirmationManager } from "./confirmations";
import type { CommandRegistry } from "./registry";
import type { CommandContext, ConfirmSpec, Transport } from "./types";

export interface IncomingCommand {
  transport: Transport;
  senderId: number;
  chatId: string;
  messageId?: number;
  replyToId?: number;
  text: string;
  reply(text: string): Promise<void>;
  progress(initial: string): Promise<(text: string) => Promise<void>>;
  getRepliedMessage(): Promise<Api.Message | undefined>;
}

export interface DispatcherDeps {
  cfg: AppConfig;
  logger: Logger;
  registry: CommandRegistry;
  access: AccessControl;
  confirmations: ConfirmationManager;
  audit: AuditRepo;
  metrics: Metrics;
  queue: BoundedQueue;
  now?: () => number;
}

const RATE_LIMIT_PER_MIN = 30;

/**
 * Turns an incoming message into an executed command.
 * Security stance: strangers get NO response on the userbot transport (a userbot must never talk to people
 * who were not authorised), and a short refusal on the control bot.
 */
export class CommandDispatcher {
  private readonly hits = new Map<number, number[]>();
  private readonly now: () => number;

  constructor(private readonly d: DispatcherDeps) {
    this.now = d.now ?? Date.now;
  }

  prefixFor(t: Transport): string {
    return t === "bot" ? "/" : this.d.cfg.commands.prefix;
  }

  /** Returns true if the text was a command we handled or refused; false means "not for us — treat as an ordinary message". */
  async handle(inc: IncomingCommand): Promise<boolean> {
    const cmd = parseCommand(inc.text, this.prefixFor(inc.transport));
    if (!cmd) return false;

    const principal = await this.d.access.resolve(inc.senderId);
    if (!principal) {
      if (inc.transport === "bot") await inc.reply("This bot is private. Ask the owner to grant you access.").catch(() => undefined);
      this.d.metrics.inc("commands.unauthorized");
      // On the userbot the text is just a chat message from someone else: let rules/plugins see it as usual.
      return inc.transport === "bot";
    }

    const def = this.d.registry.get(cmd.name);
    if (!def) {
      // On the userbot, ".something" may be ordinary text (and replying would overwrite the owner's own message).
      if (inc.transport === "userbot") return false;
      await inc.reply(`Unknown command "${cmd.name}". Try ${this.prefixFor(inc.transport)}help`).catch(() => undefined);
      return true;
    }

    const allowed = def.scope === "master" ? principal.isMaster : principal.scopes.has(def.scope);
    if (!allowed) {
      this.d.metrics.inc("commands.denied");
      await this.d.audit.add({ actorId: inc.senderId, action: `cmd.${def.name}`, result: "denied", details: { scope: def.scope } });
      await inc.reply(userMessage(new PermissionError(`You don't have the "${def.scope}" permission for ${def.name}`, "Ask the master admin to grant it."))).catch(() => undefined);
      return true;
    }

    if (!principal.isMaster && this.rateLimited(inc.senderId)) {
      await inc.reply("Slow down: too many commands in the last minute.").catch(() => undefined);
      return true;
    }

    const ctx = this.makeContext(inc, cmd, principal);
    this.d.metrics.inc("commands.total");
    try {
      await this.d.queue.add(`cmd:${def.name}`, () => def.run(ctx));
    } catch (err) {
      this.d.metrics.inc("commands.errors");
      this.d.logger.warn({ module: "commands", command: def.name, err: err instanceof Error ? err.message : String(err), code: err instanceof AppError ? err.code : undefined }, "command failed");
      await inc.reply(`⚠️ ${userMessage(err)}`).catch(() => undefined);
    }
    return true;
  }

  private rateLimited(userId: number): boolean {
    const t = this.now();
    const recent = (this.hits.get(userId) ?? []).filter((x) => t - x < 60_000);
    recent.push(t);
    this.hits.set(userId, recent);
    return recent.length > RATE_LIMIT_PER_MIN;
  }

  private makeContext(inc: IncomingCommand, cmd: NonNullable<ReturnType<typeof parseCommand>>, principal: CommandContext["principal"]): CommandContext {
    return {
      transport: inc.transport,
      principal,
      chatId: inc.chatId,
      messageId: inc.messageId,
      replyToId: inc.replyToId,
      cmd,
      reply: (t) => inc.reply(t),
      progress: (t) => inc.progress(t),
      getRepliedMessage: () => inc.getRepliedMessage(),
      targetChat: (explicit?: string): string | number => parseChatRef(cmd.options["chat"] ?? explicit, inc.transport === "userbot" ? inc.chatId : undefined),
      requireConfirmation: (spec) => this.requireConfirmation(inc, cmd, spec),
    };
  }

  private async requireConfirmation(inc: IncomingCommand, cmd: NonNullable<ReturnType<typeof parseCommand>>, spec: ConfirmSpec): Promise<void> {
    const { cfg, audit, confirmations } = this.d;
    const dryOnly = cmd.flags.has("dry");
    const oneShot = cmd.flags.has("yes") && !dryOnly && !cfg.commands.dryRunDefault;

    if (oneShot) {
      await this.execute(inc.senderId, spec, inc.reply);
      return;
    }
    await audit.add({ actorId: inc.senderId, action: spec.action, target: spec.target, details: spec.details, dryRun: true, result: "previewed" });
    if (dryOnly) {
      await inc.reply(`🧪 DRY RUN — ${spec.preview}\nNothing was changed.`);
      return;
    }
    const { token } = confirmations.create({ userId: inc.senderId, ...spec });
    const note = cmd.flags.has("yes") && cfg.commands.dryRunDefault ? "\n(One-step --yes is disabled while DRY_RUN_DEFAULT=true.)" : "";
    await inc.reply(`🧪 DRY RUN — ${spec.preview}${note}\nTo execute, send: ${this.prefixFor(inc.transport)}confirm ${token}  (valid ${cfg.commands.confirmTtlSec}s)`);
  }

  /** Executes a confirmed action with auditing. Used by one-shot --yes and by the `confirm` command. */
  async execute(actorId: number, p: { action: string; target?: string; details?: unknown; run: () => Promise<string> }, reply: (t: string) => Promise<void>): Promise<void> {
    try {
      const result = await p.run();
      await this.d.audit.add({ actorId, action: p.action, target: p.target, details: p.details, result: "ok" });
      await reply(`✅ ${result}`);
    } catch (err) {
      await this.d.audit.add({ actorId, action: p.action, target: p.target, details: p.details, result: `error: ${err instanceof Error ? err.message : String(err)}` });
      throw err;
    }
  }
}
