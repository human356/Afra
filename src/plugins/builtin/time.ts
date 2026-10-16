import { z } from "zod";
import { UsageError } from "../../core/errors";
import type { Plugin } from "../types";

/** Built-in example plugin: `.time [IANA time zone]`. Doubles as a reference implementation. */
export const timePlugin: Plugin = {
  manifest: {
    name: "time",
    version: "1.0.0",
    description: "Shows the current time in any IANA time zone (e.g. .time Asia/Tehran).",
    apiVersion: 1,
    configSchema: z.object({ defaultZone: z.string().default("UTC") }),
    defaults: { defaultZone: "UTC" },
  },
  activate(ctx) {
    ctx.registerCommand({
      name: "time",
      usage: "time [zone]",
      description: "Current time in a time zone",
      async run(c) {
        const zone = c.cmd.args[0] ?? String(ctx.config["defaultZone"] ?? "UTC");
        try {
          const text = new Intl.DateTimeFormat("en-GB", { dateStyle: "full", timeStyle: "long", timeZone: zone }).format(new Date());
          await c.reply(`🕒 ${zone}: ${text}`);
        } catch {
          throw new UsageError(`"${zone}" is not a valid IANA time zone`, "Examples: UTC, Europe/Berlin, Asia/Tehran.");
        }
      },
    });
  },
};
