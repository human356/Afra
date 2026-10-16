/**
 * Feature registry + capability probe.
 *
 * Every feature this project exposes lists the library symbols it needs. At startup (and via `npm run matrix`)
 * the probe checks the *installed* library, so the matrix never promises something the library does not have.
 * Status: supported | partial | unavailable.  `cap: "partial"` marks features with a known, documented limit.
 */
export type FeatureStatus = "supported" | "partial" | "unavailable";
export type Requirement = `client:${string}` | `api:${string}` | `event:${string}` | `util:${string}` | `session:${string}` | `error:${string}`;

export interface FeatureDef {
  id: string;
  area: string;
  title: string;
  requires: Requirement[];
  /** Upper bound for the status, used when a documented limitation applies even if every symbol exists. */
  cap?: "partial";
  note?: string;
}

export interface FeatureResult extends FeatureDef {
  status: FeatureStatus;
  missing: Requirement[];
}

export interface LibLike {
  version?: string;
  TelegramClient: { prototype: object };
  Api: Record<string, unknown>;
  events: Record<string, unknown>;
  utils: Record<string, unknown>;
  sessions: Record<string, unknown>;
  errors: Record<string, unknown>;
}

export const FEATURES: FeatureDef[] = [
  // ---- authentication & connection
  { id: "auth.user", area: "Authentication", title: "User login (phone, code, 2FA password) via local CLI only", requires: ["client:start", "client:isUserAuthorized"] },
  { id: "auth.bot", area: "Authentication", title: "Control-bot login with a BotFather token", requires: ["client:signInBot"] },
  { id: "auth.session", area: "Authentication", title: "Session persistence (encrypted at rest when a key is set)", requires: ["session:StringSession"] },
  { id: "net.reconnect", area: "Connection", title: "Automatic reconnection + watchdog", requires: ["client:connect", "client:disconnect"] },
  { id: "net.floodwait", area: "Connection", title: "FloodWait detection and honoured waits (never evaded)", requires: ["error:FloodWaitError"] },

  // ---- messaging
  { id: "msg.text", area: "Messaging", title: "Send text and replies", requires: ["client:sendMessage"] },
  { id: "msg.media", area: "Messaging", title: "Send photos, videos, documents with captions", requires: ["client:sendFile"] },
  { id: "msg.album", area: "Messaging", title: "Albums (grouped media)", requires: ["client:sendFile"], note: "2-10 items per album (Telegram limit)." },
  { id: "msg.voice", area: "Messaging", title: "Voice and video notes", requires: ["client:sendFile"] },
  { id: "msg.forward", area: "Messaging", title: "Forward and copy messages", requires: ["client:forwardMessages", "client:copyMessages"] },
  { id: "msg.edit", area: "Messaging", title: "Edit messages", requires: ["client:editMessage"] },
  { id: "msg.delete", area: "Messaging", title: "Delete messages (dry-run + confirmation)", requires: ["client:deleteMessages"] },
  { id: "msg.history", area: "Messaging", title: "History retrieval", requires: ["client:getMessages", "client:iterMessages"] },
  { id: "msg.drafts", area: "Messaging", title: "Drafts (save, clear, list)", requires: ["client:saveDraft", "client:clearDraft", "api:messages.GetAllDrafts"] },
  { id: "msg.scheduled", area: "Messaging", title: "Telegram-native scheduled messages", requires: ["client:sendMessage", "client:getScheduledMessages", "client:deleteScheduledMessages"] },
  { id: "msg.saved", area: "Messaging", title: "Saved Messages", requires: ["client:sendMessage"] },
  { id: "msg.reactions", area: "Messaging", title: "Reactions (used by the react rule action)", requires: ["client:sendReaction"] },
  {
    id: "msg.events",
    area: "Messaging",
    title: "Message event handlers (new / edited / deleted)",
    requires: ["event:NewMessage", "event:EditedMessage", "event:DeletedMessage"],
    cap: "partial",
    note: "Deleted-message events carry only IDs; the chat id is missing for private chats and basic groups.",
  },

  // ---- chats
  { id: "chats.list", area: "Chats", title: "List dialogs", requires: ["client:getDialogs"] },
  {
    id: "chats.folders",
    area: "Chats",
    title: "Chat folders (list, add/remove a chat)",
    requires: ["client:getDialogFilters", "client:updateDialogFilter", "api:DialogFilter"],
    cap: "partial",
    note: "Folder schema changes between Telegram layers; only plain custom folders are edited, never chatlist folders.",
  },
  { id: "chats.mute", area: "Chats", title: "Mute / unmute", requires: ["client:updateNotifySettings"] },
  { id: "chats.archive", area: "Chats", title: "Archive / unarchive", requires: ["client:editPeerFolders"] },

  // ---- media
  { id: "media.classify", area: "Media", title: "Media classification and metadata inspection", requires: [] },
  { id: "media.download", area: "Media", title: "User-selected downloads with progress reporting", requires: ["client:downloadMedia", "client:iterDownload"] },
  {
    id: "media.resume",
    area: "Media",
    title: "Resumable downloads",
    requires: ["client:iterDownload"],
    cap: "partial",
    note: "Documents resume from the last whole chunk of the .part file. Photos are small and are re-downloaded.",
  },
  { id: "media.dedupe", area: "Media", title: "SHA-256 duplicate detection, organised storage, naming rules", requires: [] },

  // ---- stickers & emoji
  { id: "stickers.inspect", area: "Stickers", title: "Sticker / custom-emoji metadata and format detection", requires: [] },
  { id: "stickers.sets", area: "Stickers", title: "Browse sticker sets by short name", requires: ["client:getStickerSet", "api:InputStickerSetShortName"] },
  { id: "stickers.installed", area: "Stickers", title: "List installed sticker sets", requires: ["client:getAllStickers"] },
  { id: "emoji.custom", area: "Stickers", title: "Custom emoji documents", requires: ["client:getCustomEmojiDocuments"] },
  { id: "stickers.export", area: "Stickers", title: "Export sticker files you can access", requires: ["client:downloadMedia"] },

  // ---- identifiers
  { id: "ids.mtproto", area: "Identifiers", title: "Show MTProto identifiers (id, access hash, DC, size)", requires: [] },
  {
    id: "ids.botfileid",
    area: "Identifiers",
    title: "Bot API file_id <-> MTProto conversion",
    requires: ["util:packBotFileId", "util:resolveBotFileId"],
    cap: "partial",
    note: "MTProto file references and access hashes are account-bound. Conversion is best-effort; a converted ID is only guaranteed to work in the context that produced it.",
  },

  // ---- search & archive
  { id: "search.live", area: "Search", title: "Search messages in a chat (Telegram-side)", requires: ["client:iterMessages", "api:messages.Search"] },
  { id: "search.archive", area: "Search", title: "Opt-in local archive + search (off by default)", requires: [] },
  { id: "search.export", area: "Search", title: "Export chat history to JSONL (paced)", requires: ["client:iterMessages"] },

  // ---- automation
  { id: "auto.rules", area: "Automation", title: "Keyword/regex rules with allow/block lists and cooldowns", requires: [] },
  { id: "auto.tasks", area: "Automation", title: "Reminders and scheduled personal tasks (persistent)", requires: [] },
  { id: "auto.transform", area: "Automation", title: "Text transformations", requires: [] },
  {
    id: "auto.translate",
    area: "Automation",
    title: "Translation (LibreTranslate-compatible HTTP or Telegram-native)",
    requires: ["client:translateText"],
    cap: "partial",
    note: "Telegram-native translation depends on server-side availability for the account; the HTTP provider is external and opt-in.",
  },
  { id: "auto.ai", area: "Automation", title: "Optional AI summarise/classify (explicit opt-in, text you pass only)", requires: [] },

  // ---- administration
  { id: "admin.participants", area: "Administration", title: "List participants / admins", requires: ["client:getParticipants"] },
  {
    id: "admin.permissions",
    area: "Administration",
    title: "Role and permission checks",
    requires: ["client:getParticipant", "api:messages.GetFullChat"],
    cap: "partial",
    note: "The library has no getPermissions helper; rights are derived from GetParticipant (channels/supergroups) and GetFullChat (basic groups).",
  },
  { id: "admin.moderate", area: "Administration", title: "Kick / ban / unban / purge (only with real rights; audited)", requires: ["client:kickParticipant", "client:editBanned", "client:deleteMessages"] },
  { id: "admin.log", area: "Administration", title: "Read the channel admin log", requires: ["client:getAdminLog"] },

  // ---- contacts & profile
  { id: "profile.whois", area: "Contacts & profile", title: "Look up users/chats", requires: ["client:getEntity"] },
  { id: "profile.contacts", area: "Contacts & profile", title: "List and search contacts", requires: ["client:getContacts"] },
  { id: "profile.edit", area: "Contacts & profile", title: "Edit own name/bio (confirmation required)", requires: ["client:updateProfile"] },
];

export function hasRequirement(lib: LibLike, req: Requirement): boolean {
  const idx = req.indexOf(":");
  const kind = req.slice(0, idx);
  const name = req.slice(idx + 1);
  switch (kind) {
    case "client":
      return typeof (lib.TelegramClient.prototype as Record<string, unknown>)[name] === "function";
    case "api": {
      let cur: unknown = lib.Api;
      for (const part of name.split(".")) {
        if (cur === null || cur === undefined || (typeof cur !== "object" && typeof cur !== "function")) return false;
        cur = (cur as Record<string, unknown>)[part];
      }
      return typeof cur === "function" || (typeof cur === "object" && cur !== null);
    }
    case "event":
      return typeof lib.events[name] === "function";
    case "util":
      return typeof lib.utils[name] === "function";
    case "session":
      return typeof lib.sessions[name] === "function";
    case "error":
      return typeof lib.errors[name] === "function";
    default:
      return false;
  }
}

export interface ProbeResult {
  library: { name: string; version: string };
  features: FeatureResult[];
  summary: Record<FeatureStatus, number>;
}

export function probeFeatures(lib: LibLike, defs: FeatureDef[] = FEATURES): ProbeResult {
  const features: FeatureResult[] = defs.map((d) => {
    const missing = d.requires.filter((r) => !hasRequirement(lib, r));
    let status: FeatureStatus;
    if (missing.length === 0) status = d.cap ?? "supported";
    else if (missing.length < d.requires.length) status = "partial";
    else status = "unavailable";
    return { ...d, status, missing };
  });
  const summary: Record<FeatureStatus, number> = { supported: 0, partial: 0, unavailable: 0 };
  for (const f of features) summary[f.status]++;
  return { library: { name: "teleproto", version: lib.version ?? "unknown" }, features, summary };
}

const ICON: Record<FeatureStatus, string> = { supported: "✅ supported", partial: "🟡 partial", unavailable: "❌ unavailable" };

export function renderMatrixMarkdown(result: ProbeResult): string {
  const lines: string[] = [
    "# Feature matrix",
    "",
    `Generated by \`npm run matrix\` from the **installed** library (\`${result.library.name}@${result.library.version}\`).`,
    "Each feature lists the library symbols it needs; nothing is claimed that the library does not expose.",
    "",
    `**Summary:** ${result.summary.supported} supported, ${result.summary.partial} partial, ${result.summary.unavailable} unavailable.`,
    "",
  ];
  const areas = [...new Set(result.features.map((f) => f.area))];
  for (const area of areas) {
    lines.push(`## ${area}`, "", "| Feature | Status | Notes |", "| --- | --- | --- |");
    for (const f of result.features.filter((x) => x.area === area)) {
      const note = [f.note, f.missing.length ? `missing: ${f.missing.join(", ")}` : ""].filter(Boolean).join(" ");
      lines.push(`| ${f.title} | ${ICON[f.status]} | ${note || "—"} |`);
    }
    lines.push("");
  }
  lines.push(
    "## Deliberately not implemented",
    "",
    "- **Bulk / unsolicited messaging, scraping members to message them, joining-to-spam** — against Telegram's terms; not provided.",
    "- **Rate-limit evasion** (multi-account rotation, proxy hopping, paid flood-skip options) — never used; FloodWait is always honoured.",
    "- **Secret chats (end-to-end)** — the MTProto client does not implement them.",
    "- **Voice/video calls, stories, Stars/TON wallet, communities** — out of scope for this project.",
    "- **Privacy bypasses** — nothing here reveals data Telegram's privacy settings hide.",
    "",
  );
  return lines.join("\n");
}
