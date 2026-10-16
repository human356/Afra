# Setup

## 1. Prerequisites

- Node.js **22.16+** (24 LTS works too) and npm. SQLite is Node's built-in module, so nothing native has to be compiled.
- A Telegram account to run the userbot on (usually your own).
- API credentials: <https://my.telegram.org> → *API development tools* → `api_id` and `api_hash`.
- Your numeric Telegram user id (ask `@userinfobot`) — this becomes `MASTER_ADMIN_ID`.
- Recommended: a control bot — create one with `@BotFather` and keep the token.

## 2. Configure

```bash
npm ci
cp .env.example .env
```

Fill at least `TG_API_ID`, `TG_API_HASH`, `MASTER_ADMIN_ID`, `DASHBOARD_PASSWORD` (12+ characters) and, for access
management from chat, `BOT_TOKEN`. Set `SESSION_ENCRYPTION_KEY` (16+ characters) to encrypt the session at rest.
Every option is documented in `.env.example`. The `.env` file is read from the working directory; keep it out of git
(already in `.gitignore`).

## 3. Sign in

```bash
npm run login
```

Enter the phone number, the code Telegram sends, and your 2FA password if you have one. They are typed into the
terminal (hidden), passed to Telegram and never logged or stored — only the resulting session is saved to
`DATA_DIR/session.bin` (mode 0600, AES-256-GCM encrypted when `SESSION_ENCRYPTION_KEY` is set).
There is intentionally **no** login through the dashboard or the bot.

## 4. Check, build, run

```bash
npm run doctor -- --online     # config, data dir, database, session, library, live connection
npm run build && npm start     # production
npm run dev                    # development (restarts on change)
```

## 5. First-run checklist (live verification)

Because this project could not be exercised against real Telegram servers when it was written, run through these
once. Each step proves a layer:

| # | Do this | Expect |
| --- | --- | --- |
| 1 | `npm run doctor -- --online` | all ✔, "connected as @you" |
| 2 | `npm start`, open the dashboard, sign in | lamp rail green (telegram, database, scheduler, session) |
| 3 | Send `.ping` from your account in Saved Messages | the message turns into `🏓 pong` |
| 4 | In the control bot chat: `/me`, then `/grant <a friend's id> self` | confirmation listing the scope |
| 5 | `.remind 1m test` | `⏰ test` arrives after a minute |
| 6 | Reply to a photo with `.mediainfo`, then `.dl` | metadata; file appears under `data/downloads/photo/…` |
| 7 | `.del 1` then `.confirm <code>` | dry-run preview first; deletion only after confirm; `/audit` shows both |
| 8 | `.features` | summary of supported/partial features for the installed library |

If a step fails, see [TROUBLESHOOTING](TROUBLESHOOTING.md). Please report anything that behaves differently from this
table — those are exactly the places where real-server behaviour could differ from the test doubles.

## 6. Granting "self mode"

In a private chat with the control bot (as the master admin):

```
/grant <user id> [scopes] [--note=text]     scopes: self, automation, search, media, messaging, chatadmin
/users   /suspend <id>   /resume <id>   /revoke <id>   /audit
```

Without `BOT_TOKEN` the same commands work from the master's own account with the prefix (`.grant 123 self`).
