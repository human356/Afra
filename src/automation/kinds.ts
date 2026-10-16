import { formatDuration } from "../core/time";
import type { Services } from "../core/services";

export interface ReminderPayload {
  via: "bot" | "userbot";
  chat: string | number;
  text: string;
}

/** Registers the built-in task kinds. Reminders are delivered even when late (better late than never). */
export function registerCoreTaskKinds(s: Services): void {
  s.scheduler.registerKind(
    "reminder",
    async (task, { lateSec }) => {
      const p = task.payload as unknown as ReminderPayload;
      const late = lateSec > 120 ? ` (delivered ${formatDuration(lateSec * 1000)} late)` : "";
      await s.deliver(p.via, p.chat, `⏰ ${p.text}${late}`);
    },
    { runIfLate: true },
  );
}
