# Deploying server-tools on a VPS

This walkthrough assumes the usual single-box shape: a Linux VPS you can SSH
into, Docker + Docker Compose installed, your applications running under
compose in directories like `~/apps/<name>`, and a reverse proxy (Caddy or
nginx) terminating TLS on the host. Adjust paths to taste.

Total time: about 20 minutes.

## 1. Get the code onto the box

```bash
ssh you@your-server
git clone https://github.com/<you>/server-tools.git ~/server-tools
cd ~/server-tools/deploy
```

## 2. Create your secrets file

```bash
cp .env.example .env
openssl rand -base64 32    # generate a backup passphrase
nano .env                  # paste it as BACKUP_PASSPHRASE, fill the rest
chmod 600 .env
```

**Copy `BACKUP_PASSPHRASE` somewhere off this box** (password manager). Every
backup artifact is encrypted with it; lose it and backups are unrecoverable.

The S3 keys are optional (leave empty to keep backups local-only). For
offsite you want an S3-compatible bucket; create credentials scoped to one
bucket and paste them here.

## 3. Write your config

```bash
cp config.example.json config.json
nano config.json
```

Work through it section by section against [CONFIG.md](CONFIG.md):

1. **checks**: point the `http` check at your app's real health endpoint,
   set `container`/`postgres` names to your real container names
   (`docker ps --format '{{.Names}}'` shows them), and set `tls-cert.host`
   to your public domain. Keep `disk.path` as `/host` (the compose file
   mounts the host filesystem there).
2. **backups**: one `postgres` target per app database (container name, db
   user, db name), plus a `files` target per media directory if you have
   them. Leave the `s3` block out until offsite credentials exist.
3. **deploys**: one entry per app, with `dir` set to the path *as the agent
   container will see it* (see the volume mounts in step 4).
4. **web**: set `baseUrl` to the public URL you will serve the dashboard on
   (for example `https://ops.example.com`) and `allowedEmails` to your email.
5. **alerts**: a webhook (an ntfy topic is the two-minute option: pick a
   long random topic name and subscribe to it in the ntfy app) and/or SMTP.

Validate before starting:

```bash
docker run --rm -v "$PWD/config.json:/app/config.json:ro" \
  -v "$PWD/..:/src:ro" -w /src \
  --env-file .env -e SERVER_TOOLS_CONFIG=/app/config.json \
  node:22-alpine node src/cli.js validate
```

(Or `node src/cli.js validate` directly if the box has Node.)

## 4. Mount your application directories

Edit `docker-compose.yml` and uncomment/add one volume line per application
the deploy helper should manage, keeping container path = config path:

```yaml
    volumes:
      - ./config.json:/app/config.json:ro
      - server-tools-data:/data
      - /var/run/docker.sock:/var/run/docker.sock
      - /:/host:ro
      - /home/you/apps/myapp:/apps/myapp        # <- your app checkout
```

Media directories for `files` backup targets need to be visible too (a
read-only mount is enough for manifest/verify: add `:ro`).

## 5. Start the agent

```bash
docker compose up -d --build
docker compose logs -f agent    # watch the first checks run
```

You should see `scheduled N checks`, backup scheduling, and
`dashboard listening on ...`.

## 6. Wire the reverse proxy

The dashboard listens on `127.0.0.1:9090` (host side). Point a subdomain at
it.

**Caddy** (`/etc/caddy/Caddyfile`):

```
ops.example.com {
    reverse_proxy localhost:9090
}
```

```bash
sudo systemctl reload caddy
```

**nginx**:

```nginx
server {
    server_name ops.example.com;
    listen 443 ssl;
    # ssl_certificate ...; ssl_certificate_key ...;
    location / {
        proxy_pass http://127.0.0.1:9090;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

Add a DNS record for the subdomain pointing at the box. The dashboard sets
secure cookies when `web.baseUrl` starts with `https://`.

## 7. First login

Two ways to get a login link:

- **Email** (if SMTP alerts are configured): open
  `https://ops.example.com`, enter your email (must be in
  `web.allowedEmails`), click the link that arrives.
- **CLI** (no SMTP needed):

  ```bash
  docker compose exec agent node src/cli.js login-link you@example.com
  ```

  Open the printed URL in your browser. Links are single-use and expire in
  15 minutes; the session lasts `web.sessionDays` (default 30).

## 8. Prove the backups work (do this now, not during an incident)

```bash
# take a first backup of each target
docker compose exec agent node src/cli.js backup-all

# restore the latest artifact into a scratch database and validate it
docker compose exec agent node src/cli.js drill app-db

# see what exists locally and offsite
docker compose exec agent node src/cli.js artifacts app-db
```

The drill result (pass/fail, table and row counts) is recorded and shown on
the dashboard. Put a monthly reminder in your calendar to run it, or add a
`command` check that alerts when the last drill is too old.

## 9. Try a deploy (optional but recommended)

```bash
docker compose exec agent node src/cli.js deploy myapp v1.2.3 --dry-run
docker compose exec agent node src/cli.js deploy myapp v1.2.3
```

The deploy records an event either way; a failed health check rolls back to
the previous ref automatically.

## Updating server-tools itself

```bash
cd ~/server-tools && git pull
cd deploy && docker compose up -d --build
```

State lives in the `server-tools-data` volume and survives rebuilds.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `docker socket not reachable` in logs | Socket volume missing or perms; confirm `/var/run/docker.sock` is mounted |
| `container "x" not found` | Name mismatch: `docker ps --format '{{.Names}}'` and match exactly, or use the compose service name |
| disk check reads 0%/wrong | `path` should be `/host` (the bind mount), not `/` inside the container |
| Login link says expired | Links are single-use, 15 min; generate a fresh one |
| No alert emails | Check `alerts.smtp` host/port; port 465 = implicit TLS, 587 = STARTTLS; watch agent logs for `alert channel failed` |
| Deploy says "working tree has local changes" | The app checkout is dirty; commit/stash on the box or clean it, then retry |
