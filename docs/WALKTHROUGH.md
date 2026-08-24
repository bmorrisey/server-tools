# A worked example: one box, three charting tools

[DASHBOARDS.md](DASHBOARDS.md) is the reference for the dashboard-compatibility
features. This page is the same material as a story: one small server, the
agent, and three charting stacks wired up end to end, so you can see what the
day-to-day experience looks like before you configure anything. Every command,
config block, and query here is real; the hostnames and numbers are
illustrative.

The cast:

- The agent, serving its dashboard at `ops.example.com`.
- An application, `storefront`, publishing metrics to the agent hourly
  ([METRICS.md](METRICS.md)).
- Grafana at `charts.example.com`, fed by a Prometheus on the same box.
- Apache Superset at `analytics.example.com`.
- Redash at `queries.example.com`.

## The configuration, all of it

Three dashboards registered, two of them backed by checks that already
existed, and one connect token per consumer:

```jsonc
"checks": [
  { "name": "charts-http",    "type": "http", "url": "https://charts.example.com/api/health" },
  { "name": "analytics-http", "type": "http", "url": "https://analytics.example.com/health" }
],
"dashboards": [
  { "name": "charts",    "label": "Team charts", "url": "https://charts.example.com",
    "kind": "grafana",  "check": "charts-http" },
  { "name": "analytics", "label": "Analytics",   "url": "https://analytics.example.com",
    "kind": "superset", "check": "analytics-http" },
  { "name": "queries",   "label": "Queries",     "url": "https://queries.example.com",
    "kind": "redash" }
],
"connect": {
  "tokens": [
    { "name": "charting", "token": "${CONNECT_TOKEN_CHARTING}" },
    { "name": "reports",  "token": "${CONNECT_TOKEN_REPORTS}" }
  ]
}
```

Plus one line per token in `.env` (`openssl rand -hex 32`) and one per token in
the compose file's `environment` block, exactly as
[DASHBOARDS.md](DASHBOARDS.md#deploying) describes. That is the whole setup;
everything below follows from it.

## Morning: the Overview is the front door

The operator opens `ops.example.com` and the Overview now has an "External
dashboards" section: three tiles above the host graphs.

- **Team charts** shows an `ok` pill and "HTTP 200 in 41ms". That status is
  not a new prober; it is the `charts-http` check the box was already
  running, so the tile, the Checks page, and the alerts all agree.
- **Analytics** likewise, from `analytics-http`.
- **Queries** has no check configured, so its pill is a neutral `link`, not a
  pretend green. No check, no claim.

Each tile is a plain link that opens the tool in a new tab. Nothing is
embedded; the content security policy still allows exactly one script, by
hash.

## Grafana charts the box, via Prometheus

Prometheus on the box scrapes the agent with one job
([the recipe](DASHBOARDS.md#grafana)), bearer token in a credentials file.
Grafana then treats `servertools_*` like any other series. A "box health"
board built that morning:

| Panel | Query |
| --- | --- |
| Checks passing stat | `count(servertools_check_status == 0)` vs `count(servertools_check_status)` |
| Backup age stat, alert at 25h | `servertools_backup_age_seconds{target="app-db"} / 3600` |
| Records over 90 days | `servertools_app_metric{app="storefront",key="records_total"}` |
| Tier mix, stacked | `sum by (category) (servertools_app_metric_category{app="storefront",key="tier_distribution"})` |
| Host memory, threshold line at 85 | `servertools_host_memory_used_percent` |

The `records_total` the application publishes hourly is the same number the
agent's own Metrics page charts: one source of truth, two lenses on it.
Freshness is its own series (`servertools_app_metrics_age_seconds`,
`servertools_check_age_seconds`, ...), so a stalled channel shows up as a
climbing age, never as silently stale samples.

## Afternoon: an analyst asks their own question

In Superset's SQL Lab, with the shillelagh datasource from
[the recipe](DASHBOARDS.md#apache-superset), the connect endpoints are just
tables. A teammate who has never seen the box writes:

```sql
SELECT collectedAt, key, value
FROM "https://ops.example.com/connect/metrics/storefront.json"
WHERE key = 'records_total'
ORDER BY collectedAt;
```

Rows come back flat on purpose: one row per value, a `category` column for
breakdowns, because SQL engines want tables. `SUM(value) GROUP BY category`
over a breakdown key reconstructs its total. The query gets saved as a
dataset and charted like any other.

## Redash wants the backup ledger

A Redash query is YAML naming the URL and the header
([the recipe](DASHBOARDS.md#redash)):

```yaml
url: https://ops.example.com/connect/backups.json
headers:
  Authorization: Bearer YOUR-TOKEN-HERE
```

The result grid shows every backup target's latest state - last success, size,
whether the restore drill passed - and lands on a Redash dashboard next to the
business numbers.

## What the tools actually see

`GET /connect` (with a token, or from a signed-in browser session) describes
every endpoint, so a new consumer - or an agent setting one up for you - never
starts from prose:

```json
{
  "description": "Read-only data endpoints for external dashboards. Authenticate with 'Authorization: Bearer <token>'.",
  "docs": "docs/DASHBOARDS.md",
  "maxRows": 20000,
  "endpoints": [
    { "path": "/connect/prometheus", "format": "prometheus-text-0.0.4",
      "description": "Current state of checks, backups, host, and application metrics, as gauges." },
    { "path": "/connect/checks.json", "format": "json",
      "description": "Latest state of every configured check.", "params": {} },
    { "path": "/connect/metrics/storefront.json", "format": "json",
      "description": "Application metric snapshots for \"storefront\", one row per value.",
      "params": { "days": "1..3650, default 90" } }
  ]
}
```

And the exposition itself is ordinary Prometheus text:

```text
# HELP servertools_check_status Check status: 0 ok, 1 warn, 2 fail
# TYPE servertools_check_status gauge
servertools_check_status{check="charts-http",type="http"} 0
servertools_check_status{check="analytics-http",type="http"} 0
# HELP servertools_app_metric A value the named application published about itself
# TYPE servertools_app_metric gauge
servertools_app_metric{app="storefront",key="records_total",kind="count"} 128394
```

No sample timestamps, by design: a scraper silently drops samples it decides
are stale, so freshness ships as `*_age_seconds` gauges you can alert on
instead.

## The day Grafana goes down

Because the tile borrows a real check, an outage is one story everywhere. The
`charts-http` check fails, so the Team charts tile flips to `fail` with
"connect ECONNREFUSED", the Checks page agrees, and the alert that fires is
the one the operator already trusts. Nothing new to configure, nothing to
disagree.

Meanwhile a consumer with a wrong or revoked token gets a clean refusal, not a
half-working endpoint:

```text
$ curl -s -i -H "Authorization: Bearer wrong" \
    https://ops.example.com/connect/checks.json
HTTP/1.1 401 Unauthorized
www-authenticate: Bearer

{ "error": "unauthorized",
  "hint": "send 'Authorization: Bearer <token>' from connect.tokens" }
```

With no tokens configured at all, `/connect/` refuses everything. Fail closed.

## The tally

For three charting stacks reading one box, the setup was: two checks that
mostly already existed, three `dashboards` entries, two tokens (three lines
each: `.env`, compose `environment`, `config.json`), one Prometheus scrape
job, one Superset engine-parameters block, and one Redash YAML header. Each
consumer holds its own named token, so revoking one never touches the others.
