# External dashboards and data connectors

This toolkit keeps its own small dashboard and deliberately stays out of the
BI business. But a box that already runs a charting stack - Grafana, Apache
Superset, Redash, or anything like them - should not need screen-scraping to
chart this toolkit's numbers, and the operator should not need a bookmark
folder to reach those tools.

Compatibility is two halves, each useful without the other:

- **Linking out.** Register external dashboards in config and they appear as
  tiles on the Overview, with live status taken from a health check you
  already run.
- **Data in.** Read-only endpoints under `/connect/` serve the toolkit's
  stored numbers - checks, host samples, events, backup state, application
  metric snapshots - in the formats those tools consume.

Everything here is generic: the toolkit knows nothing about any particular
product. The per-tool sections below are setup recipes, not integrations.

## Linking out: registering a dashboard

```jsonc
"checks": [
  { "name": "charts-http", "type": "http", "url": "https://charts.example.com/api/health" }
],
"dashboards": [
  { "name": "charts", "label": "Team charts", "url": "https://charts.example.com",
    "kind": "grafana", "check": "charts-http" }
]
```

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Unique slug. |
| `url` | yes | Where the dashboard lives. The tile links straight to it. |
| `label` | no | What the tile says. Defaults to the name. |
| `kind` | no | Shown on the tile beside the URL (`grafana`, `superset`, `redash`, anything). A label, not behaviour. |
| `check` | no | The name of a configured check; its state becomes the tile's status pill. |

Status reuses the check machinery rather than adding a second prober: the
check already knows how to poll, alert, and recover, and naming it here means
the tile, the Checks page, and your alerts all agree.

**Linked, never embedded.** This dashboard ships no external assets and its
content security policy allows exactly one script, by hash - that strictness
is a feature, and an iframe would give it up. Every charting stack also sets
its own frame protections, so embedding would fail anyway. The tile is a
link.

## Data in: connect tokens

External tools cannot do magic-link logins, so `/connect/` authenticates with
bearer tokens. One named token per consumer, so you can revoke one without
rotating the rest:

```bash
openssl rand -hex 32   # one per consumer, into the .env file
```

```jsonc
"connect": {
  "tokens": [
    { "name": "charting", "token": "${CONNECT_TOKEN_CHARTING}" },
    { "name": "reports",  "token": "${CONNECT_TOKEN_REPORTS}" }
  ]
}
```

Rules, and the reasons behind them:

- **Tokens travel in the `Authorization: Bearer` header only.** A token in a
  query string is written to every proxy log between the consumer and this
  box. All of the tools below can send headers; each recipe shows how.
- **A token that resolves empty fails validation.** `${MISSING_VAR}`
  interpolates to an empty string, and an endpoint guarded by an empty token
  is an open endpoint that looks configured.
- **With no tokens configured, `/connect/` refuses everything.** Fail closed.
  A signed-in dashboard session also works, so you can eyeball any endpoint
  in the browser you are already logged into.
- Everything is read-only and GET-only. Revoking a token means removing it
  from config and restarting the agent.

## The endpoints

`GET /connect` returns a JSON index of everything below - if an agent is
setting up a consumer for you, point it there instead of at this prose.

| Endpoint | What it serves |
| --- | --- |
| `/connect/prometheus` | Current state of everything, as gauges in the Prometheus text format. |
| `/connect/checks.{json,csv}` | Latest state of every check. |
| `/connect/check-history.{json,csv}?check=&days=` | Check samples over time. `days` defaults to 7. |
| `/connect/host.{json,csv}?days=` | Host cpu/memory/load samples, one per minute while the agent runs. `days` defaults to 7. |
| `/connect/events.{json,csv}?days=` | Everything the toolkit did or noticed. `days` defaults to 7. |
| `/connect/backups.{json,csv}` | Latest state of every backup target. |
| `/connect/metrics/<app>.{json,csv}?days=` | Application metric snapshots, one row per value. `days` defaults to 90. |

JSON endpoints return an array of flat objects; CSV endpoints return the same
rows with a header line. Flat rows on purpose: the consumers are SQL engines
and chart builders, and they want tables. Responses are capped at 20,000
rows; `days` accepts 1 to 3650.

The Prometheus endpoint emits no sample timestamps - a scraper silently drops
samples it considers stale, and a slow channel's samples usually are.
Freshness is exposed instead as `servertools_*_age_seconds` metrics you can
alert on. A value that is not a finite number is omitted, never emitted as
`NaN`. Breakdown metrics export both a total
(`servertools_app_metric{kind="breakdown"}`) and one
`servertools_app_metric_category` sample per category, so a panel can stack
them.

## Grafana

The common Grafana deployment charts what Prometheus scrapes, so the recipe
is one scrape job. In `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: server-tools
    metrics_path: /connect/prometheus
    scheme: https
    scrape_interval: 60s
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/server-tools.token   # the raw token, one line
    static_configs:
      - targets: ["ops.example.com"]
```

Then in Grafana, panels query the `servertools_*` series like any other:

```promql
servertools_check_status                          # 0 ok, 1 warn, 2 fail
servertools_backup_age_seconds{target="app-db"}   # alert when > 90000
servertools_app_metric{app="myapp"}
sum by (category) (servertools_app_metric_category{key="tier_distribution"})
```

Provisioning the data source, if you manage Grafana from files
(`/etc/grafana/provisioning/datasources/prometheus.yml`):

```yaml
apiVersion: 1
datasources:
  - name: Prometheus
    type: prometheus
    url: http://127.0.0.1:9091   # wherever your Prometheus listens
```

**Without Prometheus:** Grafana's Infinity data source plugin
(`yesoreyeram-infinity-datasource`) reads the JSON and CSV endpoints
directly. Create an Infinity data source, set *Auth type* to *Bearer token*,
paste the token, and query
`https://ops.example.com/connect/metrics/myapp.json` with format *Table*.
History endpoints carry an ISO `at`/`collectedAt` column Grafana parses as
time.

## Apache Superset

Superset speaks SQL to databases; recent releases bundle
[Shillelagh](https://github.com/betodealmeida/shillelagh), whose generic JSON
adapter turns an HTTP JSON endpoint into a queryable table.

1. **Data → Databases → + Database**, choose *Other*. SQLAlchemy URI:

   ```
   shillelagh://
   ```

2. In **Advanced → Other → Engine parameters**, pass the token as a request
   header:

   ```json
   {
     "connect_args": {
       "adapter_kwargs": {
         "genericjsonapi": {
           "request_headers": { "Authorization": "Bearer YOUR-TOKEN-HERE" }
         }
       }
     }
   }
   ```

3. In SQL Lab, the endpoints are tables:

   ```sql
   SELECT collectedAt, key, value
   FROM "https://ops.example.com/connect/metrics/myapp.json"
   WHERE key = 'records_total'
   ORDER BY collectedAt;
   ```

   Save the query as a dataset and chart it like any other. `SUM(value)
   GROUP BY category` over a breakdown key reconstructs its total.

If your Superset predates the generic JSON adapter, the CSV endpoints serve
the same rows for whatever CSV path your version supports, and the fallback
that always works is a scheduled job loading the CSV into the database
Superset already queries.

## Redash

Redash's **JSON** data source queries HTTP APIs directly.

1. **Settings → Data Sources → New**, type *JSON*.
2. A query is YAML naming the URL and the auth header:

   ```yaml
   url: https://ops.example.com/connect/checks.json
   headers:
     Authorization: Bearer YOUR-TOKEN-HERE
   ```

   Parameters go in the URL: `.../connect/metrics/myapp.json?days=365`.

3. The flat rows land as a result table; filter, visualize, and put the
   result on a Redash dashboard as usual.

## Deploying

The agent already sits behind your reverse proxy with TLS
([DEPLOY.md](DEPLOY.md)); `/connect/` rides the same listener, so there is
nothing new to expose. A consumer on the same box can use
`http://127.0.0.1:9090/connect/...` and skip the proxy entirely.

Each consumer needs three lines: one in `.env`, one in the compose file, and
one in `config.json`.

```bash
# .env, next to your compose file (see deploy/.env.example)
CONNECT_TOKEN_CHARTING=   # openssl rand -hex 32
```

```yaml
# docker-compose.yml, in the agent's environment block - compose only
# forwards variables named here, so a token missing from this list reaches
# the agent as an empty string
CONNECT_TOKEN_CHARTING: ${CONNECT_TOKEN_CHARTING:-}
```

reference it from `config.json` as shown above, and restart the agent.
`server-tools validate` refuses a token that resolved empty rather than let
it stand guard - so a forgotten line fails loudly at startup instead of
quietly exposing nothing.

## What this is not

The endpoints serve counts, statuses, sizes, and the numbers applications
chose to publish - the same things the dashboard shows, never application
content. There is no query language, no write path, and no per-panel API:
the tool on the other end is the query engine, and this stays the small,
auditable data source underneath it.

CSV values are quoted per RFC 4180 and otherwise passed through untouched -
including a value that begins with a formula character, since mangling data
to defend a spreadsheet would corrupt it for the query engines these
endpoints exist for. Treat the CSV as machine input; if you hand one to a
spreadsheet, use its text-import path.
