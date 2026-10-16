import { UsageError } from "../core/errors";
import { describeMedia } from "../media/classify";
import { describeIds, resolveBotApiFileId } from "../media/ids";
import { formatBytes, toNum } from "../core/tg";
import type { Services } from "../core/services";
import { chatKey, intArg, resolveTargetMessage } from "./helpers";
import type { CommandRegistry } from "./registry";
import type { MediaKind } from "../core/tg";

/** Wraps an update function so it fires at most once per `ms` (avoids edit flood limits). */
export function throttled(update: (t: string) => Promise<void>, ms = 2500): (t: string) => void {
  let last = 0;
  let busy = false;
  return (t) => {
    const now = Date.now();
    if (busy || now - last < ms) return;
    last = now;
    busy = true;
    update(t)
      .catch(() => undefined)
      .finally(() => (busy = false));
  };
}

export function registerMediaCommands(reg: CommandRegistry, s: Services): void {
  reg.register({
    name: "mediainfo",
    group: "Media",
    scope: "media",
    usage: "mediainfo   (reply to a message with media)",
    description: "Classify and inspect media metadata",
    async run(ctx) {
      const { msg } = await resolveTargetMessage(ctx, s);
      const info = s.media.classify(msg);
      if (!info) throw new UsageError("That message has no media");
      await ctx.reply(describeMedia(info).join("\n"));
    },
  });

  reg.register({
    name: "dl",
    aliases: ["download"],
    group: "Media",
    scope: "media",
    usage: "dl   (reply to media) | dl --chat=.. --id=..",
    description: "Download the media to the organised local folder (resumable, de-duplicated)",
    async run(ctx) {
      const { msg, peer } = await resolveTargetMessage(ctx, s);
      const update = throttled(await ctx.progress("⬇️ Starting download…"));
      const r = await s.media.download(msg, {
        chatKey: chatKey(peer),
        chatId: toNum(msg.chatId),
        onProgress: (done, total) => update(`⬇️ ${formatBytes(done)}${total ? ` / ${formatBytes(total)} (${Math.floor((done / total) * 100)}%)` : ""}`),
      });
      const rel = r.path.replace(s.cfg.paths.downloadsDir, "downloads");
      await ctx.reply(r.duplicate ? `♻️ Already downloaded (same content): ${rel}` : `✅ Saved ${formatBytes(r.size)} → ${rel}${r.resumed ? " (resumed)" : ""}\nSHA-256 ${r.sha256.slice(0, 16)}…`);
    },
  });

  reg.register({
    name: "dlall",
    group: "Media",
    scope: "media",
    usage: "dlall [n] [--kind=photo,video,document,audio,voice] [--chat=...]",
    description: "Download media from the last n messages of a chat (max 200, sequential, paced)",
    async run(ctx) {
      const n = intArg(ctx.cmd.args[0], "n", { min: 1, max: 200, def: 20 });
      const kinds = new Set((ctx.cmd.options["kind"] ?? "").split(",").map((x) => x.trim()).filter(Boolean) as MediaKind[]);
      const peer = ctx.targetChat();
      const msgs = await s.messenger.history(peer, { limit: n });
      const withMedia = msgs.filter((x) => { const i = s.media.classify(x); return i && (kinds.size === 0 || kinds.has(i.kind)); });
      if (!withMedia.length) throw new UsageError("No matching media in those messages");
      const update = throttled(await ctx.progress(`⬇️ 0/${withMedia.length}`), 2500);
      let ok = 0;
      let dup = 0;
      let failed = 0;
      for (const [i, msg] of withMedia.entries()) {
        try {
          await s.pacer.wait("download");
          const r = await s.media.download(msg, { chatKey: chatKey(peer), chatId: toNum(msg.chatId) });
          if (r.duplicate) dup++;
          else ok++;
        } catch (err) {
          failed++;
          s.logger.warn({ module: "media", messageId: msg.id, err: err instanceof Error ? err.message : String(err) }, "bulk download item failed");
        }
        update(`⬇️ ${i + 1}/${withMedia.length}`);
      }
      await ctx.reply(`✅ Done: ${ok} new, ${dup} duplicate(s), ${failed} failed.`);
    },
  });

  reg.register({
    name: "fileid",
    group: "Media",
    scope: "media",
    usage: "fileid   (reply to media)",
    description: "Show MTProto identifiers and the Bot API file_id (best-effort)",
    async run(ctx) {
      const { msg } = await resolveTargetMessage(ctx, s);
      const r = describeIds(msg);
      if (!r) throw new UsageError("That message has no media");
      await ctx.reply(
        [
          `MTProto ${r.mtproto.type}: id=${r.mtproto.id}${r.mtproto.dcId ? ` dc=${r.mtproto.dcId}` : ""}${r.mtproto.fileReferenceBytes !== undefined ? ` file_reference=${r.mtproto.fileReferenceBytes} bytes` : ""}`,
          `Bot API file_id: ${r.botApiFileId ?? "(could not be packed)"}`,
          ...r.notes.map((n) => `• ${n}`),
        ].join("\n"),
      );
    },
  });

  reg.register({
    name: "botfileid",
    group: "Media",
    scope: "media",
    usage: "botfileid <file_id>",
    description: "Decode a Bot API file_id into MTProto identifiers",
    async run(ctx) {
      const id = ctx.cmd.args[0];
      if (!id) throw new UsageError("Give a Bot API file_id");
      const r = resolveBotApiFileId(id);
      if (!r) throw new UsageError("That is not a valid Bot API file_id");
      await ctx.reply(`Decoded ${r.type}: id=${r.id} access_hash=${r.accessHash} file_reference=${r.fileReferenceBytes} bytes\nThis is only an identifier; it does not prove the file is accessible to this account.`);
    },
  });
}
