# Application metrics

Host metrics answer "how is the box". Application metrics answer "how is the
thing running on it": row counts, storage per tenant, queue depth, records
created today. The box cannot see any of those, so the application publishes
them and the agent samples, stores and charts them.

**This is a slow channel by design.** The default interval is hourly and daily
is a better default for most numbers. If you need per-second data you want a
time-series database and a metrics agent, not this. What this is good at is the
long view: a number sampled once a day for years, on the page you already have
open, behind the login you already have.

## The contract

Your application publishes one JSON document. The agent either fetches it from
a URL or reads it from a file.

```json
{
  "schema": 1,
  "capturedAt": "2026-08-22T03:00:00Z",
  "metrics": {
    "records_total":      { "value": 128394, "label": "Records",        "kind": "count",  "cumulative": true },
    "records_created":    { "value": 412,    "label": "Created today",  "kind": "count" },
    "storage_used":       { "value": 8.42e9, "label": "Storage used",   "kind": "bytes" },
    "avg_items_per_user": { "value": 3.7,    "label": "Items per user", "kind": "number", "precision": 1 },
    "tier_distribution":  { "value": { "free": 812, "pro": 44 },        "kind": "breakdown" }
  }
}
```

### The envelope

| Field | Required | Meaning |
| --- | --- | --- |
| `schema` | yes | Document version. Must be `1`. |
| `metrics` | yes | Object of metric key to metric. May be empty; an application with nothing to say yet is not an error. |
| `capturedAt` | no | When the application computed these numbers, if that differs from when the agent read them. |

**`schema` is checked, not guessed.** A document declaring a version this agent
does not know is refused and the collection fails. That is deliberate: a
payload the agent half-understands is worse than one it rejects, because the
numbers still render and nothing looks wrong. When the shape needs to change,
the version goes up and the agent is taught the new one.

`capturedAt` is recorded but never used for ordering or retention. Those run on
the agent's own clock, because a clock the agent does not control cannot be
allowed to decide what gets deleted.

### A metric

| Field | Required | Meaning |
| --- | --- | --- |
| `value` | yes | A finite number. For `kind: "breakdown"`, an object of category to number. |
| `kind` | no | Rendering hint, default `number`. One of `count`, `bytes`, `number`, `percent`, `duration`, `breakdown`. |
| `label` | no | What a human should see. Defaults to the key. Max 120 characters. |
| `precision` | no | Decimal places for `number` and `percent`, 0 to 6. |
| `cumulative` | no | `true` for a running total, `false` for a per-period figure. Recorded for the reader's benefit. |

**`kind` says how to format a number, never what it means.** The agent holds no
vocabulary for any particular application and is not going to grow one: your
application owns the keys, the labels and the units. Two things follow, and
both matter because a unit that is only implied is a unit that eventually gets
it wrong:

- `duration` is **milliseconds**.
- `percent` is **0 to 100**, not 0 to 1.

Metric keys must start with a letter or digit and contain only letters, digits,
`_`, `.` or `-`.

### Metrics may come and go

Add a metric whenever you like; it starts charting from the first snapshot that
contains it. Stop publishing one and its history is kept, listed on the page as
no longer published. History is never back-filled with zeroes for a metric that
did not exist: a gap in a chart is honest, and a zero is a claim your
application never made.

## Limits

The document arrives from a separate application that may be broken,
mid-deploy, or compromised, so it is treated as untrusted input:

| Limit | Value |
| --- | --- |
| Document size | 256 KB |
| Metrics per document | 200 |
| Categories per breakdown | 50 |
| Key length | 64 characters |
| Label length | 120 characters |

A metric that fails validation is dropped, counted, and named in the recorded
detail so you can tell whoever wrote the application what to fix. The rest of
the document is still stored. An envelope that fails - bad JSON, wrong schema,
no `metrics` object - fails the whole collection and alerts.

Labels are escaped wherever they are rendered, like any other untrusted string.

## Publishing from your application

### As an HTTP endpoint

Serve the document from somewhere only the agent can reach - a port bound to
localhost, or an internal route behind your own auth. If you protect it with a
bearer token, put the token in the environment and reference it from the config
the way every other secret here works:

```jsonc
{ "name": "myapp",
  "source": { "url": "http://127.0.0.1:3000/internal/metrics", "token": "${MYAPP_METRICS_TOKEN}" } }
```

The token is sent as `Authorization: Bearer <token>` and appears in no log
line, error message, or recorded event.

### As a file

For an application that cannot expose an endpoint, or where the numbers are
expensive to compute, write the file from a cron job and point the agent at it:

```jsonc
{ "name": "myapp", "source": { "file": "/apps/myapp/metrics.json" } }
```

Write it atomically - to a temporary name in the same directory, then rename -
so the agent cannot read a half-written file.

## What the agent does with it

1. Reads the document on the configured schedule.
2. Validates it, dropping and reporting individual bad metrics.
3. Appends the whole snapshot to `dataDir/metrics/<app>-YYYY-MM.jsonl`.
4. Prunes month-files entirely past `retentionDays` (default 3650, ten years).

Snapshots deliberately do **not** live in the history directory, which is
pruned to `housekeeping.historyDays` (90 by default). That setting is right for
check samples and events and wrong for a record meant to last years, and a
long series should not quietly depend on a number set for something else.

The alternative considered was per-topic retention inside the existing history
pruner. A separate directory was chosen for two reasons. That pruner walks
`history/`, matches any `-YYYY-MM-DD.jsonl`, and deletes by date regardless of
topic, so a series it cannot reach is safe by construction rather than by an
override staying correct through every later config edit and upgrade; and the
failure mode here is data quietly going missing months later, which is worth
removing the possibility of rather than guarding against. Month partitioning
also keeps a decade to roughly 120 files rather than 3,650, which matters
because charting a long window opens all of them. A test runs a real
housekeeping pass and asserts it prunes the history file it is meant to and
leaves the snapshot alone.

A failed collection is recorded, shown on the page, and alerted on the same
consecutive-failure rule as a check - loud, because a gap nobody noticed is the
one thing that makes a years-long series worthless.

## Reading it back

The dashboard's **Metrics** page shows a block per published number: the
current value formatted by its `kind`, the change since the previous sample and
against roughly a week earlier, and the history as a chart.

Drag the chart to pan it, and use its `+` and `-` buttons to zoom. On a
desktop, ctrl-scroll (or a trackpad pinch) zooms as well; a plain scroll is
left to the page, because a chart covers most of every card and stealing the
wheel would make the page unscrollable. Reset appears once you have zoomed.

**Deltas are computed when the page is drawn and never stored.** A stored delta
can disagree with the values it came from after a backfill, a clock correction,
or a pruned snapshot, and then there are two truths and no way to tell which is
lying. The week-ago comparison is only offered when a sample actually exists
near that point; inventing one the data does not support would be worse than
showing none.

From the terminal:

```bash
server-tools metrics            # latest snapshot for every configured app
server-tools metrics myapp      # just one
server-tools collect            # collect now rather than waiting for the schedule
server-tools collect myapp
```

## What this is not

No ad-hoc queries, no cross-filtering, no dashboard builder, no alerting on
metric thresholds. Those are the features that turn a small tool into a BI
platform with its own patch cadence and its own auth surface, which is the
thing a single-box operator was trying to avoid.

If you outgrow this, the snapshots are line-delimited JSON in a documented
location and nothing stops you feeding them to something larger.
