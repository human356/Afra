import type { AppConfig } from "../config";
import { AppError, UsageError } from "../core/errors";
import type { Messenger } from "../messaging/messenger";

const MAX_CHARS = 4000;

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export class Translator {
  constructor(
    private readonly cfg: AppConfig,
    private readonly messenger?: Messenger,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {}

  get provider(): AppConfig["translate"]["provider"] {
    return this.cfg.translate.provider;
  }

  async translate(text: string, target: string, source = "auto"): Promise<string> {
    if (!/^[A-Za-z]{2,3}(-[A-Za-z]{2,4})?$/.test(target)) throw new UsageError(`"${target}" is not a language code`, "Use codes like en, de, fa, es, zh-CN.");
    if (!text.trim()) throw new UsageError("Nothing to translate");
    if (text.length > MAX_CHARS) throw new UsageError(`Text is too long (${text.length} > ${MAX_CHARS} characters)`);

    switch (this.provider) {
      case "libretranslate": {
        const res = await this.fetchImpl(`${this.cfg.translate.url?.replace(/\/+$/, "")}/translate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ q: text, source, target, format: "text", ...(this.cfg.translate.apiKey ? { api_key: this.cfg.translate.apiKey } : {}) }),
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) throw new AppError(`Translation service answered HTTP ${res.status}`, "TRANSLATE_FAILED", "Check TRANSLATE_URL / TRANSLATE_API_KEY.");
        const body = (await res.json()) as { translatedText?: unknown };
        if (typeof body.translatedText !== "string") throw new AppError("Unexpected response from the translation service", "TRANSLATE_FAILED");
        return body.translatedText;
      }
      case "telegram": {
        if (!this.messenger) throw new AppError("Telegram translation needs a connected client", "TRANSLATE_FAILED");
        const m = this.messenger;
        const res = await m.call("translateText", () => m.client.translateText({ text, toLang: target.split("-")[0] as string }), "read");
        const first = (res as unknown as { result?: Array<{ text?: string }> }).result?.[0]?.text;
        if (!first) throw new AppError("Telegram returned no translation", "TRANSLATE_FAILED", "Server-side translation may be unavailable for this account; try TRANSLATE_PROVIDER=libretranslate.");
        return first;
      }
      default:
        throw new UsageError("Translation is not configured", "Set TRANSLATE_PROVIDER to libretranslate (with TRANSLATE_URL) or telegram.");
    }
  }
}
