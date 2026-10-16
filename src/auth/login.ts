import type { Api } from "teleproto";
import type { AppConfig } from "../config";
import { userMessage } from "../core/errors";
import { SessionStore } from "./sessionStore";
import { buildClient } from "./clients";

export type LoginStep = "confirm" | "phone" | "code" | "password";

export interface LoginIO {
  /** `kind` tells non-terminal front ends (the web setup page) which input is being requested. */
  ask(question: string, kind?: LoginStep): Promise<string>;
  /** Input that must not be echoed (login code, 2FA password). */
  askSecret(question: string, kind?: LoginStep): Promise<string>;
  print(line: string): void;
}

/**
 * Interactive sign-in. Codes and passwords are only ever read from the terminal and passed to Telegram;
 * they are never logged, stored or shown elsewhere. Only the resulting session is saved.
 */
export async function interactiveLogin(cfg: AppConfig, store: SessionStore, io: LoginIO): Promise<Api.User> {
  if (store.exists()) {
    const a = (await io.ask("A session already exists. Replace it? [y/N] ", "confirm")).trim().toLowerCase();
    if (a !== "y" && a !== "yes") throw new Error("Cancelled; existing session kept.");
  }
  const client = buildClient(cfg, "");
  try {
    await client.start({
      phoneNumber: () => io.ask("Phone number (international format, e.g. +491701234567): ", "phone"),
      phoneCode: () => io.askSecret("Login code sent by Telegram: ", "code"),
      password: () => io.askSecret("2FA password (leave empty if none): ", "password"),
      onError: async (err: Error) => {
        io.print(`Login error: ${userMessage(err)}`);
        return true; // stop instead of looping; avoids hammering Telegram's login endpoints
      },
    });
    store.save(client.session.save() as unknown as string);
    const me = (await client.getMe()) as Api.User;
    io.print(`Signed in as ${me.firstName ?? ""} (id ${me.id.toString()}${me.username ? `, @${me.username}` : ""}).`);
    if (Number(me.id.toString()) !== cfg.telegram.masterAdminId) {
      io.print(`Note: this account is not MASTER_ADMIN_ID (${cfg.telegram.masterAdminId}). That is fine — the master admin controls the bot, and can grant "self mode" to this account explicitly.`);
    }
    return me;
  } finally {
    await client.disconnect().catch(() => undefined);
  }
}
