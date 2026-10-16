import { chunkText } from "../core/tg";
import type { Messenger, Peer } from "../messaging/messenger";

const isNotModified = (e: unknown): boolean => /MESSAGE_NOT_MODIFIED/.test(`${(e as { errorMessage?: string }).errorMessage ?? ""} ${(e as Error)?.message ?? ""}`);

/**
 * One visible "response message" per command: the first call edits the command message (own outgoing commands)
 * or sends a reply; later calls (progress, final result) edit that same message in place.
 */
export class Responder {
  private shownId: number | undefined;

  constructor(
    private readonly m: Messenger,
    private readonly peer: Peer,
    private readonly opts: { replyTo?: number; editFirst?: number } = {},
  ) {
    this.shownId = opts.editFirst;
  }

  async show(text: string): Promise<void> {
    const [first, ...rest] = chunkText(text.length ? text : "(empty)");
    if (this.shownId !== undefined) {
      try {
        await this.m.edit(this.peer, this.shownId, first as string);
      } catch (err) {
        if (!isNotModified(err)) {
          const sent = await this.m.sendText(this.peer, first as string, { replyTo: this.opts.replyTo });
          this.shownId = sent[0]?.id;
        }
      }
    } else {
      const sent = await this.m.sendText(this.peer, first as string, { replyTo: this.opts.replyTo });
      this.shownId = sent[0]?.id;
    }
    for (const part of rest) await this.m.sendText(this.peer, part);
  }
}
