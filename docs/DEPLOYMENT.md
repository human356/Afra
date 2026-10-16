# Deployment

## Docker (recommended)

```bash
cp .env.example .env            # fill it in (BOT_TOKEN, MASTER_ADMIN_ID, API id/hash, passwords, SESSION_ENCRYPTION_KEY)
docker compose build   # uses deploy/Dockerfile
docker compose run --rm userbot node dist/cli.js login    # one-time interactive sign-in (needs a TTY)
docker compose up -d
docker compose logs -f
```

- The image is multi-stage, runs as a non-root user, read-only root filesystem, all capabilities dropped.
- `./data` holds the session, database, downloads, exports and backups — protect and back it up.
- The dashboard is published on `127.0.0.1:8787` only; inside the container it listens on `0.0.0.0` with
  `DASHBOARD_ALLOWED_HOSTS` enforcing the Host header. Reach it remotely through an SSH tunnel or a TLS reverse proxy
  (add your public host name to `DASHBOARD_ALLOWED_HOSTS`).
- `HEALTHCHECK` uses the content-free `/healthz` endpoint.
- Stop gracefully with `docker compose stop` (30 s grace): the queue drains, plugins deactivate, the session is saved.

## systemd

See `deploy/telegram-userbot.service` (hardened unit: no new privileges, strict filesystem, only `data/` writable).

```bash
sudo useradd --system --home /opt/telegram-userbot userbot
sudo cp -r . /opt/telegram-userbot && cd /opt/telegram-userbot
sudo -u userbot npm ci && sudo -u userbot npm run build
sudo -u userbot npm run login
sudo cp deploy/telegram-userbot.service /etc/systemd/system/ && sudo systemctl enable --now telegram-userbot
journalctl -u telegram-userbot -f
```

## PostgreSQL (optional)

```
DB_DRIVER=postgres
DATABASE_URL=postgres://userbot:***@db:5432/userbot
```

The schema is created automatically. `npm run backup` then writes the JSON configuration snapshot (use `pg_dump` for a
full database backup). Never put the URL in a world-readable file; it is redacted from logs.

## Backups

`/backup` (control bot) or `npm run backup` writes `config-*.json` (+ a native SQLite copy) to `DATA_DIR/backups`,
keeping the 10 most recent of each. The snapshot holds settings, grants, rules (including reply texts), reminders/tasks (including their texts) and plugin state. Message archives, audit logs and session files are not in it.
Schedule `npm run backup` with cron/systemd timers; copy the folder off-machine.

## Upgrading

1. `npm run backup` · 2. pull new code · 3. `npm ci && npm run verify && npm run build` · 4. restart.
Migrations run automatically at start and are transactional. Dependencies are pinned exactly; upgrade `teleproto`
deliberately and re-run `npm run matrix` to see what changed in the feature matrix.

## Sizing

Tiny: 1 vCPU / 256 MB is enough for personal use. Downloads and exports dominate disk usage; set
`MEDIA_MAX_DOWNLOAD_MB` and watch the `disk` health lamp.
