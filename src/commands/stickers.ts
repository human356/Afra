import { UsageError } from "../core/errors";
import { formatBytes } from "../core/tg";
import type { Services } from "../core/services";
import { describeMedia } from "../media/classify";
import { intArg, resolveTargetMessage } from "./helpers";
import { throttled } from "./media";
import type { CommandRegistry } from "./registry";

export function registerStickerCommands(reg: CommandRegistry, s: Services): void {
  reg.register({
    name: "stickerinfo",
    group: "Stickers",
    scope: "media",
    usage: "stickerinfo   (reply to a sticker)",
    description: "Sticker metadata and format (static / animated / video)",
    async run(ctx) {
      const { msg } = await resolveTargetMessage(ctx, s);
      const info = s.stickers.inspect(msg);
      if (!info) throw new UsageError("That message is not a sticker or custom emoji");
      await ctx.reply(describeMedia(info).join("\n"));
    },
  });

  reg.register({
    name: "stickerset",
    group: "Stickers",
    scope: "media",
    usage: "stickerset <short name | t.me link>",
    description: "Browse a public sticker set",
    async run(ctx) {
      const name = ctx.cmd.args[0];
      if (!name) throw new UsageError("Usage: stickerset <short name>");
      const set = await s.stickers.getSet(name);
      await ctx.reply(
        [`${set.title} (${set.shortName})`, `${set.count} ${set.kind} · ${set.format}${set.official ? " · official" : ""}`, `Preview: ${set.items.map((i) => `${i.alt ?? "·"} ${i.size ? formatBytes(i.size) : ""}`.trim()).join("  ")}`].join("\n"),
      );
    },
  });

  reg.register({
    name: "stickers",
    group: "Stickers",
    scope: "media",
    usage: "stickers",
    description: "List installed sticker sets",
    async run(ctx) {
      const sets = await s.stickers.installed();
      await ctx.reply(sets.length ? sets.slice(0, 40).map((x) => `${x.shortName} · ${x.title} · ${x.count} ${x.kind}`).join("\n") : "No installed sets.");
    },
  });

  reg.register({
    name: "emoji",
    group: "Stickers",
    scope: "media",
    usage: "emoji   (reply to a message with custom emoji)",
    description: "Identify custom emoji used in a message",
    async run(ctx) {
      const { msg } = await resolveTargetMessage(ctx, s);
      const list = await s.stickers.customEmoji(msg);
      await ctx.reply(list.length ? list.map((e) => `${e.alt ?? "·"} id=${e.documentId} ${e.mime ?? ""}`).join("\n") : "No custom emoji in that message.");
    },
  });

  reg.register({
    name: "stickerexport",
    group: "Stickers",
    scope: "media",
    usage: "stickerexport <short name> [--limit=30]",
    description: "Download a sticker set's files for personal use (max 200)",
    async run(ctx) {
      const name = ctx.cmd.args[0];
      if (!name) throw new UsageError("Usage: stickerexport <short name>");
      const update = throttled(await ctx.progress("⬇️ Exporting…"));
      const r = await s.stickers.exportSet(name, intArg(ctx.cmd.options["limit"], "--limit", { min: 1, max: 200, def: 30 }), (d, t) => update(`⬇️ ${d}/${t}`));
      await ctx.reply(`✅ Exported ${r.files} file(s) to ${r.dir.replace(s.cfg.paths.dataDir, "data")}\nSticker art may be copyrighted: keep exports for personal use.`);
    },
  });
}
