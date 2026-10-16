import type { Services } from "../core/services";
import { registerAdminCommands } from "./admin";
import { registerAutomationCommands } from "./automation";
import { registerChatCommands } from "./chats";
import { registerCoreCommands } from "./core";
import { registerMediaCommands } from "./media";
import { registerMessagingCommands } from "./messaging";
import { registerPluginCommands } from "./plugins";
import { registerProfileCommands } from "./profile";
import type { CommandRegistry } from "./registry";
import { registerSearchCommands } from "./search";
import { registerStickerCommands } from "./stickers";

export function registerAllCommands(reg: CommandRegistry, s: Services): void {
  registerCoreCommands(reg, s);
  registerMessagingCommands(reg, s);
  registerChatCommands(reg, s);
  registerMediaCommands(reg, s);
  registerStickerCommands(reg, s);
  registerSearchCommands(reg, s);
  registerAutomationCommands(reg, s);
  registerAdminCommands(reg, s);
  registerProfileCommands(reg, s);
  registerPluginCommands(reg, s);
}
