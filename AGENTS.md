# Repository guide for coding agents

## What this is

An operations toolkit (health checks, alerts, encrypted backups, safe
deploys, housekeeping, admin dashboard) for a single-box Docker VPS. One
Node.js process (`src/agent.js`) schedules everything and serves the
dashboard; `src/cli.js` runs any operation by hand.

## Hard rules

- **Zero runtime npm dependencies.** The `dependencies` object in
  package.json stays empty. Everything is built on `node:` builtins. If a
  feature seems to need a package, implement the minimal slice of it in-tree
  (see `src/smtp.js`, `src/backup/s3.js`) or reconsider the feature.
- **Generic by design.** This toolkit knows nothing about any specific
  application. Configuration describes targets abstractly (containers, URLs,
  directories). Do not add code, comments, or docs that reference a specific
  product or deployment.
- **Fail soft, alert loud.** A missing optional integration (SMTP, S3,
  webhook) must never crash the agent; a failing check or backup must always
  be recorded in the store and alerted if channels exist.
- **Never log secrets.** Secrets arrive only via environment variables
  referenced from config as `${VAR}`. No secret values in logs, state files,
  history, error messages, or URLs.
- **Backups copy bytes as they are.** No decryption, transformation, or
  inspection of application data anywhere in the backup path.
- **Destructive actions stay conservative.** This runs against live
  production. Never delete a volume, never touch a running container, and
  never remove anything the operator was not shown first. Any new cleanup
  must compute its candidate list as a pure, tested function and act on
  exactly that list. See the safety model at the top of `src/storage.js`.
- No em-dashes in code, comments, docs, or commit messages; use plain
  hyphens.
- Commits: imperative subject line, body explains why; no AI attribution
  trailers or generated-by footers.
- Work lands via feature branches and pull requests into `main`, never direct
  pushes to `main`.

## Layout

| Path | Purpose |
| --- | --- |
| `src/agent.js` | daemon: schedules checks/backups/housekeeping, starts web |
| `src/cli.js` | manual entry point for every operation |
| `src/config.js` | config load + env interpolation + validation |
| `src/checks.js` | check runners + consecutive-failure alert state machine |
| `src/alerts.js`, `src/smtp.js` | alert routing; minimal SMTP client |
| `src/docker.js` | Docker Engine API over the unix socket (list/inspect/stats/exec) |
| `src/metrics.js` | host metrics from /proc + statfs |
| `src/store.js` | JSON state + day-partitioned JSONL history under dataDir |
| `src/backup/` | backup engine, AES-256-GCM streaming crypto, S3 SigV4 client, GFS retention, restore + drill |
| `src/deploy.js` | git checkout + compose build + health gate + rollback |
| `src/housekeep.js` | history pruning, temp expiry, configured dir cleanup |
| `src/storage.js` | disk usage analysis + conservative, previewed reclamation |
| `src/remediate.js` | plain-language incident diagnosis + validated one-click actions |
| `src/web/` | dashboard: http server, magic-link auth, server-rendered UI, action routes |
| `deploy/` | Dockerfile, docker-compose.yml, config + env examples |
| `test/` | node:test unit tests, no framework |

## Working here

```bash
node --test                      # run the suite; keep it green
node src/cli.js validate          # after any config-schema change
node --check src/<file>.js        # syntax check a module
```

- Tests use `node:test` + `node:assert/strict` only. Pure logic (parsing,
  retention, crypto, signing, state machines) must have unit tests; things
  needing a live Docker daemon are exercised via the CLI, not unit tests.
- State files are human-readable on purpose (JSON/JSONL); an operator with
  `cat` and `jq` must be able to debug an incident. Do not switch the store
  to a binary format.
- The dashboard is server-rendered HTML with inline CSS/JS and no external
  assets (works with a strict CSP and no CDN). Keep it that way.
- Config changes need: validation in `src/config.js`, documentation in
  `docs/CONFIG.md`, and the example in `deploy/config.example.json` updated
  together.
