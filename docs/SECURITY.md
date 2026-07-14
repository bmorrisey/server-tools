# Security notes

What the agent can do, how the dashboard authenticates, and how secrets and
backups are protected. Read this before exposing the dashboard publicly.

## Trust model

server-tools is an *operator* tool: it is deliberately powerful on its own
box. With the Docker socket mounted it can exec into any container, which is
root-equivalent on the host. Treat the agent's config and environment with
the same care as root credentials, and treat dashboard access as operator
access.

What it does with that power is intentionally narrow and reviewable: the
Docker client implements only list/inspect/stats/exec, and exec is used for
`pg_dump`, `psql`, and the in-container commands you configure yourself.

## Dashboard authentication

- **Magic links only.** No passwords to stuff, reuse, or leak. A login link
  is a single-use token (128-bit random, stored hashed) that expires in 15
  minutes and can only be issued to addresses on the `web.allowedEmails`
  allowlist.
- Links arrive by email (when SMTP is configured) or from the CLI
  (`server-tools login-link you@example.com`), so losing email access never
  locks you out of your own box.
- A successful login sets an httpOnly, SameSite=Lax session cookie
  (`Secure` when `web.baseUrl` is https), valid for `web.sessionDays`
  (default 30). Sessions are server-side records (random id, stored hashed)
  and can be revoked by deleting them from the data volume.
- Login attempts are rate-limited per IP and per email; token comparison is
  constant-time.
- The dashboard binds to localhost (via the compose port mapping) and is
  meant to sit behind your TLS-terminating reverse proxy.

Everything under `/` except the login flow and the tool's own health probe
(`/healthz`) requires a session.

## Secrets

- Secrets live in environment variables, referenced from config as
  `"${VAR}"`. The config file itself stays secret-free and diffable.
- Nothing secret is ever written to logs, state files, or history. Error
  messages from external services are truncated and never include
  credentials.
- The example compose file passes secrets via an env file with `0600`
  permissions next to the compose file; they are never baked into the image.

## Backups

- Artifacts are encrypted before they leave memory: `pg_dump` output streams
  through gzip into AES-256-GCM (key derived from `BACKUP_PASSPHRASE` with
  scrypt N=2^15). The GCM tag authenticates the whole artifact, so
  tampering or truncation fails decryption loudly.
- An encrypted artifact is safe to store on any offsite provider; the
  provider sees ciphertext only. S3 requests are signed (SigV4) with
  credentials you scope to a single bucket.
- Application content that is already encrypted at rest stays exactly as-is:
  the backup path never decrypts, transforms, or inspects application data.
- Restore requires the passphrase; keep a copy in a password manager that
  survives the loss of the server. There is deliberately no recovery path
  without it.

## Dashboard content

The dashboard renders operational metadata only: check statuses, latencies,
sizes, counts, timestamps, container states, and event descriptions composed
by this toolkit. It has no code path that reads application database rows or
media files.

## Hardening checklist

- [ ] Dashboard published only through the reverse proxy over HTTPS
  (`127.0.0.1` port mapping, never `0.0.0.0`).
- [ ] `web.allowedEmails` contains exactly the operators.
- [ ] `.env` is `chmod 600` and outside version control.
- [ ] `BACKUP_PASSPHRASE` copied to a password manager off the box.
- [ ] S3 credentials scoped to the backup bucket only.
- [ ] Backup drill run and green (`server-tools drill <target>`).
- [ ] Alert channel configured and test-fired (stop a container briefly and
  watch for the alert + recovery pair).

## Reporting

If you find a vulnerability, open a private security advisory on the
repository rather than a public issue.
