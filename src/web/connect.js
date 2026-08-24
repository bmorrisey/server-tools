/**
 * Data connectors: the toolkit's stored numbers, in formats external
 * dashboards consume.
 *
 * This is the outbound half of dashboard compatibility. The toolkit keeps its
 * own small dashboard, and deliberately stays out of the BI business - but an
 * operator already running a charting stack should not have to screen-scrape
 * to get these numbers into it. Three formats cover the common consumers:
 *
 *   /connect/prometheus       text exposition, for anything that scrapes -
 *                             which is how the common charting stacks are fed
 *   /connect/<series>.json    flat rows, for JSON-speaking query runners
 *   /connect/<series>.csv     the same rows, for SQL tools that can query a
 *                             CSV URL
 *
 * Flat rows rather than nested documents, because the consumers are SQL
 * engines and chart builders: they want tables.
 *
 * Everything here is read-only and GET-only; there is no state to mutate and
 * therefore no CSRF surface. Access is a named bearer token from config,
 * compared in constant time and never logged - or an ordinary dashboard
 * session, so an operator can eyeball an endpoint in the browser they are
 * already signed into. With no tokens configured the namespace refuses
 * outright: an endpoint that is open because nobody finished configuring it
 * is the wrong default for production data.
 *
 * Tokens travel in the Authorization header only. A token in a query string
 * would be written to every proxy log between the consumer and this box, and
 * the house rule is no secrets in URLs. All of the supported consumers can
 * send headers; the docs show each one.
 */
import crypto from "node:crypto";
import { safeEqual } from "../util.js";
import { numericValue } from "../appmetrics/snapshot.js";

/** The most rows any one response will carry. */
export const MAX_ROWS = 20_000;

/** The furthest back a days= parameter may reach. */
export const MAX_DAYS = 3650;

const sha256 = (v) => crypto.createHash("sha256").update(v).digest("hex");

/* -------------------------------------------------------------------------
 * Authentication
 * ---------------------------------------------------------------------- */

/**
 * Resolve a request to the name of the token that authorized it, or null.
 *
 * Comparison is hash-then-timing-safe, like every other secret comparison
 * here. The name exists so an operator can tell consumers apart and revoke
 * one without rotating the rest; it is the only thing about a token that is
 * ever allowed into a log line.
 */
export function authorize(tokens, authorizationHeader) {
  const match = /^Bearer\s+(.+)$/i.exec(String(authorizationHeader ?? "").trim());
  if (!match) return null;
  const presented = sha256(match[1]);
  for (const entry of tokens ?? []) {
    if (typeof entry?.token !== "string" || entry.token.length === 0) continue;
    if (safeEqual(presented, sha256(entry.token))) return entry.name ?? "token";
  }
  return null;
}

/* -------------------------------------------------------------------------
 * Prometheus text exposition
 *
 * Format 0.0.4. Two rules here are easy to get wrong and matter:
 *   - No sample timestamps. A scraper silently drops samples whose timestamp
 *     is older than it likes, and a slow channel's samples usually are. The
 *     age is exposed as its own metric instead, which a panel can alert on.
 *   - A value that is not a finite number is omitted, never emitted. "NaN" is
 *     valid exposition syntax and poison in every dashboard built on it.
 * ---------------------------------------------------------------------- */

const STATUS_CODE = { ok: 0, warn: 1, fail: 2 };

/** Escape a label value per the exposition format. */
export function promEscape(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function labels(pairs) {
  const parts = Object.entries(pairs)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}="${promEscape(v)}"`);
  return parts.length ? `{${parts.join(",")}}` : "";
}

class Exposition {
  constructor() {
    this.lines = [];
    this.seen = new Set();
  }

  add(name, help, type, samples) {
    const emitted = samples.filter(([, value]) => Number.isFinite(value));
    if (!emitted.length) return;
    if (!this.seen.has(name)) {
      this.seen.add(name);
      this.lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    }
    for (const [pairs, value] of emitted) this.lines.push(`${name}${labels(pairs)} ${value}`);
  }

  render() {
    return `${this.lines.join("\n")}\n`;
  }
}

/**
 * The current state of everything, as gauges.
 *
 * `now` is injectable so the output is reproducible under test; ages are the
 * one place a clock enters the format.
 */
export function prometheusText({ checks = {}, backups = {}, host = null, apps = [] }, { now = Date.now() } = {}) {
  const out = new Exposition();

  const checkRows = Object.entries(checks);
  out.add(
    "servertools_check_status",
    "Check status: 0 ok, 1 warn, 2 fail",
    "gauge",
    checkRows.map(([name, c]) => [{ check: name, type: c.type }, STATUS_CODE[c.status] ?? 2]),
  );
  out.add(
    "servertools_check_value",
    "The numeric value a check recorded, when it records one (latency, percent, days)",
    "gauge",
    checkRows.map(([name, c]) => [{ check: name, unit: c.unit }, c.value]),
  );
  out.add(
    "servertools_check_age_seconds",
    "Seconds since the check last ran",
    "gauge",
    checkRows.map(([name, c]) => [{ check: name }, age(now, c.at)]),
  );

  const backupRows = Object.entries(backups);
  out.add(
    "servertools_backup_last_result",
    "Last backup outcome: 0 ok, 2 fail",
    "gauge",
    backupRows.map(([target, b]) => [{ target }, b.lastResult === "ok" ? 0 : 2]),
  );
  out.add(
    "servertools_backup_age_seconds",
    "Seconds since the last successful backup",
    "gauge",
    backupRows.map(([target, b]) => [{ target }, age(now, b.lastSuccess)]),
  );
  out.add(
    "servertools_backup_size_bytes",
    "Size of the last backup artifact",
    "gauge",
    backupRows.map(([target, b]) => [{ target }, b.lastSizeBytes]),
  );

  if (host) {
    out.add("servertools_host_memory_used_percent", "Host memory in use", "gauge", [[{}, host.mem?.usedPct]]);
    out.add("servertools_host_load1", "Host load average over one minute", "gauge", [[{}, host.load?.m1]]);
    out.add("servertools_host_cpu_percent", "Host CPU use since the previous sample", "gauge", [[{}, host.cpuPct]]);
    out.add("servertools_host_uptime_seconds", "Host uptime", "gauge", [[{}, host.uptimeSeconds]]);
    out.add(
      "servertools_host_disk_used_percent",
      "Disk space in use per checked path",
      "gauge",
      (host.disks ?? []).map((d) => [{ path: d.path }, d.usedPct]),
    );
  }

  // Application metrics: the latest snapshot's values. The application owns
  // the keys; this owns only the shape they are exported in. A breakdown
  // becomes one sample per category so a panel can stack them.
  for (const { app, snapshot } of apps) {
    if (!snapshot) continue;
    const scalars = [];
    const categories = [];
    for (const [key, metric] of Object.entries(snapshot.metrics ?? {})) {
      if (metric.kind === "breakdown") {
        for (const [category, v] of Object.entries(metric.value ?? {})) {
          categories.push([{ app, key, category }, v]);
        }
        scalars.push([{ app, key, kind: metric.kind }, numericValue(metric)]);
      } else {
        scalars.push([{ app, key, kind: metric.kind ?? "number" }, numericValue(metric)]);
      }
    }
    out.add("servertools_app_metric", "A value the named application published about itself", "gauge", scalars);
    out.add(
      "servertools_app_metric_category",
      "One category of a breakdown metric the application published",
      "gauge",
      categories,
    );
    out.add("servertools_app_metrics_age_seconds", "Seconds since this application's metrics were collected", "gauge", [
      [{ app }, age(now, snapshot.collectedAt)],
    ]);
  }

  return out.render();
}

function age(now, iso) {
  const t = Date.parse(iso ?? "");
  return Number.isFinite(t) ? Math.max(0, Math.round((now - t) / 1000)) : null;
}

/**
 * The columns of each series, in order. Declared rather than derived from the
 * first row, because an empty series still has a schema: a consumer pointed
 * at a fresh install infers its columns from the header, and a headerless
 * empty CSV breaks it at exactly the moment the operator is setting it up.
 */
export const COLUMNS = {
  checks: ["name", "type", "status", "value", "unit", "detail", "at"],
  "check-history": ["at", "name", "status", "value", "detail"],
  host: ["at", "cpuPct", "memPct", "load1"],
  events: ["at", "topic", "kind", "name", "detail"],
  backups: ["target", "lastResult", "lastSuccess", "sizeBytes", "offsite", "lastDrill", "lastDrillResult"],
  metrics: ["collectedAt", "key", "label", "kind", "category", "value"],
};

/* -------------------------------------------------------------------------
 * Row builders
 *
 * One shape per series, flat, with column order fixed so the CSV header and
 * the JSON keys always agree. Order inside a series is oldest first, the way
 * a charting tool expects to receive a time column.
 * ---------------------------------------------------------------------- */

export function checkRows(checks) {
  return Object.entries(checks)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, c]) => ({
      name,
      type: c.type ?? "",
      status: c.status ?? "",
      value: Number.isFinite(c.value) ? c.value : null,
      unit: c.unit ?? "",
      detail: c.detail ?? "",
      at: c.at ?? "",
    }));
}

export function historyRows(samples) {
  return samples.map((s) => ({
    at: s.ts ?? "",
    name: s.name ?? "",
    status: s.status ?? "",
    value: Number.isFinite(s.value) ? s.value : null,
    detail: s.detail ?? "",
  }));
}

export function hostRows(samples) {
  return samples.map((s) => ({
    at: s.ts ?? "",
    cpuPct: Number.isFinite(s.cpuPct) ? s.cpuPct : null,
    memPct: Number.isFinite(s.memPct) ? s.memPct : null,
    load1: Number.isFinite(s.load1) ? s.load1 : null,
  }));
}

export function eventRows(events) {
  return events.map((e) => ({
    at: e.ts ?? "",
    topic: e.topic ?? "",
    kind: e.kind ?? "",
    name: e.name ?? "",
    detail: e.detail ?? "",
  }));
}

export function backupRows(backups) {
  return Object.entries(backups)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([target, b]) => ({
      target,
      lastResult: b.lastResult ?? "",
      lastSuccess: b.lastSuccess ?? "",
      sizeBytes: Number.isFinite(b.lastSizeBytes) ? b.lastSizeBytes : null,
      offsite: b.offsite === true,
      lastDrill: b.lastDrill ?? "",
      lastDrillResult: b.lastDrillResult ?? "",
    }));
}

/**
 * Application metric snapshots as one row per value. A breakdown yields a row
 * per category with the `category` column filled; scalar metrics leave it
 * empty. SUM over the category rows reconstructs the total, which is exactly
 * the query a SQL consumer will write.
 */
export function metricRows(snapshots) {
  const rows = [];
  for (const snapshot of snapshots) {
    for (const [key, metric] of Object.entries(snapshot.metrics ?? {})) {
      if (metric.kind === "breakdown") {
        for (const [category, value] of Object.entries(metric.value ?? {})) {
          if (!Number.isFinite(value)) continue;
          rows.push({
            collectedAt: snapshot.collectedAt,
            key,
            label: metric.label ?? key,
            kind: "breakdown",
            category,
            value,
          });
        }
      } else {
        const value = numericValue(metric);
        if (value === null) continue;
        rows.push({
          collectedAt: snapshot.collectedAt,
          key,
          label: metric.label ?? key,
          kind: metric.kind ?? "number",
          category: "",
          value,
        });
      }
    }
    if (rows.length >= MAX_ROWS) break;
  }
  return rows.slice(0, MAX_ROWS);
}

/* -------------------------------------------------------------------------
 * CSV
 * ---------------------------------------------------------------------- */

/**
 * RFC 4180: quote a field when it holds a comma, quote, or newline; double
 * the quotes inside. Nothing else is transformed - these are data endpoints
 * read by machines, not downloads handed to a spreadsheet.
 */
export function csvField(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Rows (plain objects with identical keys) to a CSV document. */
export function toCsv(rows, columns) {
  const cols = columns ?? (rows.length ? Object.keys(rows[0]) : []);
  const lines = [cols.map(csvField).join(",")];
  for (const row of rows) lines.push(cols.map((c) => csvField(row[c])).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

/* -------------------------------------------------------------------------
 * The index
 * ---------------------------------------------------------------------- */

/**
 * What this namespace serves, as data. A person reads the docs; an agent
 * setting up a consumer can read this instead and skip the prose.
 */
export function endpointIndex({ apps = [] } = {}) {
  const series = (name, description, params = {}) => [
    { path: `/connect/${name}.json`, format: "json", description, params },
    { path: `/connect/${name}.csv`, format: "csv", description, params },
  ];
  return {
    description: "Read-only data endpoints for external dashboards. Authenticate with 'Authorization: Bearer <token>'.",
    docs: "docs/DASHBOARDS.md",
    maxRows: MAX_ROWS,
    endpoints: [
      {
        path: "/connect/prometheus",
        format: "prometheus-text-0.0.4",
        description: "Current state of checks, backups, host, and application metrics, as gauges.",
      },
      ...series("checks", "Latest state of every configured check."),
      ...series("check-history", "Check samples over time.", {
        check: "optional check name",
        days: `1..${MAX_DAYS}, default 7`,
      }),
      ...series("host", "Host cpu/memory/load samples (one per minute while the agent runs).", {
        days: `1..${MAX_DAYS}, default 7`,
      }),
      ...series("events", "Everything the toolkit did or noticed.", { days: `1..${MAX_DAYS}, default 7` }),
      ...series("backups", "Latest state of every backup target."),
      ...apps.flatMap((app) =>
        series(`metrics/${app}`, `Application metric snapshots for "${app}", one row per value.`, {
          days: `1..${MAX_DAYS}, default 90`,
        }),
      ),
    ],
  };
}

/** Parse and bound a days= query parameter. */
export function parseDays(raw, fallback) {
  if (raw === null || raw === undefined || raw === "") return fallback;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) return null;
  return days;
}
