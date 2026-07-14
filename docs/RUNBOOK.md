# Runbook

Procedures for the moments you do not want to be improvising. Commands assume
the Docker deployment; prefix with `docker compose exec agent` from the
`deploy/` directory (or run `node src/cli.js ...` directly on a host with
Node).

## Restore a database

### Scenario 1: fresh/empty database (disaster recovery)

1. Make sure the database container is up and the target database exists and
   is empty (a brand-new compose stack gives you that).
2. Restore the newest artifact:

   ```bash
   server-tools restore app-db
   ```

   Or a specific one:

   ```bash
   server-tools artifacts app-db          # list what exists
   server-tools restore app-db app-db-20260113-033000.sql.gz.enc
   ```

3. The command reports the table count on completion. Start/restart the app
   and verify its health endpoint.

Artifacts are fetched from the local `dataDir` first, falling back to the
configured S3 bucket, and are decrypted with the target's passphrase. If the
box is a total loss, you need: this repo, the config file, the
`BACKUP_PASSPHRASE`, and the S3 credentials - which is why the passphrase
must live in your password manager, not only on the server.

### Scenario 2: roll a live database back (bad deploy, data damage)

A non-empty database is refused by default. Deliberately:

1. Stop the application (leave the DB container up):

   ```bash
   docker compose -f /path/to/app/docker-compose.yml stop app
   ```

2. Take a safety backup of the current (damaged) state first:

   ```bash
   server-tools backup app-db
   ```

3. Drop and recreate the schema, then restore. Either recreate the whole
   database container with a fresh volume, or force-restore over it:

   ```bash
   server-tools restore app-db <artifact> --force
   ```

   `--force` skips the empty-database guard; it does not drop existing
   objects. If the schema is present, recreate the database first (inside
   the db container):

   ```bash
   docker exec -it <db-container> psql -U <user> -d template1 \
     -c "DROP DATABASE appdb" -c "CREATE DATABASE appdb"
   ```

4. Restore, start the app, verify health, and check application logs.

### Scenario 3: inspect a backup without touching anything

```bash
server-tools drill app-db                # latest artifact
server-tools drill app-db <artifact>     # a specific one
```

The drill restores into a throwaway database (`st_drill_<timestamp>`) on the
same container, reports table and row counts, then drops it. Run it monthly
and after changing anything about backups. The result shows on the dashboard.

## Backups stopped / backup-freshness is red

1. `server-tools status` - read the last error recorded for the target.
2. Common causes: database container renamed (fix config), disk full
   (`server-tools check disk-root`), S3 credentials rotated (update `.env`,
   `docker compose up -d` to reload), passphrase env var missing after an
   edit to `.env`.
3. Run one by hand and watch: `server-tools backup app-db`.
4. Confirm freshness goes green on the next check cycle.

## Disk is filling up

1. `server-tools check` - the disk check shows current usage.
2. Biggest usual suspects, in order: docker build cache and old images
   (`docker system df`, then `docker image prune -a` and
   `docker builder prune`), application media growth, local backup
   artifacts.
3. Local backup artifacts are pruned by retention after every successful
   run; tighten `retention` counts in config if they are the problem.
4. `server-tools housekeep --dry-run` shows what cleanup would remove.

## Understanding and fixing an incident

Every failing check turns into an incident with a plain-language explanation,
likely causes, and (where one is safe) a one-click fix. Three ways to reach it:

- **Dashboard:** the overview leads with an "Attention needed" section; opening
  a failing check shows the full card plus recent container logs.
- **Terminal, read-only:** `server-tools diagnose <check>` prints the same
  explanation, causes, live context, and the available actions.
- **Terminal, act:** `server-tools fix <check> [actionId]` runs the top
  suggested action (or a named one).

The actions are deliberately conservative - none delete application data:

| Action | What it does | Where it is offered |
| --- | --- | --- |
| `restart-container` | Restarts the named container (brief downtime) | container / postgres / http incidents |
| `reclaim-docker-space` | Removes unused Docker images + build cache | disk incidents |
| `run-backup` | Runs a configured backup target now | backup-freshness incidents, and the Backups page |
| `run-drill` | Restores the latest backup into a temporary database to prove it works, then removes it | the Backups page (database targets) |

The **Backups page** also carries "Back up now" and "Test restore" buttons for
every target, so a routine backup or a restore drill is one click instead of a
terminal command.

A restart only helps if the container itself is the problem; if the disk is
also full, clear space first (a restart will not fix a full disk). Certificate
and load/memory incidents are explained but have no auto-fix, because the real
remedy needs host access or simply time.

## App is down (container check red)

1. `docker ps -a` - is the container restarting or exited?
2. `docker logs --tail 100 <container>`.
3. If a recent deploy is suspect, the deploy history (dashboard, or
   `server-tools status`) shows what went out and when; redeploy the
   previous tag:

   ```bash
   server-tools deploy myapp <previous-tag>
   ```

4. The deploy helper's rollback only triggers during a deploy; a service
   that dies later is a restart/logs investigation, not a rollback.

## TLS certificate expiring

The `tls-cert` check warns 21 days out by default, which is longer than any
sane auto-renewal cycle - so a warn means renewal is broken, not merely
pending. Check the reverse proxy's renewal (Caddy: `journalctl -u caddy`;
certbot: `certbot renew --dry-run`).

## Dashboard locked out

```bash
docker compose exec agent node src/cli.js login-link you@example.com
```

Sessions and tokens live in the data volume; if it was wiped, all sessions
are simply invalid and a new login link fixes it. Only addresses in
`web.allowedEmails` can ever receive a link.

## Agent itself misbehaving

- Logs: `docker compose logs -f agent`.
- State is plain files: `docker compose exec agent sh`, then look under
  `/data/state/*.json` and `/data/history/*.jsonl` (jq-friendly).
- Restarting the agent is always safe: checks re-run, schedules re-arm,
  nothing in-flight is critical. `docker compose restart agent`.
