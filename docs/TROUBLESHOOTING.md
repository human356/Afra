# Troubleshooting

Start with `npm run doctor -- --online` and the dashboard's lamp rail; most problems show up there.

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `Invalid configuration: - X: required but not set` | missing variable | fill it in `.env` (see `.env.example`) |
| `No Telegram session found` | never logged in, or session was quarantined | `npm run login` |
| `The Telegram session is no longer valid` | session revoked/expired (logged out from another device, account issue) | the old file was moved to `session.bin.invalid-<time>`; run `npm run login` again |
| `Session file is encrypted but SESSION_ENCRYPTION_KEY is not set` / `Could not decrypt…` | key missing or different | restore the original key; otherwise delete the session and log in again |
| `Could not start the control bot` | wrong/revoked `BOT_TOKEN` | get a fresh token from @BotFather |
| Commands do nothing | sender is not master/granted; wrong prefix; account is not the one you type from | `/users` in the control bot; check `COMMAND_PREFIX`; `.me` |
| `.cmd` from my own account is ignored | `MASTER_ADMIN_ID` is not **your** numeric id | correct the id (the session account must be master or granted) |
| `Telegram rate limit: wait Ns` | FloodWait | nothing to do: the app waited/will wait. Reduce usage; raise `SEND_INTERVAL_MS`. Never retry in a loop |
| `PEER_FLOOD` message | Telegram restricted contacting new users | stop sending; check `@SpamBot`; wait |
| `The account lacks the rights…` / `…admin right…` | not an admin there, or lacking that right | use `.perms --chat=…`; ask a real admin to grant the right |
| `Could not resolve that chat or user` | account has never seen that entity | use a numeric id from `.chats`, or open the chat once; or `@username` |
| Dashboard unreachable | wrong host/port, bound to 127.0.0.1 on a remote server | use an SSH tunnel: `ssh -L 8787:127.0.0.1:8787 host`; check `DASHBOARD_PORT` |
| Dashboard `Bad host header` | opened via a name not in the allow-list | add it to `DASHBOARD_ALLOWED_HOSTS` |
| `Too many attempts` on login | 5 wrong passwords | wait for the lockout (10 min) or restart the app |
| Dashboard health `disk: warn/fail` | little free space in `DATA_DIR` | free space; prune `downloads/`, `exports/`, `backups/` |
| `Task queue is full` | work arriving faster than it is processed | wait; raise `QUEUE_MAX_SIZE`/`MAX_CONCURRENCY` carefully |
| Reminder arrived late | app was down; reminders are still delivered (marked "late") | run under systemd/Docker with restart |
| One-off scheduled job "missed" | down longer than `SCHEDULER_MAX_LATE_SEC` | expected for non-reminder tasks; recreate it |
| `No such built-in module: node:sqlite` / syntax errors at start | Node older than 22.16 | upgrade Node (the SQLite backend is Node's built-in `node:sqlite`; no native add-on is compiled), or use PostgreSQL |
| Download stops with `incomplete download` | connection dropped | run `.dl` again — it resumes from the `.part` file |
| `AI features are disabled` | opt-in not configured | `AI_ENABLED=true` + `ANTHROPIC_API_KEY` |
| `Translation is not configured` | provider not set | `TRANSLATE_PROVIDER` (+ `TRANSLATE_URL` for libretranslate) |

## Recovery procedures

- **Lost/compromised session:** Telegram → Settings → Devices → terminate; `npm run logout`; `npm run login`.
- **Corrupt database:** stop the app, restore a `db-*.sqlite` file from `DATA_DIR/backups` over `userbot.sqlite`
  (delete `*-wal`/`*-shm`), start. For PostgreSQL use your normal `pg_restore`.
- **Restore configuration only:** the `config-*.json` snapshot lists settings, grants, rules, tasks and plugin state.
- **Bad plugin:** `plugin disable <name>` (or delete its folder); auto-disable already protects against crash loops.
- **Wrong grants:** `/users`, `/revoke <id>`; review `/audit`.

## Logs

JSON lines on stdout (`LOG_LEVEL`). Secrets are redacted. The dashboard shows the last 1000 lines. Useful fields:
`module`, `op`, `attempt`, `floodWait`, `err`.
