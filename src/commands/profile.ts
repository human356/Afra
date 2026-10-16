import type { Api } from "teleproto";
import { UsageError } from "../core/errors";
import { parseChatRef, toNum } from "../core/tg";
import type { Services } from "../core/services";
import { intArg } from "./helpers";
import type { CommandRegistry } from "./registry";

export function registerProfileCommands(reg: CommandRegistry, s: Services): void {
  reg.register({
    name: "whois",
    group: "Contacts & profile",
    scope: "search",
    usage: "whois <user|chat>   (or reply)",
    description: "Public info about a user or chat (phone numbers are never shown)",
    async run(ctx) {
      const arg = ctx.cmd.args[0];
      const replied = arg ? undefined : await ctx.getRepliedMessage();
      const ref = arg ? parseChatRef(arg) : toNum(replied?.senderId);
      if (ref === undefined) throw new UsageError("Give a user/chat, or reply to a message");
      const e = (await s.messenger.call("getEntity", () => s.client.getEntity(ref), "read")) as unknown as Record<string, unknown>;
      const flags = ["bot", "verified", "scam", "fake", "deleted", "premium", "restricted"].filter((f) => e[f] === true);
      const name = [e["firstName"], e["lastName"]].filter(Boolean).join(" ") || (e["title"] as string | undefined) || "(unnamed)";
      await ctx.reply([`${e["className"]}: ${name}`, `id: ${toNum(e["id"])}`, e["username"] ? `username: @${e["username"]}` : "", flags.length ? `flags: ${flags.join(", ")}` : ""].filter(Boolean).join("\n"));
    },
  });

  reg.register({
    name: "contacts",
    group: "Contacts & profile",
    scope: "search",
    usage: "contacts [query] [--limit=20]",
    description: "List/search this account's contacts (id, name, username only)",
    async run(ctx) {
      const q = ctx.cmd.args.join(" ").toLowerCase();
      const all = await s.messenger.call("getContacts", () => s.client.getContacts(), "read");
      const hits = all.filter((u: Api.User) => !q || `${u.firstName ?? ""} ${u.lastName ?? ""} ${u.username ?? ""}`.toLowerCase().includes(q));
      const limit = intArg(ctx.cmd.options["limit"], "--limit", { min: 1, max: 50, def: 20 });
      await ctx.reply(`${hits.length} of ${all.length} contact(s)${hits.length > limit ? `, showing ${limit}` : ""}:\n${hits.slice(0, limit).map((u) => `${toNum(u.id)} · ${[u.firstName, u.lastName].filter(Boolean).join(" ")}${u.username ? ` (@${u.username})` : ""}`).join("\n")}`);
    },
  });

  reg.register({
    name: "profile",
    group: "Contacts & profile",
    scope: "master",
    usage: "profile first|last|about <text>",
    description: "Change this account's name or bio (dry-run + confirmation)",
    async run(ctx) {
      const field = ctx.cmd.args[0];
      if (field !== "first" && field !== "last" && field !== "about") throw new UsageError("Usage: profile first|last|about <text>");
      const text = ctx.cmd.rest.replace(/^\S+\s*/, "");
      if (field === "first" && !text) throw new UsageError("The first name can't be empty");
      if (text.length > (field === "about" ? 70 : 64)) throw new UsageError(`Too long (max ${field === "about" ? 70 : 64} characters)`);
      const key = field === "first" ? "firstName" : field === "last" ? "lastName" : "about";
      await ctx.requireConfirmation({ action: "profile.update", target: field, details: { field }, preview: `set your ${field} to “${text}”`, run: async () => (await s.messenger.call("updateProfile", () => s.client.updateProfile({ [key]: text })), "Profile updated.") });
    },
  });
}
