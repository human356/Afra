# Telegram userbot

A modular, security-first Telegram **userbot** for Node.js (TypeScript). It runs on your own Telegram account
(MTProto, via [`teleproto`](https://www.npmjs.com/package/teleproto) — the maintained successor of GramJS, the
Node.js port of Telethon) and is controlled by commands, with an optional private **control bot** for access
management and a local, password-protected **dashboard**.

> **Status:** 169 automated tests, strict TypeScript and lint pass. It has **not** been run against live Telegram
> servers by its author (no credentials were available). Follow the first-run checklist in
> [docs/SETUP.md](docs/SETUP.md) — it takes five minutes and exercises every layer.

## How access works (master admin and "self mode")

- **Master admin** — the numeric Telegram user id in `MASTER_ADMIN_ID` (`.env`). Always has full access and cannot be
  changed from chat.
- **Self mode is not for everyone.** Nobody else can command the userbot until the master admin enables it for that
  specific user, in a **private chat with the control bot**:

  ```
  /grant 123456789 self,search --note=alice
  /users
  /revoke 123456789
  ```

  Grants carry explicit scopes (`self`, `automation`, `search`, `media`, `messaging`, `chatadmin`); the default is
  `self` only (personal helpers: reminders, text tools, translation). Strangers are ignored silently.
- Personal features are per user: reminders you create are yours, delivered to you, and only you (or the master) can
  cancel them; rules belong to their creator.

## Quick start

```bash
npm ci
cp .env.example .env        # fill in TG_API_ID, TG_API_HASH, MASTER_ADMIN_ID, BOT_TOKEN, DASHBOARD_PASSWORD
npm run login               # sign in (phone, code, 2FA are typed in the terminal only)
npm run doctor -- --online  # verify config, database, session and the Telegram connection
npm run build && npm start  # or: npm run dev
```

Then send `.ping` and `.help` from your account in any chat (the command message is replaced by the answer), or
`/help` in the control bot's private chat. Dashboard: <http://127.0.0.1:8787>.

**No terminal (Railway and similar)?** Use the one-time browser sign-in — step-by-step guide in Persian:
[docs/RAILWAY.md](docs/RAILWAY.md).

## What it can do

Messaging (text, media, albums, voice, replies, forward, edit, delete, drafts, scheduled, saved messages) ·
chats (list, mute, archive, folders) · media (classify, inspect, resumable de-duplicated downloads) ·
stickers & custom emoji · search, opt-in local archive, JSONL export · keyword/regex rules with allow/block lists ·
reminders and scheduled tasks · text transforms, translation, optional AI summarise/classify · group/channel
moderation **only where Telegram grants the account the right**, with audit log · plugins · dashboard · health
checks · backups.

See the generated, library-verified [feature matrix](docs/FEATURE_MATRIX.md) (what is supported / partial /
unavailable) and the [command reference](docs/COMMANDS.md).

## Safety defaults

Dry-run + confirmation for destructive actions · rules apply nowhere until you list chats · never replies to bots or
itself · FloodWait is honoured, never evaded · message text is **not stored** unless you opt in twice · secrets are
redacted from logs and never shown in the dashboard · dashboard binds to `127.0.0.1` · external plugins start
disabled. Details: [docs/SECURITY.md](docs/SECURITY.md).

## Documentation

| | |
| --- | --- |
| [SETUP](docs/SETUP.md) | install, credentials, first run, first-run checklist |
| [ARCHITECTURE](docs/ARCHITECTURE.md) | modules, data flow, directory tree, design decisions |
| [SECURITY](docs/SECURITY.md) | threat model, what is protected, what is not |
| [PLUGINS](docs/PLUGINS.md) | writing and managing plugins |
| [DEPLOYMENT](docs/DEPLOYMENT.md) | Docker, systemd, backups, upgrades |
| [RAILWAY](docs/RAILWAY.md) | راهنمای فارسی استقرار روی Railway بدون ترمینال |
| [TROUBLESHOOTING](docs/TROUBLESHOOTING.md) | symptoms → causes → fixes |
| [COMMANDS](docs/COMMANDS.md) · [FEATURE_MATRIX](docs/FEATURE_MATRIX.md) | generated references |

## Development

```bash
npm run verify          # typecheck + lint + tests
npm run matrix          # regenerate docs/FEATURE_MATRIX.md from the installed library
npm run docs:commands   # regenerate docs/COMMANDS.md
```

Use this only with your own account and within [Telegram's Terms of Service](https://telegram.org/tos) and
[API Terms](https://core.telegram.org/api/terms). It deliberately offers no bulk messaging, no rate-limit evasion and
no privacy bypasses.
