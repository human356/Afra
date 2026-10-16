# Architecture

```
src/
├── index.ts, cli.ts              entry points (run / login, doctor, backup, matrix)
├── config/                       zod-validated environment → typed AppConfig (+ secret list for redaction)
├── core/                         logger+redaction, errors, retry/FloodWait, bounded queue + pacer, lifecycle,
│                                 metrics, feature registry (capability probe), time/arg parsing, Services type
├── auth/                         SessionStore (encrypted), clients (connect/recover), login CLI, AccessControl
├── storage/                      Database interface · SQLite (default) · PostgreSQL · migrations · repositories · backup
├── messaging/                    Messenger: every outgoing call is paced, retried, FloodWait-aware, plain-text
├── chats/ media/ stickers/ search/   domain services (no command parsing inside)
├── automation/                   rules, scheduler (+TaskService), transforms, translate, AI, task kinds
├── admin/                        AdminService: real-rights checks, kick/ban/purge, admin log
├── plugins/                      manager (isolation, enable/disable, config), types, built-in `time`
├── monitoring/                   health checks + connection watchdog
├── commands/                     registry, dispatcher (auth, scopes, rate limit, dry-run/confirm), command modules
├── runtime/                      transports (userbot + control bot), responder, app bootstrap
└── dashboard/                    Express app, sessions/CSRF/login throttle, static UI (public/)
```

## Flow of a command

1. **Transport** receives a Telegram `NewMessage` (userbot account) or a private message (control bot).
2. **Dispatcher** parses it, resolves the sender's **principal** (master / granted user / nobody), checks the command's
   scope, applies a per-user rate limit, and runs the handler through the **bounded queue**.
3. Handlers call **services**, which call Telegram through the **Messenger** (spacing → retry/backoff → FloodWait wait).
4. Destructive handlers call `requireConfirmation`: dry-run preview + audit entry, then a single-use token
   (`.confirm <code>`) bound to the same user; execution is audited again.
5. The **Responder** shows the result: edits the owner's command message in place, or replies to others.

Messages that are not commands flow through *passive processing*: opt-in archive → rules → plugins, each as bounded
queue jobs (dropped, not piled up, when the queue is full).

## Design decisions

- **Library:** `teleproto` (actively maintained successor of GramJS, which is a Node port of Telethon). The prompt said
  "Node.js and Telethon"; Telethon itself is Python. The library is imported in one place (`core/library.ts`).
  Pinned exactly in `package.json`/lockfile.
- **Capability probe instead of promises:** `core/features.ts` lists the library symbols each feature needs and checks
  them against the *installed* version at startup, in `npm run matrix`, and in tests. Features with a documented limit
  are capped at "partial".
- **Two storage backends behind one interface;** SQL is written once with `?` placeholders (converted for PostgreSQL),
  IDs/timestamps are `BIGINT`. SQLite access is serialised (single connection, transactions never interleave).
- **Privacy by construction:** message text is stored only if `STORE_MESSAGE_CONTENT=true` *and* a chat is opted in;
  backups contain configuration only; the dashboard config view is a whitelist.
- **Back-pressure everywhere:** bounded queue, concurrency limit, pacer, per-chat caps on automatic actions.
- **Plugins** run in-process with isolated error handling (see [PLUGINS](PLUGINS.md)); they are not a sandbox.

## Data model (tables)

`settings`, `authorized_users`, `rules`, `tasks`, `task_runs`, `audit_log`, `media_files` (metadata + SHA-256),
`plugin_state`, `message_archive` (opt-in), `schema_migrations`.
