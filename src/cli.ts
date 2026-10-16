import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { buildClient } from "./auth/clients";
import { interactiveLogin } from "./auth/login";
import { terminalIO } from "./auth/prompt";
import { SessionStore } from "./auth/sessionStore";
import { loadConfig } from "./config";
import { AppError } from "./core/errors";
import { probeFeatures, renderMatrixMarkdown } from "./core/features";
import { libInfo } from "./core/library";
import { openDatabase } from "./storage";
import { backupConfig } from "./storage/backup";

const HELP = `Usage: npm run <command>
  login     Sign in with your phone number (code / 2FA are typed here, never stored)
  logout    Delete the stored session file
  doctor    Check configuration, database, session and (with --online) the Telegram connection
  backup    Back up local configuration to DATA_DIR/backups
  matrix    Print the feature matrix for the installed library (--write updates docs/FEATURE_MATRIX.md)`;

async function main(): Promise<number> {
  dotenv.config({ quiet: true });
  const [cmd, ...flags] = process.argv.slice(2);

  if (cmd === "matrix") {
    const md = renderMatrixMarkdown(probeFeatures(libInfo()));
    if (flags.includes("--write")) {
      const file = path.join(process.cwd(), "docs", "FEATURE_MATRIX.md");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, md);
      console.log(`wrote ${path.relative(process.cwd(), file)}`);
    } else console.log(md);
    return 0;
  }

  const cfg = loadConfig(process.env, process.cwd(), { lenient: true });
  const store = new SessionStore(cfg.paths.sessionFile, cfg.security.sessionEncryptionKey);

  switch (cmd) {
    case "login": {
      const io = terminalIO();
      try {
        await interactiveLogin(cfg, store, io);
        console.log("Session saved. Start the bot with `npm start`.");
      } finally {
        io.close();
      }
      return 0;
    }
    case "logout": {
      console.log(store.remove() ? "Session file deleted. (Also terminate the session in Telegram → Settings → Devices if you want it revoked server-side.)" : "No session file found.");
      return 0;
    }
    case "backup": {
      const db = await openDatabase(cfg);
      try {
        const r = await backupConfig(db, cfg.paths.backupsDir);
        console.log(`Config snapshot: ${r.snapshotFile}${r.databaseFile ? `\nDatabase copy:   ${r.databaseFile}` : ""}${r.pruned.length ? `\nPruned ${r.pruned.length} old file(s).` : ""}`);
      } finally {
        await db.close();
      }
      return 0;
    }
    case "doctor": {
      let bad = 0;
      const line = (ok: boolean | "warn", name: string, detail: string): void => {
        console.log(`${ok === true ? "✔" : ok === "warn" ? "!" : "✖"} ${name}: ${detail}`);
        if (ok === false) bad++;
      };
      line(true, "configuration", "valid");
      line(cfg.dashboard.enabled && !cfg.dashboard.password ? "warn" : true, "dashboard", cfg.dashboard.enabled ? (cfg.dashboard.password ? `${cfg.dashboard.host}:${cfg.dashboard.port}` : "enabled but DASHBOARD_PASSWORD is missing") : "disabled");
      try {
        fs.mkdirSync(cfg.paths.dataDir, { recursive: true, mode: 0o700 });
        fs.accessSync(cfg.paths.dataDir, fs.constants.W_OK);
        line(true, "data dir", cfg.paths.dataDir);
      } catch {
        line(false, "data dir", `${cfg.paths.dataDir} is not writable`);
      }
      try {
        const db = await openDatabase(cfg);
        await db.ping();
        await db.close();
        line(true, "database", cfg.db.driver);
      } catch (e) {
        line(false, "database", e instanceof Error ? e.message : String(e));
      }
      const info = store.info();
      line(!info.exists ? false : info.looseMode ? "warn" : true, "session", !info.exists ? "missing — run `npm run login`" : `${info.encrypted ? "encrypted" : "plaintext (set SESSION_ENCRYPTION_KEY to encrypt)"}${info.looseMode ? "; file permissions too open" : ""}`);
      const f = probeFeatures(libInfo());
      line(f.summary.unavailable === 0 ? true : "warn", "library", `${f.library.name}@${f.library.version}: ${f.summary.supported} supported, ${f.summary.partial} partial, ${f.summary.unavailable} unavailable`);
      if (flags.includes("--online") && info.exists) {
        const session = store.load();
        const client = buildClient(cfg, session ?? "");
        try {
          await client.connect();
          const me = (await client.getMe()) as { id: { toString(): string }; username?: string };
          line(true, "telegram", `connected as ${me.username ? `@${me.username}` : `id ${me.id.toString()}`}`);
        } catch (e) {
          line(false, "telegram", e instanceof Error ? e.message : String(e));
        } finally {
          await client.disconnect().catch(() => undefined);
        }
      }
      return bad ? 1 : 0;
    }
    default:
      console.log(HELP);
      return cmd ? 1 : 0;
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof AppError ? `✖ ${err.message}${err.hint ? `\n  → ${err.hint}` : ""}` : `✖ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
