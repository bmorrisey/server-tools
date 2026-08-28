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
| `appMetrics` | `[]` | Application metric sources (below). |
| `dashboards` | `[]` | External dashboards to link from the Overview (below). |
| `connect` | `{}` | Bearer tokens for the read-only data endpoints (below). |
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

Add an optional `"container": "<name>"` to an `http` check to name the
container that serves it. It is not used for the check itself, but it lets the
incident view offer a one-click "restart that container" fix and show its
recent logs when the endpoint is unhealthy.

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

Common fields: `name`, `type` (`postgres` | `files` | `external`), `schedule`,
`passphrase`, `encrypt`, `retention`, `s3`.

- `schedule`: `"03:30"` (daily), `"sun 04:30"` (weekly), or an interval like
  `"6h"`. Omit for manual-only targets.
- `passphrase`: encrypts artifacts with AES-256-GCM (key derived with
  scrypt). Required unless `"encrypt": false`. **Store a copy of this
  passphrase outside the box; artifacts are unrecoverable without it.**
- `retention`: `{ "daily": 7, "weekly": 4, "monthly": 6 }` grandfather-
  father-son counts. A backup taken on Sunday fills a weekly slot; one taken
  on the 1st fills a monthly slot. Applied locally and offsite after every
  successful run, per run rather than per file, so an archive and its
  manifest are always kept or dropped together. At least one of the three
  must be non-zero: all zeroes would delete the backup that had just been
  taken, and the dashboard offers pruning as a safe action on the promise
  that it never does that.
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

Media, wherever it lives. `source` says which of three places that is, and
it is always stated rather than inferred:

```json
{ "name": "app-media", "type": "files", "app": "myapp",
  "source": { "volume": "myapp_media" },
  "schedule": "05:30",
  "passphrase": "${BACKUP_PASSPHRASE}",
  "retention": { "daily": 7, "weekly": 4, "monthly": 6 } }
```

| `source` | Meaning |
| --- | --- |
| `{ "volume": "myapp_media" }` | A Docker volume. Read through a container that mounts it, so nothing needs bind-mounting into the agent. Add `"path"` to copy a subdirectory: it resolves against wherever the volume is mounted. |
| `{ "container": "myapp-app-1", "path": "/app/storage" }` | A path inside a container, volume mounts included. |
| `{ "path": "/apps/myapp/storage" }` | A directory the agent can see itself (bind-mount it in). Equivalent to the older top-level `"path"`, which still works. |

Volume and container sources are read with the Docker Engine's own copy
endpoint, which works on **stopped** containers - a stack being down is
exactly when someone reaches for a backup. A source that cannot be resolved
(no such volume, nothing mounting it, no such container) fails the run. It
never falls back to "a directory, probably", because the backup that
produces looks complete and is not.

`exclude` applies to a `path` source only, and its entries are literal paths
relative to the source root, not patterns. The archive and the manifest have
to drop exactly the same files, or every restore drill fails from then on.
The Engine hands back a volume or container subtree as one stream, so an
exclusion there could reach only the manifest; config validation refuses
that combination, and narrowing `source.path` is how to do it instead.

A run that finds no files fails rather than recording an empty backup, since
an unmounted bind mount and an empty directory look identical afterwards and
the drill would certify either. Set `"allowEmpty": true` if a target really
can be empty.

Every run writes a manifest: the relative path, size, and sha256 of every
file. `archive` adds a `.tar.gz` of the same bytes, encrypted like a database
dump and uploaded when `s3` is configured. It defaults to **true** for
targets that declare a `source`, because a manifest alone verifies a tree
that still exists and restores nothing. Targets using the older top-level
`path` keep the manifest-only default so existing configs do not suddenly
start writing tarballs; set `"archive": true` on those when you want a real
copy.

`"archive": false` is refused for a volume or container source. A manifest
taken through the Docker socket describes no tree this box can re-read, so
without an archive there would be nothing to verify it against and the
restore drill could never pass.

`server-tools drill app-media` proves the artifact: it reads the archive back
byte for byte and checks every file against the manifest that run wrote. For
a manifest-only target it re-checks the live tree instead.

### `external` target

```json
{ "name": "app-media", "type": "external",
  "note": "Object storage bucket app-media, replicated by the provider" }
```

Backs up nothing, is never "fresh", and takes no `schedule`, `retention`, or
`s3`. Its whole job is to be honest: media in an S3-compatible bucket is not
backable by this toolkit in any useful sense, and does not need to be for a
same-bucket restore - but it does mean the artifacts here are not
self-contained, and that is exactly what an operator needs told before
trusting them. Declaring one makes the dashboard say *media for this app is
outside the toolkit* instead of saying nothing.

A `backup-freshness` check cannot point at an external target; there is no
freshness to have, and config validation says so.

### Coverage

A `files` target counts as coverage only when it actually keeps a copy: a
manifest-only target indexes media it does not back up, and gets a note of
its own saying so. Give targets an optional `"app": "myapp"` and coverage is
judged per application; without it the whole deployment is treated as one,
which is the honest reading of a config that does not group itself. An
application whose backup targets are all `postgres` is either fine or half
covered, and only you know which. The dashboard, `server-tools validate`, and
`server-tools status` all say so once rather than showing green: a database
restored without its media is not a restore - the app comes up, the pages
render, and every image 404s. Adding a `files` target or an `external` target
answers the question either way.

### Artifacts on disk

Every artifact is written to `<name>.part` and renamed on success, so a
process that dies mid-write leaves nothing that looks like a backup. For
`files` targets the manifest is written last, which makes its presence the
completeness marker; a run that failed leaves a
`<name>-<stamp>.failed.json` in the target directory saying what went wrong.
Retention applies per run, so an archive and its manifest are kept or dropped
together.

## Deploys

Common fields: `name`, `dir` (the compose project directory), `healthUrl`,
`healthAttempts`, `healthDelay`, `project`, `source`, `services`.

| Field | Default | Meaning |
| --- | --- | --- |
| `source` | `"git"` | `"git"` builds on the box from a checkout; `"registry"` pulls an already-built image by tag. |
| `project` | derived from `dir` | The `docker compose -p` project name. Required for `registry`; strongly recommended everywhere else (see below). |
| `services` | none | Compose services that must end up running the new release. Required for `registry`. A one-shot service that exits 0 (a migration job) will fail this check; leave it off the list. |
| `image` | none | Registry repository, with no tag or digest. Required for `registry`, unless `images` is used. |
| `imageEnvVar` | `"APP_IMAGE"` | The variable written into the target's `.env` and referenced from the compose file. |
| `images` | none | Several repositories that move together on one tag, instead of `image`/`imageEnvVar`/`services`. Each entry takes `image`, `services`, and its own `envVar`. |
| `healthAttempts` | `20` | How many times to poll `healthUrl`. |
| `healthDelay` | `"6s"` | Wait between polls. |
| `composeEnv` | `[]` | Extra environment variable names to pass through to `docker compose` (see below). |

**Compose runs with a deliberately minimal environment** in both modes: enough
to reach Docker (`PATH`, `HOME`, `DOCKER_*`, `SSH_AUTH_SOCK`,
`XDG_RUNTIME_DIR`) plus the proxy and BuildKit settings a build needs
(`HTTP(S)_PROXY`, `NO_PROXY`, `DOCKER_BUILDKIT`, `BUILDKIT_PROGRESS`). It does
not inherit the agent's whole environment, because that is where the
toolkit's own secrets live and compose prefers the process environment over
`.env` - a name collision would hand one of them to your containers, and in
registry mode it would outrank the image reference just written. Anything
else a build genuinely needs from the agent's environment goes in
`composeEnv`; anything the application needs belongs in its own `.env`.

When a target lists `services`, both modes check them twice: once as soon as
compose returns, and again after the health poll. The second look is the one
that matters, because `up` returns the moment containers start and cannot
see a worker that boots and dies a few seconds later - so a deploy can be
rolled back *after* a passing health check, and the recorded detail says
which check failed. If Docker cannot answer the question at all, that is
reported as a caveat rather than treated as a failure: a read-only check
should never be able to recreate a stack.

On a box that runs a single stack, `docker compose` in the project directory
resolves to the project you meant. On a box with several, the project name is
derived from the directory and only errors if ports happen to collide, so it
is worth stating: set `project` to the name `docker compose ls` already shows
for that stack.

### `registry` source (recommended on a shared box)

```json
{ "name": "myapp", "dir": "/apps/myapp", "project": "myapp",
  "source": "registry",
  "image": "ghcr.io/owner/myapp",
  "imageEnvVar": "APP_IMAGE",
  "services": ["app", "worker"],
  "healthUrl": "https://app.example.com/api/health" }
```

`server-tools deploy myapp v1.2.3` then: pulls `ghcr.io/owner/myapp:v1.2.3`
(using whatever registry credentials the box is already logged in with),
writes `APP_IMAGE=ghcr.io/owner/myapp:v1.2.3` into `<dir>/.env`, runs
`docker compose -p myapp up -d --no-build`, confirms every container of every
listed service is `running` **and** on the image ID that was just pulled,
then polls `healthUrl`. On any failure after the pull it restores `.env` to the
exact bytes it had before (comments and quoting included), brings the stack
back on that image, and reports the rollback. A failure during the pull
changes nothing at all and says so.

#### Several images on one tag

An application built as a frontend and a backend is two repositories that ship
as one release. List them under `images` instead of naming a single `image`,
and each entry gets its own variable and its own services:

```json
{ "name": "myapp", "dir": "/apps/myapp", "project": "myapp",
  "source": "registry",
  "images": [
    { "image": "ghcr.io/owner/myapp-api", "envVar": "API_IMAGE", "services": ["api"] },
    { "image": "ghcr.io/owner/myapp-web", "envVar": "WEB_IMAGE", "services": ["web"] }
  ],
  "healthUrl": "https://app.example.com/api/health" }
```

`server-tools deploy myapp v1.2.3` pulls `myapp-api:v1.2.3` **and**
`myapp-web:v1.2.3`, then writes both references in a single edit of `.env` and
recreates the project once. The services of each entry are checked against
that entry's image ID, so a release where only half the images moved is caught
and rolled back even though the health endpoint answers perfectly - which is
the failure this shape exists to prevent.

The order is what makes it safe: every image is pulled before anything is
written, so a tag that was never pushed changes nothing at all. A rollback
restores the whole file, so either every reference goes back or none does. If
any of the variables named no image before the deploy, there is nothing to
come back to and the toolkit says which one rather than guessing a tag.

`images` and `image` are not mixed on one target: with `images`, the
`image`, `imageEnvVar` and `services` fields live inside each entry. Two
entries cannot share a variable (the second would overwrite the first) or a
service (it would have to run two image IDs at once). `envVar` defaults to
`APP_IMAGE`, so at most one entry can leave it out.

Nothing compiles on the host, so a release cannot starve the other stacks
sharing the box, and a rollback costs a pull rather than a second build. Four
consequences worth knowing:

- `image` must not carry a tag or digest; the tag is the deploy argument. A
private registry with a port (`registry.example.com:5000/owner/app`) is fine.
- The reference is **written to `.env`** rather than exported for one
  command. Compose stores no such state, so a later plain
  `docker compose up -d` would otherwise re-resolve `${APP_IMAGE:-...}` and
  quietly recreate the stack on the default tag. Reference it from your
  compose file as `image: ${APP_IMAGE}` and give it no fallback you would
  not want deployed.
- Rollback needs a previous value in `.env`. On the very first registry
  deploy there is none, and the toolkit says so rather than guessing a tag.
- Compose runs with the minimal environment described above, so the image
  reference in `.env` is the only thing that decides which image is used.

The app's compose file, `.env`, and directory must be visible to the agent
(bind-mount it into the container at the same path you configure).

### `git` source (build on the box)

```json
{ "name": "myapp", "dir": "/apps/myapp", "project": "myapp",
  "healthUrl": "https://app.example.com/api/health",
  "services": ["app"],
  "healthAttempts": 20, "healthDelay": "6s" }
```

`server-tools deploy myapp v1.2.3` verifies the working tree is clean,
fetches tags, checks out `v1.2.3`, runs `docker compose up -d --build`, polls
`healthUrl`, and on failure checks the previous commit back out, rebuilds,
and reports the rollback.

The build runs on the host, which is what makes this mode a poor fit for a
box hosting anything else: compiling a front-end can take the load average
into double digits for minutes, and the unrelated stacks feel it. Health
polling is also weaker here than it looks, because the previous containers
stay up and healthy for the whole build - so a poll can pass against the old
release. Listing `services` closes part of that gap.

## Application metrics

Numbers an application knows about itself, which the host cannot see. Full
contract in [docs/METRICS.md](METRICS.md).

```json
{ "name": "myapp", "label": "My application",
  "source": { "url": "http://127.0.0.1:3000/internal/metrics", "token": "${APP_METRICS_TOKEN}" },
  "schedule": "1h", "timeout": "10s", "retentionDays": 3650 }
```

| Field | Default | Meaning |
| --- | --- | --- |
| `name` | none | Required, unique. Becomes a filename and a URL path segment, so: letters, digits, `_`, `.` or `-`, starting alphanumeric. |
| `label` | the name | What the dashboard calls it. |
| `source` | none | Exactly one of `{ "url": ... }` or `{ "file": ... }`. A `url` source may carry a `token`, sent as `Authorization: Bearer`. The URL itself must not embed a username or password: `fetch` refuses those and quotes the URL back into logs and alerts. |
| `schedule` | `"1h"` | `"1h"`, `"03:00"` daily, `"sun 03:00"` weekly. Daily suits most numbers. |
| `timeout` | `"10s"` | How long to wait for the source. |
| `retentionDays` | `3650` | How long snapshots are kept. Ten years of daily samples is a few thousand lines. |
| `failuresBeforeAlert` | `checkDefaults` | Consecutive failed collections before one alert fires. |

The application publishes a versioned JSON document; the agent samples it,
stores each snapshot whole, and charts it. The agent holds no vocabulary for
any particular application - your app supplies the keys, the labels and the
units, and `kind` is only a rendering hint.

This is a deliberately slow channel. Per-second data wants a different tool.

Snapshots are stored under `dataDir/metrics/` and pruned by `retentionDays`,
**not** by `housekeeping.historyDays`. Keeping them out of the history
directory is the point: that pruner deletes by date regardless of topic, and 90
days is right for check samples and wrong for a record meant to last years. See
[docs/METRICS.md](METRICS.md) for why this is a separate directory rather than
a retention override.

## External dashboards

Tiles on the Overview linking out to dashboards you run elsewhere, with
status from a check you already have. Full recipes per tool in
[docs/DASHBOARDS.md](DASHBOARDS.md).

```json
{ "name": "charts", "label": "Team charts", "url": "https://charts.example.com",
  "kind": "grafana", "check": "charts-http" }
```

`kind` is a badge, not behaviour. `check` must name a configured check; its
state supplies the tile's pill, so the tile, the Checks page and your alerts
all agree. Dashboards are linked, never embedded: this page's CSP allows one
script by hash and no external assets, and that is worth keeping.

## Connect (data endpoints)

Named bearer tokens for the read-only `/connect/` endpoints that external
tools chart from. One token per consumer, each from the environment:

```json
{ "tokens": [ { "name": "charting", "token": "${CONNECT_TOKEN_CHARTING}" } ] }
```

Tokens must be at least 16 characters, so a `${VAR}` that resolved to an
empty string fails validation instead of standing guard as an empty token.
With no tokens configured the endpoints refuse everything except a signed-in
dashboard session. Tokens are accepted in the `Authorization: Bearer` header
only - never in a URL - and the only part of a token that ever appears in a
log is its name.

## Housekeeping

```json
{ "schedule": "04:45", "historyDays": 90, "tmpAge": "2d",
  "staleContainerAge": "24h", "keepImages": ["myapp:stable"],
  "clean": [ { "path": "/apps/myapp/storage/tmp", "maxAge": "7d" } ] }
```

| Field | Default | Meaning |
| --- | --- | --- |
| `schedule` | none | When the scheduled housekeeping pass runs. |
| `historyDays` | `90` | How many days of check/event history to keep. |
| `tmpAge` | `"2d"` | How long the toolkit's own temp files live. |
| `staleContainerAge` | `"24h"` | How long a container must have been stopped before the Storage page offers to remove it. |
| `keepImages` | `[]` | Image tag patterns that are never offered for removal, even when nothing is using them. `*` and `?` wildcards; matched against each tag. Use this to pin a known-good rollback image. |
| `clean` | `[]` | Age-based cleanup rules for directories you name. |

`clean` rules delete files older than `maxAge` inside the listed directories
(recursive, files only, symlinks never followed, then empty dirs). Point
these at cache/temp directories only.

`staleContainerAge` and `keepImages` only ever make the Storage page more
conservative. They cannot cause anything to be removed on their own: cleanups
still happen only when someone clicks the button or runs
`server-tools reclaim`.

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
