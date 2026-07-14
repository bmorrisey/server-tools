# Configuration reference

One JSON file drives everything. The agent reads `./config.json` by default;
override with the `SERVER_TOOLS_CONFIG` environment variable. Start from
[`deploy/config.example.json`](../deploy/config.example.json) and check your
work with:

```bash
node src/cli.js validate
```

## Secrets

Any string value of the exact form `"${VAR_NAME}"` is replaced at load time
with that environment variable. Keep every secret (passphrases, S3 keys, SMTP
passwords) in the environment (compose `.env` file) and reference it this
way. A missing variable resolves to an empty string, which the affected
feature will report clearly rather than half-work with.

## Top level

| Field | Default | Meaning |
| --- | --- | --- |
| `dataDir` | `./data` | Where state, history, and local backup artifacts live. In Docker this should be a named volume (`/data`). |
| `docker.socketPath` | `/var/run/docker.sock` | Docker Engine socket, used for container checks, in-container backups, and exec-based checks. |
| `checkDefaults` | see below | Fallbacks applied to every check. |
| `checks` | `[]` | Health checks (below). |
| `backups` | `[]` | Backup targets (below). |
| `deploys` | `[]` | Deployable applications (below). |
| `housekeeping` | `{}` | Cleanup settings (below). |
| `alerts` | `{}` | Alert channels (below). |
| `web` | enabled | Dashboard settings (below). |

## `checkDefaults`

```json
{ "interval": "60s", "timeout": "10s", "failuresBeforeAlert": 2 }
```

`failuresBeforeAlert` is the consecutive-failure threshold: a check must fail
that many runs in a row before one alert fires; a recovery notice follows
when it passes again. Warn states never alert; they show on the dashboard.

Durations accept `ms`, `s`, `m`, `h`, `d`, `w` (for example `"90s"`,
`"5m"`, `"1d"`).

## Checks

Common fields: `name` (unique), `type`, `interval`, `timeout`,
`failuresBeforeAlert`.

### `http`

```json
{ "name": "app-http", "type": "http", "url": "https://app.example.com/api/health",
  "expectStatus": 200, "expectJson": { "status": "ok", "db.ok": true }, "maxLatency": "2s" }
```

Without `expectStatus`, any 2xx/3xx passes. `expectJson` asserts dotted paths
in a JSON response body. `maxLatency` turns slow-but-up into a warn.

### `tcp`

```json
{ "name": "smtp-port", "type": "tcp", "host": "127.0.0.1", "port": 587 }
```

### `tls-cert`

```json
{ "name": "tls", "type": "tls-cert", "host": "app.example.com", "port": 443,
  "warnDays": 21, "failDays": 7, "interval": "6h" }
```

Checks days remaining on the certificate the host actually serves.

### `disk`

```json
{ "name": "disk-root", "type": "disk", "path": "/host", "warnPct": 80, "failPct": 92 }
```

`path` is checked with statfs; in Docker, bind-mount the host filesystem
read-only (the example compose mounts `/` at `/host`).

### `memory`, `load`

```json
{ "name": "memory", "type": "memory", "warnPct": 85, "failPct": 95 }
{ "name": "load", "type": "load", "warnPerCore": 1.5, "failPerCore": 3 }
```

Host-wide values from `/proc` (not namespaced by containers).

### `container`

```json
{ "name": "app-container", "type": "container", "container": "myapp-app-1" }
```

Matches by container name or compose service label. Running plus a healthy
healthcheck (when the container defines one) is ok; `starting` is a warn.

### `postgres`

```json
{ "name": "app-db", "type": "postgres", "container": "myapp-db-1",
  "user": "appuser", "database": "appdb" }
```

Runs `SELECT 1` via `psql` inside the database container.

### `backup-freshness`

```json
{ "name": "db-backup-fresh", "type": "backup-freshness", "target": "app-db",
  "warnAfter": "26h", "failAfter": "50h" }
```

Watches the recorded last-success time of a backup target. Pair one of these
with every scheduled backup; it is the alarm that tells you backups quietly
stopped.

### `command`

```json
{ "name": "queue-depth", "type": "command", "container": "myapp-app-1",
  "command": "node scripts/queue-depth.js", "warnAbove": 100, "failAbove": 1000 }
```

Runs any command inside a container. Exit code 0 is ok; with
`warnAbove`/`failAbove` the command's numeric stdout is thresholded (queue
depths, pending jobs, orphan counts - anything you can print as a number).

## Backups

Common fields: `name`, `type` (`postgres` | `files`), `schedule`,
`passphrase`, `encrypt`, `retention`, `s3`.

- `schedule`: `"03:30"` (daily), `"sun 04:30"` (weekly), or an interval like
  `"6h"`. Omit for manual-only targets.
- `passphrase`: encrypts artifacts with AES-256-GCM (key derived with
  scrypt). Required unless `"encrypt": false`. **Store a copy of this
  passphrase outside the box; artifacts are unrecoverable without it.**
- `retention`: `{ "daily": 7, "weekly": 4, "monthly": 6 }` grandfather-
  father-son counts. A backup taken on Sunday fills a weekly slot; one taken
  on the 1st fills a monthly slot. Applied locally and offsite after every
  successful run.
- `s3`: offsite upload. `{ bucket, region, accessKeyId, secretAccessKey,
  endpoint?, prefix? }`. Set `endpoint` for S3-compatible providers
  (path-style addressing is used automatically); leave it unset for AWS.

### `postgres` target

```json
{ "name": "app-db", "type": "postgres", "container": "myapp-db-1",
  "user": "appuser", "database": "appdb", "schedule": "03:30",
  "passphrase": "${BACKUP_PASSPHRASE}",
  "retention": { "daily": 7, "weekly": 4, "monthly": 6 },
  "s3": { "bucket": "my-backups", "region": "auto",
          "endpoint": "https://<accountid>.r2.cloudflarestorage.com",
          "prefix": "server-tools",
          "accessKeyId": "${S3_ACCESS_KEY_ID}",
          "secretAccessKey": "${S3_SECRET_ACCESS_KEY}" } }
```

`pg_dump` runs inside the container via the Docker API and streams through
gzip and encryption to `dataDir/backups/<name>/`. Artifacts smaller than 512
bytes are treated as failures (an empty dump never counts as success).

### `files` target

```json
{ "name": "app-media", "type": "files", "path": "/apps/myapp/storage",
  "schedule": "sun 04:30", "archive": false, "exclude": ["tmp"],
  "passphrase": "${BACKUP_PASSPHRASE}" }
```

Always writes a manifest (relative path, size, sha256 for every file) used
for integrity verification. With `"archive": true` it also builds an
encrypted `.tar.gz` of the tree and uploads it when `s3` is configured. For
large media trees prefer `archive: false` plus provider-side replication, or
schedule archives weekly.

## Deploys

```json
{ "name": "myapp", "dir": "/apps/myapp",
  "healthUrl": "https://app.example.com/api/health",
  "healthAttempts": 20, "healthDelay": "6s" }
```

`server-tools deploy myapp v1.2.3` then: verifies the working tree is clean,
fetches tags, checks out `v1.2.3`, runs `docker compose up -d --build`, polls
`healthUrl` (`healthAttempts` x `healthDelay`), and on build or health
failure checks the previous commit back out, rebuilds, and reports the
rollback. The app directory must be visible to the agent (bind-mount it into
the container at the same path you configure).

## Housekeeping

```json
{ "schedule": "04:45", "historyDays": 90, "tmpAge": "2d",
  "clean": [ { "path": "/apps/myapp/storage/tmp", "maxAge": "7d" } ] }
```

`clean` rules delete files older than `maxAge` inside the listed directories
(recursive, files only, symlinks never followed, then empty dirs). Point
these at cache/temp directories only.

## Alerts

```json
{
  "webhook": { "url": "https://ntfy.sh/your-topic", "format": "generic", "headers": {} },
  "smtp": { "host": "smtp.example.com", "port": 587, "user": "alerts@example.com",
            "pass": "${SMTP_PASSWORD}", "from": "alerts@example.com",
            "to": ["you@example.com"] }
}
```

Both channels are optional and independent; with none configured, alerts
still land in the events history and dashboard. `format: "discord"` wraps the
webhook payload as `{ "content": ... }` for Discord/Slack-compatible
receivers. Port 465 uses implicit TLS; 587/25 upgrade with STARTTLS when the
server offers it.

## Web (dashboard)

```json
{ "enabled": true, "port": 9090, "bind": "0.0.0.0",
  "baseUrl": "https://ops.example.com",
  "allowedEmails": ["you@example.com"], "sessionDays": 30 }
```

- `bind`: inside Docker use `0.0.0.0` and publish the port to localhost via
  compose (`127.0.0.1:9090:9090`); outside Docker bind `127.0.0.1` directly.
- `baseUrl`: the public URL your reverse proxy serves; used in login links
  and secure-cookie decisions.
- `allowedEmails`: the only addresses that can receive login links. There are
  no accounts or passwords; this list is the whole ACL.
- `sessionDays`: how long a logged-in browser stays signed in.
