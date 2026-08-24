/**
 * Data connectors: the read-only endpoints external dashboards consume.
 * The two things that matter most are that a wrong token never gets in and
 * that a right one never leaks out.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { startWebServer } from "../src/web/server.js";
import { createLoginToken } from "../src/web/auth.js";
import {
  COLUMNS,
  MAX_DAYS,
  MAX_ROWS,
  authorize,
  backupRows,
  checkRows,
  csvField,
  endpointIndex,
  eventRows,
  historyRows,
  hostRows,
  metricRows,
  parseDays,
  prometheusText,
  promEscape,
  toCsv,
} from "../src/web/connect.js";

/* ------------------------------------------------------------------- auth */

const TOKENS = [
  { name: "charting", token: "a-charting-token-long-enough" },
  { name: "reports", token: "a-reports-token-long-enough" },
];

test("a token authorizes as its name; anything else does not", () => {
  assert.equal(authorize(TOKENS, "Bearer a-charting-token-long-enough"), "charting");
  assert.equal(authorize(TOKENS, "bearer a-reports-token-long-enough"), "reports");
  assert.equal(authorize(TOKENS, "Bearer wrong-token-entirely-here"), null);
  assert.equal(authorize(TOKENS, "Basic a-charting-token-long-enough"), null);
  assert.equal(authorize(TOKENS, ""), null);
  assert.equal(authorize(TOKENS, undefined), null);
});

test("no tokens configured means nothing authorizes, including nothing", () => {
  // Interpolation resolves a missing env var to "", so an empty configured
  // token matched by an empty Bearer would be an open endpoint that looks
  // configured. Config validation refuses the empty token; this is the
  // second lock on the same door.
  assert.equal(authorize([], "Bearer anything-at-all-here"), null);
  assert.equal(authorize(undefined, "Bearer anything-at-all-here"), null);
  assert.equal(authorize([{ name: "broken", token: "" }], "Bearer "), null);
  assert.equal(authorize([{ name: "broken", token: "" }], "Bearer x"), null);
});

/* ------------------------------------------------------------- prometheus */

test("current state renders as gauges with escaped labels and no timestamps", () => {
  const text = prometheusText(
    {
      checks: {
        "app-http": { status: "ok", type: "http", value: 12, unit: "ms", at: "2026-08-24T00:00:00Z" },
        'we"ird\nname': { status: "fail", type: "tcp", at: "2026-08-24T00:00:00Z" },
      },
      backups: { "app-db": { lastResult: "ok", lastSuccess: "2026-08-23T23:00:00Z", lastSizeBytes: 12345 } },
      host: { mem: { usedPct: 43.2 }, load: { m1: 0.5 }, cpuPct: 10, uptimeSeconds: 999, disks: [{ path: "/host", usedPct: 61 }] },
      apps: [],
    },
    { now: Date.parse("2026-08-24T00:10:00Z") },
  );
  assert.match(text, /# TYPE servertools_check_status gauge/);
  assert.match(text, /servertools_check_status\{check="app-http",type="http"\} 0/);
  assert.match(text, /servertools_check_value\{check="app-http",unit="ms"\} 12/);
  assert.match(text, /servertools_check_status\{check="we\\"ird\\nname",type="tcp"\} 2/);
  assert.match(text, /servertools_check_age_seconds\{check="app-http"\} 600/);
  assert.match(text, /servertools_backup_age_seconds\{target="app-db"\} 4200/);
  assert.match(text, /servertools_backup_size_bytes\{target="app-db"\} 12345/);
  assert.match(text, /servertools_host_memory_used_percent 43.2/);
  assert.match(text, /servertools_host_disk_used_percent\{path="\/host"\} 61/);
  // No sample timestamps anywhere: a scraper silently drops samples whose
  // timestamp it considers stale, and a slow channel's samples usually are.
  for (const line of text.split("\n")) {
    if (line.startsWith("#") || !line.trim()) continue;
    assert.match(line, /^\S+ -?[\d.e+]+$/, line);
  }
});

test("a value that is not a finite number is omitted, never emitted", () => {
  // "NaN" is valid exposition syntax and poison in every dashboard built on
  // it. A check without a numeric value simply has no value sample.
  const text = prometheusText({
    checks: { "no-value": { status: "warn", type: "container", at: "x" } },
    backups: { never: { lastResult: "fail" } },
    host: { cpuPct: null, mem: {}, load: {}, disks: [] },
    apps: [],
  });
  assert.doesNotMatch(text, /NaN/);
  assert.doesNotMatch(text, /servertools_check_value/);
  assert.doesNotMatch(text, /servertools_backup_age_seconds/);
  assert.doesNotMatch(text, /servertools_host_cpu_percent/);
  assert.match(text, /servertools_check_status\{check="no-value",type="container"\} 1/);
  assert.match(text, /servertools_backup_last_result\{target="never"\} 2/);
});

test("application metrics export by app and key, breakdowns by category", () => {
  const snapshot = {
    collectedAt: "2026-08-24T00:00:00Z",
    metrics: {
      records_total: { value: 128394, kind: "count" },
      tiers: { value: { free: 812, pro: 44 }, kind: "breakdown" },
    },
  };
  const text = prometheusText(
    { checks: {}, backups: {}, host: null, apps: [{ app: "myapp", snapshot }] },
    { now: Date.parse("2026-08-24T00:05:00Z") },
  );
  assert.match(text, /servertools_app_metric\{app="myapp",key="records_total",kind="count"\} 128394/);
  assert.match(text, /servertools_app_metric\{app="myapp",key="tiers",kind="breakdown"\} 856/);
  assert.match(text, /servertools_app_metric_category\{app="myapp",key="tiers",category="free"\} 812/);
  assert.match(text, /servertools_app_metrics_age_seconds\{app="myapp"\} 300/);
  // An app never collected exports nothing rather than zeros it never said.
  const empty = prometheusText({ checks: {}, backups: {}, host: null, apps: [{ app: "other", snapshot: null }] });
  assert.doesNotMatch(empty, /other/);
});

test("promEscape survives the characters the format cares about", () => {
  assert.equal(promEscape('a"b\\c\nd'), 'a\\"b\\\\c\\nd');
  assert.equal(promEscape("plain"), "plain");
});

/* --------------------------------------------------------------- csv/json */

test("csv fields are quoted per RFC 4180 and only when needed", () => {
  assert.equal(csvField("plain"), "plain");
  assert.equal(csvField('with "quotes"'), '"with ""quotes"""');
  assert.equal(csvField("a,b"), '"a,b"');
  assert.equal(csvField("line\nbreak"), '"line\nbreak"');
  assert.equal(csvField(null), "");
  assert.equal(csvField(12.5), "12.5");
});

test("rows become a csv whose header always matches the json keys", () => {
  const rows = checkRows({ b: { status: "ok", type: "http", value: 5, unit: "ms", detail: "d", at: "t" }, a: { status: "fail", type: "tcp" } });
  assert.deepEqual(rows.map((r) => r.name), ["a", "b"], "sorted for stable output");
  const csv = toCsv(rows);
  const [header, first] = csv.split("\r\n");
  assert.equal(header, Object.keys(rows[0]).join(","));
  assert.match(first, /^a,tcp,fail/);
  assert.equal(toCsv([]), "\r\n", "no rows still yields a document");
});

test("metric snapshots flatten to one row per value, categories included", () => {
  const rows = metricRows([
    {
      collectedAt: "2026-08-24T00:00:00Z",
      metrics: {
        records: { value: 100, label: "Records", kind: "count" },
        tiers: { value: { free: 8, pro: 2 }, kind: "breakdown" },
      },
    },
  ]);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { collectedAt: "2026-08-24T00:00:00Z", key: "records", label: "Records", kind: "count", category: "", value: 100 });
  const categories = rows.filter((r) => r.category);
  assert.deepEqual(categories.map((r) => [r.category, r.value]), [["free", 8], ["pro", 2]]);
  // SUM over categories reconstructs the total: that is the SQL a consumer
  // will write, so the total is not duplicated as a fourth row.
  assert.equal(categories.reduce((s, r) => s + r.value, 0), 10);
});

test("row output is capped however large the input", () => {
  const snapshots = Array.from({ length: MAX_ROWS + 500 }, (_, i) => ({
    collectedAt: new Date(1_700_000_000_000 + i * 1000).toISOString(),
    metrics: { a: { value: i, kind: "count" } },
  }));
  assert.equal(metricRows(snapshots).length, MAX_ROWS);
});

test("event and backup rows carry their columns in a fixed order", () => {
  const [e] = eventRows([{ ts: "t", topic: "backup", kind: "ok", name: "db", detail: "fine" }]);
  assert.deepEqual(Object.keys(e), ["at", "topic", "kind", "name", "detail"]);
  const [b] = backupRows({ db: { lastResult: "ok", lastSuccess: "t", lastSizeBytes: 5, offsite: true } });
  assert.deepEqual(Object.keys(b), ["target", "lastResult", "lastSuccess", "sizeBytes", "offsite", "lastDrill", "lastDrillResult"]);
});

test("days parameters are bounded and reject nonsense", () => {
  assert.equal(parseDays(null, 7), 7);
  assert.equal(parseDays("", 7), 7);
  assert.equal(parseDays("30", 7), 30);
  assert.equal(parseDays("0", 7), null);
  assert.equal(parseDays(String(MAX_DAYS + 1), 7), null);
  assert.equal(parseDays("soon", 7), null);
  assert.equal(parseDays("1.5", 7), null);
});

test("the index names every endpoint an agent would need", () => {
  const index = endpointIndex({ apps: ["myapp"] });
  const paths = index.endpoints.map((e) => e.path);
  assert.ok(paths.includes("/connect/prometheus"));
  assert.ok(paths.includes("/connect/checks.csv"));
  assert.ok(paths.includes("/connect/metrics/myapp.json"));
  assert.match(index.description, /Authorization: Bearer/);
});

/* -------------------------------------------------- through the real server */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "st-connect-"));
const store = new Store(dir);
store.ensureDirs();
const config = {
  dataDir: dir,
  checks: [{ name: "demo-http", type: "http", url: "http://127.0.0.1:1/h" }],
  backups: [],
  deploys: [],
  appMetrics: [{ name: "demo-app", source: { file: "/nonexistent" } }],
  connect: { tokens: [{ name: "charting", token: "a-live-test-token-long-enough" }] },
  alerts: {},
  web: { enabled: true, port: 0, bind: "127.0.0.1", baseUrl: "http://127.0.0.1", allowedEmails: ["op@example.com"], sessionDays: 1 },
};
store.writeState("checks", { "demo-http": { status: "ok", detail: "HTTP 200", type: "http", at: new Date().toISOString(), value: 9, unit: "ms" } });
store.appendSnapshot("demo-app", { collectedAt: new Date().toISOString(), metrics: { rows: { value: 42, kind: "count" } } });
const server = await startWebServer({ config, store, docker: { ping: async () => false }, alerter: null });
const base = `http://127.0.0.1:${server.address().port}`;

after(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const hit = (p, headers = {}, opts = {}) => fetch(`${base}${p}`, { headers, redirect: "manual", ...opts });

test("every connect endpoint refuses an unauthenticated request", async () => {
  for (const p of ["/connect", "/connect/prometheus", "/connect/checks.json", "/connect/metrics/demo-app.csv"]) {
    const res = await hit(p);
    assert.equal(res.status, 401, p);
    assert.equal(res.headers.get("www-authenticate"), "Bearer", p);
    const body = await res.json();
    assert.doesNotMatch(JSON.stringify(body), /a-live-test-token/, "no token material in the refusal");
  }
  // A wrong token is exactly as refused as no token.
  assert.equal((await hit("/connect/checks.json", { authorization: "Bearer wrong-token-here-long" })).status, 401);
});

test("a bearer token reads data; a session works too; writes never do", async () => {
  const auth = { authorization: "Bearer a-live-test-token-long-enough" };
  const checks = await hit("/connect/checks.json", auth);
  assert.equal(checks.status, 200);
  const rows = await checks.json();
  assert.equal(rows[0].name, "demo-http");

  const prom = await hit("/connect/prometheus", auth);
  assert.equal(prom.status, 200);
  assert.match(prom.headers.get("content-type"), /version=0\.0\.4/);
  const text = await prom.text();
  assert.match(text, /servertools_check_status\{check="demo-http",type="http"\} 0/);
  assert.match(text, /servertools_app_metric\{app="demo-app",key="rows",kind="count"\} 42/);

  const csv = await hit("/connect/metrics/demo-app.csv", auth);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get("content-type"), /text\/csv/);
  const csvText = await csv.text();
  assert.match(csvText, /^collectedAt,key,label,kind,category,value\r\n/);
  // The header alone is what an empty read produces, so the data row is the
  // assertion that matters.
  assert.match(csvText, /,rows,rows,count,,42\r\n/);

  const history = await hit("/connect/check-history.json?check=demo-http", auth);
  assert.equal(history.status, 200);

  // A signed-in browser can eyeball the same endpoints.
  const link = createLoginToken({ config, store, email: "op@example.com" });
  const authed = await hit(`/auth?token=${new URL(link).searchParams.get("token")}`);
  const cookie = authed.headers.get("set-cookie").split(";")[0];
  assert.equal((await hit("/connect", { cookie })).status, 200);

  // Read-only means read-only, whoever asks.
  assert.equal((await hit("/connect/checks.json", auth, { method: "POST" })).status, 405);
  assert.equal((await hit("/connect/checks.json", auth, { method: "DELETE" })).status, 405);
});

test("bad parameters and unknown series answer clearly", async () => {
  const auth = { authorization: "Bearer a-live-test-token-long-enough" };
  assert.equal((await hit("/connect/events.json?days=0", auth)).status, 400);
  assert.equal((await hit("/connect/events.json?days=999999", auth)).status, 400);
  assert.equal((await hit("/connect/nonsense.json", auth)).status, 404);
  assert.equal((await hit("/connect/metrics/not-an-app.json", auth)).status, 404);
  // The index names what exists, so a consumer can discover rather than guess.
  const index = await (await hit("/connect", auth)).json();
  assert.ok(index.endpoints.some((e) => e.path === "/connect/metrics/demo-app.json"));
});

test("an empty series still carries its header, because a schema is not data", () => {
  // A consumer pointed at a fresh install infers its columns from the
  // header; a headerless empty CSV breaks it at exactly the moment the
  // operator is setting it up.
  const csv = toCsv([], COLUMNS.checks);
  assert.equal(csv, "name,type,status,value,unit,detail,at\r\n");
  for (const columns of Object.values(COLUMNS)) {
    assert.ok(toCsv([], columns).length > 2, "every series has a declared schema");
  }
});

test("one oversized snapshot cannot exceed the row cap", () => {
  // The per-snapshot break only fires between snapshots, so a single
  // snapshot larger than the cap is what the final slice exists for.
  const value = Object.fromEntries(Array.from({ length: MAX_ROWS + 100 }, (_, i) => [`c${i}`, i]));
  const rows = metricRows([{ collectedAt: "2026-08-24T00:00:00Z", metrics: { big: { value, kind: "breakdown" } } }]);
  assert.equal(rows.length, MAX_ROWS);
});

test("host and history rows keep their shape and drop nothing silently", () => {
  const [h] = hostRows([{ ts: "t", cpuPct: 12, memPct: 40, load1: 0.5 }]);
  assert.deepEqual(h, { at: "t", cpuPct: 12, memPct: 40, load1: 0.5 });
  const [gap] = hostRows([{ ts: "t", cpuPct: null }]);
  assert.equal(gap.cpuPct, null, "a missing sample is null, not zero");
  const [row] = historyRows([{ ts: "t", name: "demo", status: "ok", value: 9, detail: "d" }]);
  assert.deepEqual(row, { at: "t", name: "demo", status: "ok", value: 9, detail: "d" });
});

test("a fresh series over the wire is an empty table, not an empty file", async () => {
  const auth = { authorization: "Bearer a-live-test-token-long-enough" };
  const res = await hit("/connect/host.csv", auth);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "at,cpuPct,memPct,load1\r\n");
  const json = await (await hit("/connect/host.json", auth)).json();
  assert.deepEqual(json, []);
});
