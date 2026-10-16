import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AppError } from "../core/errors";

const MAGIC = "TGUB1:";

export interface SessionInfo {
  exists: boolean;
  encrypted: boolean;
  /** True when the file is readable by group/others (should be 0600). */
  looseMode: boolean;
}

/** Stores a Telegram session string on disk: atomic writes, mode 0600, optional AES-256-GCM encryption. */
export class SessionStore {
  constructor(
    private readonly file: string,
    private readonly encryptionKey?: string,
  ) {}

  exists(): boolean {
    return fs.existsSync(this.file);
  }

  info(): SessionInfo {
    if (!this.exists()) return { exists: false, encrypted: false, looseMode: false };
    const head = fs.readFileSync(this.file, "utf8").slice(0, MAGIC.length);
    let looseMode = false;
    try {
      looseMode = (fs.statSync(this.file).mode & 0o077) !== 0;
    } catch {
      /* ignore */
    }
    return { exists: true, encrypted: head === MAGIC, looseMode };
  }

  load(): string | undefined {
    if (!this.exists()) return undefined;
    const raw = fs.readFileSync(this.file, "utf8").trim();
    if (!raw) return undefined;
    if (!raw.startsWith(MAGIC)) return raw; // plaintext (legacy or encryption disabled)
    if (!this.encryptionKey) {
      throw new AppError("Session file is encrypted but SESSION_ENCRYPTION_KEY is not set", "SESSION_KEY_MISSING", "Set SESSION_ENCRYPTION_KEY to the value used when the session was created.");
    }
    try {
      const buf = Buffer.from(raw.slice(MAGIC.length), "base64");
      const salt = buf.subarray(0, 16);
      const iv = buf.subarray(16, 28);
      const tag = buf.subarray(28, 44);
      const data = buf.subarray(44);
      const key = crypto.scryptSync(this.encryptionKey, salt, 32);
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
    } catch (err) {
      throw new AppError("Could not decrypt the session file (wrong SESSION_ENCRYPTION_KEY or corrupted file)", "SESSION_DECRYPT_FAILED", "Fix the key, or delete the session file and run `npm run login` again.", { cause: err });
    }
  }

  save(session: string): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    let payload = session;
    if (this.encryptionKey) {
      const salt = crypto.randomBytes(16);
      const iv = crypto.randomBytes(12);
      const key = crypto.scryptSync(this.encryptionKey, salt, 32);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const enc = Buffer.concat([cipher.update(session, "utf8"), cipher.final()]);
      payload = MAGIC + Buffer.concat([salt, iv, cipher.getAuthTag(), enc]).toString("base64");
    }
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, payload, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    fs.chmodSync(this.file, 0o600);
  }

  remove(): boolean {
    if (!this.exists()) return false;
    fs.rmSync(this.file, { force: true });
    return true;
  }

  /** Moves an unusable session aside (kept for inspection) so a fresh login can be created. */
  quarantine(): string | undefined {
    if (!this.exists()) return undefined;
    const target = `${this.file}.invalid-${Date.now()}`;
    fs.renameSync(this.file, target);
    return target;
  }
}
