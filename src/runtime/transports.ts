import { Api } from "teleproto";
import { lib } from "../core/library";
import { toNum } from "../core/tg";
import type { Services } from "../core/services";
import type { IncomingCommand } from "../commands/dispatcher";
import { Responder } from "./responder";

type MsgEvent = InstanceType<typeof lib.events.NewMessageEvent>;

export function chatTypeOf(msg: Pick<Api.Message, "peerId" | "post">): "private" | "group" | "channel" {
  const cls = (msg.peerId as { className?: string } | undefined)?.className;
  if (cls === "PeerUser") return "private";
  if (cls === "PeerChat") return "group";
  return msg.post ? "channel" : "group";
}

/**
 * Userbot transport: commands typed from authorised accounts (the master admin, or users granted self mode)
 * in any chat. For the account's own outgoing commands the command message is replaced by the result.
 * Everybody else is ignored silently.
 */
export function attachUserbotTransport(s: Services): void {
  s.client.addEventHandler(async (event: MsgEvent) => {
    const msg = event.message;
    const text = msg.message ?? "";
    const chatId = toNum(event.chatId ?? msg.chatId);
    const senderId = toNum(msg.senderId);
    if (chatId === undefined) return;
    s.metrics.inc("events.messages");

    try {
      if (senderId !== undefined && text.startsWith(s.cfg.commands.prefix)) {
        const responder = new Responder(s.messenger, chatId, { replyTo: msg.id, editFirst: msg.out ? msg.id : undefined });
        const inc: IncomingCommand = {
          transport: "userbot",
          senderId,
          chatId: String(chatId),
          messageId: msg.id,
          replyToId: msg.replyToMsgId,
          text,
          reply: (t) => responder.show(t),
          progress: async (initial) => {
            await responder.show(initial);
            return (t) => responder.show(t);
          },
          getRepliedMessage: async () => (msg.isReply ? await msg.getReplyMessage().catch(() => undefined) : undefined),
        };
        if (await s.dispatcher.handle(inc)) return;
      }
      await passiveProcessing(s, msg, chatId, senderId, text);
    } catch (err) {
      s.logger.error({ module: "transport", err: err instanceof Error ? err.message : String(err) }, "message handler error");
    }
  }, new lib.events.NewMessage({}));
  s.logger.info({ module: "transport", prefix: s.cfg.commands.prefix }, "userbot transport attached");
}

/** Archive (opt-in), rules and plugins. Runs through the bounded queue; if the queue is full the work is dropped, not piled up. */
async function passiveProcessing(s: Services, msg: Api.Message, chatId: number, senderId: number | undefined, text: string): Promise<void> {
  const chatType = chatTypeOf(msg);
  const queueJob = (name: string, fn: () => Promise<unknown>): void => {
    void s.queue.add(name, fn).catch((err: unknown) => {
      if ((err as { code?: string }).code === "QUEUE_FULL") s.metrics.inc("events.dropped");
    });
  };

  if (s.search.archivingAvailable) queueJob("archive", () => s.search.maybeArchive(chatId, msg));

  if (text && !msg.out) {
    queueJob("rules", async () => {
      if (!(await s.rules.mightApply(chatId))) return;
      const sender = (await msg.getSender().catch(() => undefined)) as Api.User | undefined;
      await s.rules.handle({ text, chatId, chatType, senderId, isOut: Boolean(msg.out), isBot: sender?.className === "User" && Boolean(sender.bot), messageId: msg.id }, chatId);
    });
  }
  if (text) queueJob("plugins", () => s.plugins.dispatchMessage({ text, chatId, chatType, senderId, messageId: msg.id, isOut: Boolean(msg.out) }));
}

/** Control-bot transport: private chat with the BotFather bot. Master admin manages access here. */
export function attachBotTransport(s: Services): void {
  if (!s.bot || !s.botMessenger) return;
  const bm = s.botMessenger;
  s.bot.client.addEventHandler(async (event: MsgEvent) => {
    const msg = event.message;
    const senderId = toNum(msg.senderId);
    const chatId = toNum(event.chatId ?? msg.chatId);
    if (senderId === undefined || chatId === undefined || msg.out) return;
    if ((msg.peerId as { className?: string }).className !== "PeerUser") return; // private chats only
    try {
      const responder = new Responder(bm, chatId, { replyTo: msg.id });
      await s.dispatcher.handle({
        transport: "bot",
        senderId,
        chatId: String(chatId),
        messageId: msg.id,
        text: msg.message ?? "",
        reply: (t) => responder.show(t),
        progress: async (initial) => {
          await responder.show(initial);
          return (t) => responder.show(t);
        },
        getRepliedMessage: async () => undefined, // the bot cannot see the userbot account's messages
      });
    } catch (err) {
      s.logger.error({ module: "bot-transport", err: err instanceof Error ? err.message : String(err) }, "bot handler error");
    }
  }, new lib.events.NewMessage({}));
  s.logger.info({ module: "transport", bot: s.bot.account.username }, "control bot transport attached");
}
