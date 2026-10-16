# Security

## What is protected, and how

| Asset | Protection |
| --- | --- |
| `api_hash`, bot token, passwords, AI/translation keys | Loaded from the environment only; a redactor masks them (and token-shaped strings, DB URL passwords) in every log line **and** in the dashboard log buffer; the dashboard config view is a whitelist. |
| Telegram session | `DATA_DIR/session.bin`, mode 0600, atomic writes, optional AES-256-GCM (scrypt key) via `SESSION_ENCRYPTION_KEY`; never exposed by any endpoint or command. A dead session is quarantined, not deleted. |
| Login codes / 2FA password | Typed in the local terminal only (hidden), passed to Telegram, never logged or stored. No login via dashboard or bot. |
| Who may command the account | `MASTER_ADMIN_ID` + explicit grants with scopes (least privilege; default `self`). Strangers get no response on the userbot. Master cannot be changed from chat. Non-master users are rate-limited. |
| Destructive actions | Always a dry-run preview first; execution needs a single-use, expiring token bound to the requesting user (or `--yes` only when `DRY_RUN_DEFAULT=false`). Every preview and execution is in the audit log. |
| Message content | Not stored by default. Archive needs `STORE_MESSAGE_CONTENT=true` **and** a per-chat opt-in; turning a chat off deletes its stored text. Backups exclude message text and audit logs. |
| Dashboard | Password required (scrypt, constant-time compare), signed HttpOnly SameSite=Strict cookie, CSRF token + Origin check on writes, login lockout (5 failures → 10 min), strict CSP (no inline script), Host-header allow-list (DNS-rebinding protection), binds to `127.0.0.1` by default, UI inserts all data as text (tested against HTML injection). |
| Telegram rate limits | FloodWait is waited out exactly (never shortened), long waits are surfaced instead of blocked on, PEER_FLOOD stops activity, sends are paced, scheduled repeats ≥ 60 s, automatic replies capped per chat. The paid "flood skip" option and any multi-account/proxy rotation are **not** used. |
| File downloads | File names are sanitised (no traversal), size limit, content-addressed de-duplication, owner-only directories. |

## Authorisation model

`master` → everything. A granted user holds a set of scopes; each command declares the one it needs.
`chatadmin` commands additionally require that **Telegram itself** has granted this account the corresponding admin
right in that chat (checked live) — a scope never grants powers Telegram has not.

## Things you should know (limits)

- **Plugins run in-process** with the same privileges as the app. Error isolation and auto-disable protect stability, not
  security. External plugins start disabled; enable only code you trust.
- Without `SESSION_ENCRYPTION_KEY` the session is a plaintext file protected by file permissions only. Anyone who can
  read it can act as your account. Prefer setting the key, and protect `DATA_DIR` (and `.env`).
- **AI / translation are opt-in and send text off-machine** — only text you pass to `.sum`, `.classify`, `.tr`. With
  `AI_ENABLED=true` that text goes to the Anthropic API; with `TRANSLATE_PROVIDER=libretranslate`, to the server you
  configured. Nothing is sent automatically.
- A granted user with `messaging`/`media`/`search` scopes can use *your account's* access. Grant sparingly.
- The dashboard is meant for localhost. If you expose it, put it behind TLS and set `DASHBOARD_ALLOWED_HOSTS`.
- Automating a user account carries Telegram-side risk (limits, restrictions). Stay within the Terms; this tool will not
  help you spam, scrape-and-message, or evade limits.

## Reporting / hardening checklist

- [ ] `SESSION_ENCRYPTION_KEY` set · `.env` and `data/` not world-readable · `.env` never committed
- [ ] `DASHBOARD_PASSWORD` long and unique · dashboard not exposed publicly
- [ ] Grants reviewed with `/users`; `/audit` checked occasionally
- [ ] `npm audit` run after upgrades; versions are pinned, upgrade deliberately
- [ ] Terminate the Telegram session (Settings → Devices) if the machine is lost
