import type { Api } from "teleproto";
import { lib } from "../core/library";
import { toNum } from "../core/tg";
import { classifyMessage } from "./classify";

export interface IdReport {
  mtproto: { type: string; id: string; accessHash?: string; dcId?: number; fileReferenceBytes?: number };
  botApiFileId?: string;
  notes: string[];
}

/**
 * MTProto identifiers (id + access_hash + file_reference, per DC) are what the user API uses.
 * Bot API file_id is a different, packed string. Conversion uses the library's own pack/resolve helpers and is
 * only best-effort: file references expire and access hashes are account-bound.
 */
export function describeIds(msg: Pick<Api.Message, "photo" | "document">): IdReport | undefined {
  const info = classifyMessage(msg);
  if (!info) return undefined;
  const media = (msg.document ?? msg.photo) as (Api.Document | Api.Photo) | undefined;
  const ref = (media as unknown as { fileReference?: Buffer } | undefined)?.fileReference;
  let botApiFileId: string | undefined;
  try {
    botApiFileId = media ? lib.utils.packBotFileId(media) : undefined;
  } catch {
    botApiFileId = undefined;
  }
  return {
    mtproto: { ...info.mtproto, fileReferenceBytes: ref?.length },
    botApiFileId,
    notes: [
      "MTProto id/access_hash are bound to the account that saw the file; do not share them as if they were public links.",
      "file_reference expires — re-fetch the message to get a fresh one.",
      "A Bot API file_id is only guaranteed to work in the bot context that produced it.",
    ],
  };
}

export interface ResolvedBotFileId {
  type: "document" | "photo";
  id: string;
  accessHash: string;
  fileReferenceBytes: number;
}

/** Decodes a Bot API file_id into MTProto identifiers using the library (returns undefined if it is not valid). */
export function resolveBotApiFileId(fileId: string): ResolvedBotFileId | undefined {
  try {
    const r = lib.utils.resolveBotFileId(fileId) as (Api.InputDocument | Api.InputPhoto) | undefined;
    if (!r) return undefined;
    return {
      type: r.className === "InputPhoto" ? "photo" : "document",
      id: String(r.id),
      accessHash: String(r.accessHash),
      fileReferenceBytes: toNum((r.fileReference as Buffer | undefined)?.length) ?? 0,
    };
  } catch {
    return undefined;
  }
}
