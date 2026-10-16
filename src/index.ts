import dotenv from "dotenv";
import { SessionStore } from "./auth/sessionStore";
import { startWebSetup } from "./auth/webLogin";
import { loadConfig } from "./config";
import { AppError } from "./core/errors";
import { createLogger } from "./core/logger";
import { startApp } from "./runtime/app";

async function main(): Promise<void> {
  dotenv.config({ quiet: true });
  const cfg = loadConfig();

  // Hosts without a terminal (e.g. Railway): when WEB_LOGIN=true and there is no session yet, serve a one-time sign-in page first.
  const store = new SessionStore(cfg.paths.sessionFile, cfg.security.sessionEncryptionKey);
  if (cfg.webLogin && !store.exists()) {
    const { logger } = createLogger({ level: cfg.logging.level, secrets: cfg.secrets });
    const setup = await startWebSetup({ cfg, store, logger });
    try {
      await setup.done;
    } catch (err) {
      await setup.close();
      if (err instanceof AppError && err.code === "SETUP_TIMEOUT") {
        console.error(`\n! ${err.message}. ${err.hint}\n`);
        process.exit(0); // a clean exit, so a restart policy does not loop on an unattended setup page
      }
      throw err;
    }
    await new Promise((r) => setTimeout(r, 4000)); // let the page poll the final "done" state
    await setup.close();
  }

  const app = await startApp(cfg);
  app.shutdown.install();
}

main().catch((err: unknown) => {
  if (err instanceof AppError) {
    console.error(`\n✖ ${err.message}${err.hint ? `\n  → ${err.hint}` : ""}\n`);
  } else {
    console.error("\n✖ Fatal startup error:", err instanceof Error ? err.message : String(err), "\n");
  }
  process.exit(1);
});
