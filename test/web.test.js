import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Store } from "../src/store.js";
import { startWebServer } from "../src/web/server.js";
import { createLoginToken } from "../src/web/auth.js";
import * as uiModule from "../src/web/ui.js";
import { backupsPage, coverageBanners, deploysPage, metricsPage, sparkline, meter, statusPill, timeChart } from "../src/web/ui.js";
import { compactTime, compactValue } from "../src/appmetrics/snapshot.js";

/**
 * Reach into the shipped browser script and run its functions here. Copying
 * them into the test would defeat the point: what needs checking is the code
 * that actually reaches the operator.
 */
function browserHelpers() {
  // The chart code is an IIFE, so its functions are not reachable from the end
  // of the script. Take its body and evaluate that instead, which keeps the
  // production script free of test hooks.
  const script = uiModule.BROWSER_SCRIPT;
  const start = script.indexOf("(function () {", script.indexOf("Pan and zoom for application metric charts"));
  assert.ok(start > 0, "the chart block moved; this harness needs updating");
  const body = script.slice(start + "(function () {".length, script.lastIndexOf("})();"));
  const fake = { addEventListener() {}, querySelectorAll: () => [], querySelector: () => null };
  return new Function(
    "document",
    `${body}
    return { compact: compact, stamp: stamp, draw: draw, clamp: clamp, readout: readout, zoomBy: zoomBy, W: W, H: H, PL: PL, PR: PR };`,
  )(fake);
}

/** Render one chart with the browser's draw() and return the SVG innards. */
function browserDraw(points, kind) {
  const { draw } = browserHelpers();
  let markup = "";
  const svg = {
    set innerHTML(v) {
      markup = v;
    },
    get innerHTML() {
      return markup;
    },
    setAttribute() {},
  };
  const el = { querySelector: () => svg };
  draw({ el, pts: points, lo: points[0][0], hi: points[points.length - 1][0], kind });
  return markup;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "st-web-"));
const store = new Store(dir);
store.ensureDirs();

const config = {
  dataDir: dir,
  checks: [
    { name: "demo-http", type: "http", url: "http://127.0.0.1:1/health" },
    { name: "demo-disk", type: "disk", path: "/" },
    { name: "demo-container", type: "container", container: "demo-app-1" },
  ],
  backups: [
    { name: "demo-db", type: "postgres", container: "db-1", user: "u", database: "d", passphrase: "x".repeat(16) },
  ],
  deploys: [{ name: "demo-app", dir: "/apps/demo", healthUrl: "http://127.0.0.1:1/health" }],
  appMetrics: [{ name: "demo-metrics", label: "Demo application", source: { file: "/nonexistent/metrics.json" } }],
  alerts: {},
  web: { enabled: true, port: 0, bind: "127.0.0.1", baseUrl: "http://127.0.0.1", allowedEmails: ["op@example.com"], sessionDays: 1 },
};

// Seed some state so pages render real content.
store.writeState("checks", {
  "demo-http": { status: "ok", detail: "HTTP 200 in 12ms", type: "http", at: new Date().toISOString(), value: 12 },
  "demo-disk": { status: "fail", detail: "95% used, 2 GiB free", type: "disk", at: new Date().toISOString(), value: 95 },
  "demo-container": { status: "fail", detail: "not running", type: "container", at: new Date().toISOString() },
});
store.writeState("backups", { "demo-db": { lastResult: "ok", lastSuccess: new Date().toISOString(), lastSizeBytes: 12345, lastDetail: "12 KiB, encrypted", offsite: false } });
store.append("checks", { name: "demo-http", status: "ok", value: 12, detail: "HTTP 200" });
store.append("checks", { name: "demo-http", status: "ok", value: 15, detail: "HTTP 200" });
store.append("events", { topic: "backup", kind: "ok", name: "demo-db", detail: "12 KiB, encrypted" });

let restarted = null;
const removedContainers = [];
const diskUsage = {
  LayersSize: 3_000_000,
  BuilderSize: 1_000_000,
  Images: [{ Id: "sha256:old", RepoTags: ["demo/app:v1"], Size: 3_000_000, Containers: 0, Created: 1_700_000_000 }],
  Containers: [
    {
      Id: "leftover",
      Names: ["/demo-migrate-run-1"],
      Image: "demo/app:v1",
      ImageID: "sha256:old",
      State: "exited",
      Status: "Exited (0) 6 days ago",
      SizeRw: 40_000,
      Created: 1_700_000_000,
      Labels: { "com.docker.compose.project": "demo", "com.docker.compose.service": "migrate" },
    },
  ],
  Volumes: [{ Name: "demo_db_data", UsageData: { Size: 9_000_000, RefCount: 1 }, Labels: { "com.docker.compose.project": "demo" } }],
  BuildCache: [{ ID: "bc", InUse: false, Shared: false, Size: 1_000_000 }],
};
const fakeDocker = {
  ping: async () => false,
  restart: async (name) => { restarted = name; },
  pruneImages: async () => 2_000_000,
  pruneBuildCache: async () => 1_000_000,
  logs: async () => "log line one\nlog line two\n",
  systemDf: async () => diskUsage,
  listContainers: async () => [],
  inspect: async (id) => ({
    Id: id,
    State: { FinishedAt: new Date(Date.now() - 6 * 86_400_000).toISOString() },
    HostConfig: { RestartPolicy: { Name: "no" }, LogConfig: { Type: "json-file", Config: {} } },
    LogPath: null,
  }),
  removeImage: async () => {},
  removeContainer: async (id) => { removedContainers.push(id); },
};
const server = await startWebServer({ config, store, docker: fakeDocker, alerter: null });
const base = `http://127.0.0.1:${server.address().port}`;

after(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function get(pathname, { cookie = "", redirect = "manual" } = {}) {
  return fetch(`${base}${pathname}`, { headers: cookie ? { cookie } : {}, redirect });
}

test("healthz is public", async () => {
  const res = await get("/healthz");
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, "ok");
});

test("pages and API require a session", async () => {
  for (const p of ["/", "/storage", "/checks", "/backups", "/deploys", "/events"]) {
    const res = await get(p);
    assert.equal(res.status, 303, p);
    assert.equal(res.headers.get("location"), "/login");
  }
  const api = await get("/api/status");
  assert.equal(api.status, 401);
});

test("login page renders and sets security headers", async () => {
  const res = await get("/login");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-security-policy"), /default-src 'none'/);
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  const html = await res.text();
  assert.match(html, /sign-in link/i);
});

test("magic link login flow end to end", async () => {
  const url = createLoginToken({ config, store, email: "op@example.com" });
  const token = new URL(url).searchParams.get("token");

  const res = await get(`/auth?token=${token}`);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/");
  const setCookie = res.headers.get("set-cookie");
  assert.match(setCookie, /st_session=/);
  const cookie = setCookie.split(";")[0];

  // Token is burned.
  const again = await get(`/auth?token=${token}`);
  assert.equal(again.status, 400);

  // Authenticated pages render.
  for (const [p, marker] of [
    ["/", "Overview"],
    ["/checks", "demo-http"],
    ["/backups", "demo-db"],
    ["/deploys", "demo-app"],
    ["/events", "backup"],
    ["/checks/demo-http", "History"],
  ]) {
    const page = await get(p, { cookie });
    assert.equal(page.status, 200, p);
    assert.match(await page.text(), new RegExp(marker), p);
  }

  // JSON status.
  const api = await get("/api/status", { cookie });
  assert.equal(api.status, 200);
  const body = await api.json();
  assert.equal(body.checks["demo-http"].status, "ok");
  assert.equal(body.dockerReachable, false);
  assert.ok(body.host.memUsedPct > 0);

  // Unknown check 404s; login POST rate limit eventually kicks in.
  assert.equal((await get("/checks/nope", { cookie })).status, 404);
});

test("failing checks render incident cards with actions; the action route works", async () => {
  const url = createLoginToken({ config, store, email: "op@example.com" });
  const res = await get(`/auth?token=${new URL(url).searchParams.get("token")}`);
  const cookie = res.headers.get("set-cookie").split(";")[0];

  // Overview shows an "Attention needed" section with a plain-language card.
  const overview = await (await get("/", { cookie })).text();
  assert.match(overview, /Attention needed/);
  assert.match(overview, /almost full/); // disk incident meaning
  assert.match(overview, /Reclaim unused Docker space/); // safe action button
  assert.match(overview, /is not running normally/); // container incident

  // Extract the CSRF token the page embedded.
  const csrf = overview.match(/name="csrf" value="([^"]+)"/)[1];

  // Action without a valid CSRF token is refused.
  const noCsrf = await fetch(`${base}/action`, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: "actionId=reclaim-docker-space&return=/&csrf=wrong",
    redirect: "manual",
  });
  assert.equal(noCsrf.status, 403);

  // Valid reclaim action runs and redirects back with a success flash.
  const reclaim = await fetch(`${base}/action`, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: `actionId=reclaim-docker-space&return=${encodeURIComponent("/")}&csrf=${encodeURIComponent(csrf)}`,
    redirect: "manual",
  });
  assert.equal(reclaim.status, 303);
  assert.match(decodeURIComponent(reclaim.headers.get("location")), /ok=1.*Reclaimed/);

  // Restart action validates the container against config, then calls docker.
  const restart = await fetch(`${base}/action`, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: `actionId=restart-container&container=demo-app-1&return=${encodeURIComponent("/checks/demo-container")}&csrf=${encodeURIComponent(csrf)}`,
    redirect: "manual",
  });
  assert.equal(restart.status, 303);
  assert.equal(restarted, "demo-app-1");

  // An unmanaged container is rejected (defense in depth, even with valid CSRF).
  restarted = null;
  const evil = await fetch(`${base}/action`, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: `actionId=restart-container&container=some-other-container&return=/&csrf=${encodeURIComponent(csrf)}`,
    redirect: "manual",
  });
  assert.equal(evil.status, 303);
  assert.match(decodeURIComponent(evil.headers.get("location")), /ok=0/);
  assert.equal(restarted, null);

  // Unauthenticated action POST is refused.
  const anon = await fetch(`${base}/action`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "actionId=reclaim-docker-space&csrf=x",
    redirect: "manual",
  });
  assert.equal(anon.status, 303);
  assert.equal(anon.headers.get("location"), "/login");

  // The check detail page shows the incident + a flash banner from a redirect.
  const detail = await (await get("/checks/demo-container?ok=1&msg=Restarted+demo-app-1", { cookie })).text();
  assert.match(detail, /is not running normally/);
  assert.match(detail, /Restarted demo-app-1/); // flash banner
});

test("backups page offers Back up now + Test restore buttons", async () => {
  const url = createLoginToken({ config, store, email: "op@example.com" });
  const res = await get(`/auth?token=${new URL(url).searchParams.get("token")}`);
  const cookie = res.headers.get("set-cookie").split(";")[0];
  const html = await (await get("/backups", { cookie })).text();

  assert.match(html, /Back up now/);
  assert.match(html, /value="run-backup"/);
  assert.match(html, /name="target" value="demo-db"/);
  // demo-db is a postgres target, so a restore-drill button is offered too.
  assert.match(html, /Test restore/);
  assert.match(html, /value="run-drill"/);
  // Every action form carries the session CSRF token.
  assert.match(html, /name="csrf" value="[A-Za-z0-9_-]+"/);
});

test("storage page explains usage, offers cleanups, and refuses to delete volumes", async () => {
  const url = createLoginToken({ config, store, email: "op@example.com" });
  const res = await get(`/auth?token=${new URL(url).searchParams.get("token")}`);
  const cookie = res.headers.get("set-cookie").split(";")[0];

  const html = await (await get("/storage", { cookie })).text();
  assert.match(html, /Where the space is going/);
  assert.match(html, /Container images/);
  assert.match(html, /Volumes \(your data\)/);
  assert.match(html, /demo_db_data/); // volumes are listed
  assert.match(html, /docker volume rm/); // ... but only as a manual instruction
  assert.match(html, /no volume is ever deleted/i);
  assert.match(html, /demo-migrate-run-1/); // the stale container is previewed
  assert.match(html, /demo\/app:v1/); // the unused image is previewed
  assert.match(html, /Clear unused build cache/);
  assert.ok(!/actionId="[^"]*volume/i.test(html), "no volume action is ever offered");

  // The disk tile on the overview links here.
  assert.match(await (await get("/", { cookie })).text(), /href="\/storage"/);

  // The machine-readable form carries the same numbers.
  const api = await (await get("/api/storage", { cookie })).json();
  assert.equal(api.dockerAvailable, true);
  assert.equal(api.summary.volumes.totalBytes, 9_000_000);
  assert.equal(api.staleContainers.length, 1);
  assert.ok(api.plan.every((a) => !/volume/i.test(a.id)));

  // Running a cleanup from the page removes exactly the previewed container.
  const csrf = html.match(/name="csrf" value="([^"]+)"/)[1];
  const run = await fetch(`${base}/action`, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: `actionId=remove-stopped-containers&return=${encodeURIComponent("/storage")}&csrf=${encodeURIComponent(csrf)}`,
    redirect: "manual",
  });
  assert.equal(run.status, 303);
  assert.match(decodeURIComponent(run.headers.get("location")).replace(/\+/g, " "), /ok=1.*Removed 1 stopped container.*No volume was touched/);
  assert.deepEqual(removedContainers, ["leftover"]);
});

test("confirmations survive the CSP: hashed script, no inline handlers", async () => {
  const url = createLoginToken({ config, store, email: "op@example.com" });
  const res = await get(`/auth?token=${new URL(url).searchParams.get("token")}`);
  const cookie = res.headers.get("set-cookie").split(";")[0];

  const page = await get("/storage", { cookie });
  const csp = page.headers.get("content-security-policy");
  const html = await page.text();

  // Inline event handlers are blocked by this policy, so none may be emitted:
  // a confirmation written as onsubmit= would silently never fire.
  assert.ok(!/\son[a-z]+\s*=/i.test(html), "no inline event handlers may be rendered");
  assert.ok(!/'unsafe-inline'[^;]*;?\s*(?=.*script-src)/.test(csp.split("script-src")[1] ?? ""), "script-src must not allow unsafe-inline");

  // The one script we do ship is allowed by its own hash, and that hash must
  // actually match the bytes in the page.
  assert.match(csp, /script-src 'sha256-[A-Za-z0-9+/=]+'/);
  const inline = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(inline, "the confirmation script is present");
  const digest = `'sha256-${createHash("sha256").update(inline[1]).digest("base64")}'`;
  assert.ok(csp.includes(digest), "the CSP hash must match the script actually served");

  // Destructive buttons carry their confirmation and a progress message.
  assert.match(html, /data-confirm="[^"]*Clear unused build cache/);
  assert.match(html, /data-working="[^"]*can take several minutes[^"]*recorded under Events/);
});

test("logout requires a valid CSRF token", async () => {
  const url = createLoginToken({ config, store, email: "op@example.com" });
  const res = await get(`/auth?token=${new URL(url).searchParams.get("token")}`);
  const cookie = res.headers.get("set-cookie").split(";")[0];
  // Wrong token: no logout (redirect home, session intact).
  const bad = await fetch(`${base}/logout`, { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: "csrf=nope", redirect: "manual" });
  assert.equal(bad.headers.get("location"), "/");
  assert.equal((await get("/", { cookie })).status, 200); // still logged in
});

test("logout clears the session", async () => {
  const url = createLoginToken({ config, store, email: "op@example.com" });
  const res = await get(`/auth?token=${new URL(url).searchParams.get("token")}`);
  const cookie = res.headers.get("set-cookie").split(";")[0];
  const csrf = (await (await get("/", { cookie })).text()).match(/name="csrf" value="([^"]+)"/)[1];

  const out = await fetch(`${base}/logout`, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: `csrf=${encodeURIComponent(csrf)}`,
    redirect: "manual",
  });
  assert.equal(out.status, 303);
  assert.equal(out.headers.get("location"), "/login");
  const after = await get("/", { cookie });
  assert.equal(after.status, 303); // back to login
});

test("login POST is uniform for allowed and unknown emails", async () => {
  for (const email of ["op@example.com", "stranger@example.com"]) {
    const res = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `email=${encodeURIComponent(email)}`,
    });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /on its way/);
  }
});

test("ui fragments render sanely", () => {
  assert.match(statusPill("ok"), /✓ ok/);
  assert.match(statusPill("fail"), /✕ fail/);
  assert.equal(sparkline([1]), ""); // too few points
  assert.match(sparkline([1, 5, 3, 8]), /<svg/);
  assert.match(sparkline([1, 5, 3, 8]), /<title>latest 8/);
  assert.match(meter(50), /width:50%/);
  assert.match(meter(96), /fail/);
  assert.match(meter(120), /width:100%/); // clamped
});

const uiSession = { email: "op@example.com", csrf: "tok" };

test("the backups page shows an external target as declared, not as failing", () => {
  const html = backupsPage({
    session: uiSession,
    backups: { "demo-db": { lastResult: "ok", lastSuccess: new Date().toISOString() } },
    targets: [
      { name: "demo-db", type: "postgres" },
      { name: "demo-media", type: "external", note: "Object storage bucket demo-media" },
    ],
    notes: [],
    csrf: "tok",
  });
  assert.match(html, /demo-media/);
  assert.match(html, /outside this toolkit/);
  assert.match(html, /Object storage bucket demo-media/);
  // No action buttons for something this toolkit does not copy.
  assert.doesNotMatch(html, /value="demo-media"/);
  // A database target still gets both buttons.
  assert.match(html, /name="target" value="demo-db"/);
});

test("a files target can be drilled from the dashboard and says where it reads from", () => {
  const html = backupsPage({
    session: uiSession,
    backups: {},
    targets: [{ name: "media", type: "files", source: { volume: "app_media" } }],
    notes: [],
    csrf: "tok",
  });
  assert.match(html, /files - volume app_media/);
  assert.match(html, /run-drill/);
});

test("a coverage gap is stated on the page, not left implied", () => {
  const html = backupsPage({
    session: uiSession,
    backups: {},
    targets: [{ name: "demo-db", type: "postgres" }],
    notes: [{ id: "media-not-declared", title: "Databases are backed up; media is not declared", detail: "..." }],
    csrf: "tok",
  });
  assert.match(html, /banner warn/);
  assert.match(html, /media is not declared/);
  assert.equal(coverageBanners([]), "");
});

test("the deploys page distinguishes a registry target from one that builds here", () => {
  const html = deploysPage({
    session: uiSession,
    deploys: {},
    targets: [
      { name: "app", dir: "/apps/app", project: "app", source: "registry", image: "ghcr.io/owner/app" },
      { name: "site", dir: "/apps/site" },
    ],
    events: [],
  });
  assert.match(html, /registry - ghcr.io\/owner\/app/);
  assert.match(html, /git - builds on this box/);
  assert.match(html, /project app/);
});

test("a deploy that succeeded with a caveat is not shown as a failure", () => {
  // The CLI exits 0 and the events feed shows amber; a red pill here would
  // contradict both.
  const html = deploysPage({
    session: uiSession,
    deploys: { app: { kind: "warn", at: new Date().toISOString(), from: "v1", to: "v2", detail: "healthy, but could not verify services" } },
    targets: [{ name: "app", dir: "/apps/app", project: "app", source: "registry", image: "ghcr.io/o/app" }],
    events: [{ topic: "deploy", kind: "warn", name: "app", detail: "could not verify services" }],
  });
  assert.match(html, /status warn/);
  assert.doesNotMatch(html, /status fail/);
});

const day = 86_400_000;
const seriesFixture = (n = 30) => {
  const base = Date.parse("2026-08-23T03:00:00Z");
  return Array.from({ length: n }, (_, i) => ({
    collectedAt: new Date(base - (n - 1 - i) * day).toISOString(),
    metrics: {
      records_total: { value: 100_000 + i * 400, label: "Records", kind: "count" },
      storage_used: { value: 8e9 + i * 1e7, label: "Storage used", kind: "bytes" },
    },
  }));
};

test("a metric chart ships its points so the browser can zoom without asking the server", () => {
  // There is no fetch to make under default-src 'none', so the data has to
  // arrive with the page or pan/zoom cannot work at all.
  const points = [[1, 10], [2, 20], [3, 15]];
  const html = timeChart(points, { kind: "count", label: "Records" });
  assert.match(html, /<figure class="chart" data-points=/);
  assert.match(html, /data-kind="count"/);
  assert.match(html, /<polyline class="line" points="/);
  assert.match(html, /class="reset" hidden/);
  // Points are numbers by construction, so the data attribute carries no
  // quotes to break out of. The label does come from the application, and it
  // goes through the same escaping as every other untrusted string.
  assert.deepEqual(JSON.parse(html.match(/data-points="([^"]+)"/)[1]), points);
  const hostile = timeChart(points, { kind: "count", label: '"><script>alert(1)</script>' });
  assert.doesNotMatch(hostile, /<script>/);
  assert.match(hostile, /&lt;script&gt;/);
});

test("a chart with too little data says so instead of drawing a lie", () => {
  assert.match(timeChart([], { kind: "count" }), /no samples yet/);
  assert.match(timeChart([[1, 5]], { kind: "count" }), /one sample so far/);
});

test("the metrics page shows values, read-time deltas, and history", () => {
  const html = metricsPage({
    session: uiSession,
    apps: [{ name: "demo", label: "Demo application" }],
    app: { name: "demo", label: "Demo application" },
    snapshots: seriesFixture(),
    windowId: "90d",
    state: { lastResult: "ok", lastDetail: "2 metrics" },
  });
  assert.match(html, /Demo application/);
  assert.match(html, /Records/);
  assert.match(html, /111,600/); // exact value, grouped
  assert.match(html, /GiB/); // bytes formatted by kind
  assert.match(html, /since the previous sample/);
  assert.match(html, /vs a week earlier/);
  assert.match(html, /window=1y/);
  assert.equal((html.match(/<figure class="chart"/g) ?? []).length, 2);
});

test("a metric an app stopped publishing keeps its history and says it is gone", () => {
  const snapshots = seriesFixture(3);
  snapshots[0].metrics.retired_metric = { value: 1, label: "Retired", kind: "count" };
  const html = metricsPage({
    session: uiSession,
    apps: [{ name: "demo" }],
    app: { name: "demo" },
    snapshots,
    windowId: "90d",
    state: {},
  });
  assert.match(html, /No longer published, history kept/);
  assert.match(html, /retired_metric/);
});

test("a label from the application cannot inject markup into the dashboard", () => {
  // The label is written by a separate application; it is untrusted input.
  const snapshots = [
    {
      collectedAt: new Date().toISOString(),
      metrics: { evil: { value: 1, label: '<img src=x onerror="alert(1)">', kind: "count" } },
    },
  ];
  const html = metricsPage({
    session: uiSession,
    apps: [{ name: "demo" }],
    app: { name: "demo" },
    snapshots,
    windowId: "90d",
    state: {},
  });
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
});

test("with nothing configured the metrics page points at the setting", () => {
  const html = metricsPage({ session: uiSession, apps: [], app: null, snapshots: [], windowId: "90d" });
  assert.match(html, /No application metrics are configured/);
  assert.match(html, /appMetrics/);
});

test("the metrics route renders and refuses an unknown application", async () => {
  const url = createLoginToken({ config, store, email: "op@example.com" });
  const res = await get(`/auth?token=${new URL(url).searchParams.get("token")}`);
  const cookie = res.headers.get("set-cookie").split(";")[0];

  const page = await get("/metrics", { cookie });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Demo application/);

  const named = await get("/metrics/demo-metrics?window=1y", { cookie });
  assert.equal(named.status, 200);

  assert.equal((await get("/metrics/not-a-thing", { cookie })).status, 404);

  // And the machine-readable snapshot carries collector state.
  const api = await (await get("/api/status", { cookie })).json();
  assert.ok("appMetrics" in api);
});

/* -------------------------------------------------------------------------
 * The browser half of the chart.
 *
 * It is duplicated on purpose - under default-src 'none' the page has no
 * request to make - so what matters is that it parses and that it agrees with
 * the server. Without these, the entire client half is unexercised: it lives
 * in a template literal, so a stray backtick corrupts it silently.
 * ---------------------------------------------------------------------- */

test("the script that ships to every operator parses", () => {
  const { BROWSER_SCRIPT } = uiModule;
  assert.doesNotThrow(() => new Function(BROWSER_SCRIPT));
  // A second script element would be blocked by the CSP, which allows exactly
  // one hash.
  assert.doesNotMatch(BROWSER_SCRIPT, /<script/i);
});

test("the axis formatters agree between the server and the browser", () => {
  // They cannot call each other, so the only thing keeping them honest is
  // this table. Negative bytes and durations are the case that diverged.
  const { compact, stamp } = browserHelpers();
  const values = [0, 1, -1, 999, 1024, -2048, 12345, -12345, 1.5e6, 2.3e9, 0.25, -0.25, 8.42e9, 90_000, 1e12];
  for (const kind of ["count", "bytes", "number", "percent", "duration"]) {
    for (const v of values) {
      assert.equal(compact(v, kind), compactValue(v, kind), `compact(${v}, ${kind})`);
    }
  }
  const t = Date.parse("2026-08-22T03:04:00Z");
  for (const span of [3600e3, 2 * 86400e3, 30 * 86400e3, 400 * 86400e3, 800 * 86400e3]) {
    assert.equal(stamp(t, span), compactTime(t, span), `stamp(span=${span})`);
  }
});

test("the server and the browser draw the same chart", () => {
  // The server draws the full range and the browser redraws it. If the
  // geometry disagrees the chart jumps the moment anyone touches it.
  const cases = {
    ramp: Array.from({ length: 40 }, (_, i) => [1_700_000_000_000 + i * 86_400_000, i * 3]),
    flat: Array.from({ length: 10 }, (_, i) => [1_700_000_000_000 + i * 86_400_000, 5]),
    zeroes: Array.from({ length: 10 }, (_, i) => [1_700_000_000_000 + i * 86_400_000, 0]),
    negative: Array.from({ length: 10 }, (_, i) => [1_700_000_000_000 + i * 86_400_000, -1024 * (i + 1)]),
    huge: Array.from({ length: 10 }, (_, i) => [1_700_000_000_000 + i * 86_400_000, 1e18 + i]),
  };
  for (const [name, points] of Object.entries(cases)) {
    for (const kind of ["count", "bytes", "duration"]) {
      const server = timeChart(points, { kind }).match(/<svg[^>]*>([\s\S]*)<\/svg>/)[1];
      const client = browserDraw(points, kind);
      assert.equal(client, server, `${name} / ${kind}`);
    }
  }
});

test("a wheel gesture without a modifier is left to the page", () => {
  // The page is a tall stack of cards and a chart covers most of each one, so
  // swallowing plain wheel events would turn scrolling into zoom.
  const { BROWSER_SCRIPT } = uiModule;
  assert.match(BROWSER_SCRIPT, /if \(!e\.ctrlKey && !e\.metaKey\) return;/);
  const wheelBlock = BROWSER_SCRIPT.slice(BROWSER_SCRIPT.indexOf('addEventListener("wheel"'));
  assert.ok(
    wheelBlock.indexOf("ctrlKey") < wheelBlock.indexOf("preventDefault"),
    "the modifier is checked before the page's scroll is cancelled",
  );
});

test("pinch to zoom is not disabled over a chart", async () => {
  // touch-action: pan-y on its own removes pinch-zoom, and the chart renders
  // small enough on a phone that pinching is how the labels get read.
  const source = await fs.promises.readFile(new URL("../src/web/ui.js", import.meta.url), "utf8");
  assert.match(source, /touch-action: pan-y pinch-zoom;/);
  assert.match(source, /@media \(max-width: 700px\)/);
});

test("a non-finite value draws nothing rather than a confident flat line", () => {
  // JSON turns Infinity into null and isFinite(null) is true, so the browser
  // would otherwise plot it at mid-scale.
  const points = [[1, 10], [2, Number.POSITIVE_INFINITY], [3, 20], [4, 30]];
  const html = timeChart(points, { kind: "count" });
  assert.doesNotMatch(html, /NaN/);
  const shipped = JSON.parse(html.match(/data-points="([^"]+)"/)[1]);
  assert.deepEqual(shipped, [[1, 10], [3, 20], [4, 30]]);
});

test("an application with no collection yet is not shown as healthy", () => {
  const html = metricsPage({
    session: uiSession,
    apps: [{ name: "demo" }],
    app: { name: "demo" },
    snapshots: [],
    windowId: "90d",
    state: {},
  });
  assert.match(html, /never collected/);
  assert.doesNotMatch(html, /status ok/);
});

test("charts shrink as the metric count grows, so page cost stays bounded", () => {
  // The metric count is set by the application, not the operator.
  const many = Array.from({ length: 120 }, (_, k) => `metric_${k}`);
  const snapshots = Array.from({ length: 900 }, (_, i) => ({
    collectedAt: new Date(1_700_000_000_000 + i * 3_600_000).toISOString(),
    metrics: Object.fromEntries(many.map((key) => [key, { value: i, kind: "count" }])),
  }));
  const html = metricsPage({
    session: uiSession,
    apps: [{ name: "demo" }],
    app: { name: "demo" },
    snapshots,
    windowId: "all",
    state: { lastResult: "ok" },
  });
  const sizes = [...html.matchAll(/data-points="([^"]+)"/g)].map((m) => JSON.parse(m[1]).length);
  assert.equal(sizes.length, 120);
  // 18000/120 = 150, well under the 300 a single chart would get. Asserting
  // against 300 would pass with the adaptive budget removed entirely.
  assert.ok(Math.max(...sizes) <= 150, `largest chart shipped ${Math.max(...sizes)} points`);
  assert.ok(html.length < 1_500_000, `page was ${html.length} bytes`);
});

test("an empty publish does not take the whole page down", () => {
  // The keys come from the newest snapshot that published something; reading
  // the metric from the newest snapshot instead throws, and the route turns
  // that into a 500 for every window, for as long as the app keeps sending {}.
  const snapshots = [
    { collectedAt: "2026-08-01T00:00:00Z", metrics: { rows: { value: 5, kind: "count" } } },
    { collectedAt: "2026-08-02T00:00:00Z", metrics: { rows: { value: 9, kind: "count" } } },
    { collectedAt: "2026-08-03T00:00:00Z", metrics: {} },
  ];
  const html = metricsPage({
    session: uiSession,
    apps: [{ name: "demo" }],
    app: { name: "demo" },
    snapshots,
    windowId: "90d",
    state: { lastResult: "ok" },
  });
  assert.match(html, /Rows|rows/);
  assert.doesNotMatch(html, /No longer published/);
});

test("a breakdown's delta is a number, not a breakdown", () => {
  const snapshots = [
    { collectedAt: "2026-08-01T00:00:00Z", metrics: { tiers: { value: { a: 2, b: 3 }, kind: "breakdown" } } },
    { collectedAt: "2026-08-02T00:00:00Z", metrics: { tiers: { value: { a: 4, b: 6 }, kind: "breakdown" } } },
  ];
  const html = metricsPage({
    session: uiSession,
    apps: [{ name: "demo" }],
    app: { name: "demo" },
    snapshots,
    windowId: "90d",
    state: {},
  });
  assert.match(html, /\+5/, "the change in the total");
  assert.doesNotMatch(html, /\+-|--<\/span>/);
});

test("the truncation notice appears only when the read was truncated", () => {
  const page = (count) =>
    metricsPage({
      session: uiSession,
      apps: [{ name: "demo" }],
      app: { name: "demo" },
      snapshots: Array.from({ length: count }, (_, i) => ({
        collectedAt: new Date(1_700_000_000_000 + i * 3_600_000).toISOString(),
        metrics: { a: { value: i, kind: "count" } },
      })),
      windowId: "all",
      state: {},
    });
  assert.doesNotMatch(page(50), /most recent/);
  assert.match(page(uiModule.PAGE_SNAPSHOTS), /most recent/);
});

test("the browser drops a non-finite point rather than plotting it", () => {
  // JSON writes Infinity as null and isFinite(null) is true, so without the
  // guard the browser draws a confident flat line at mid-scale.
  const { draw } = browserHelpers();
  let markup = "";
  const svg = { set innerHTML(v) { markup = v; }, get innerHTML() { return markup; }, setAttribute() {} };
  draw({ el: { querySelector: () => svg }, pts: [[1, 10], [2, null], [3, 20]], lo: 1, hi: 3, kind: "count" });
  const points = markup.match(/<polyline class="line" points="([^"]+)"/)[1].split(" ");
  assert.equal(points.length, 2, "the null point is not plotted");
});

test("the readout follows the plot area, not the whole svg box", () => {
  // The time axis spans PL..W-PR, so using the box width slides the grabbed
  // sample out from under the pointer on a long drag.
  const { BROWSER_SCRIPT } = uiModule;
  assert.match(BROWSER_SCRIPT, /function plotFraction\(el, clientX\)/);
  assert.match(BROWSER_SCRIPT, /\(px - PL\) \/ \(W - PL - PR\)/);
  // Both the drag and the wheel go through it rather than doing their own maths.
  assert.equal((BROWSER_SCRIPT.match(/plotFraction\(/g) ?? []).length >= 4, true);
});

test("zooming is reachable without a wheel or a modifier key", () => {
  // A phone has neither, and the browser owns the pinch.
  const html = timeChart([[1, 10], [2, 20], [3, 15]], { kind: "count" });
  assert.match(html, /class="zoom-in"/);
  assert.match(html, /class="zoom-out"/);
  assert.match(html, /aria-label="Zoom in"/);
  assert.match(uiModule.BROWSER_SCRIPT, /function zoomBy\(fig, factor\)/);
});

test("zooming stops a few samples short of empty, not at a fraction of the range", () => {
  // Tying the floor to the range means the last several notches land on a
  // blank chart for any long series.
  const { clamp } = browserHelpers();
  const hour = 3_600_000;
  const pts = Array.from({ length: 500 }, (_, i) => [1_700_000_000_000 + i * hour, i]);
  const fig = {
    el: { querySelector: () => null },
    pts,
    gap: hour,
    lo: pts[10][0],
    hi: pts[10][0] + 1000, // absurdly deep zoom
  };
  clamp(fig);
  assert.ok(fig.hi - fig.lo >= hour * 3, `floor was ${(fig.hi - fig.lo) / hour} hours`);
});

test("the readout does not describe the viewport before last", () => {
  const { draw, readout } = browserHelpers();
  let markup = "";
  let text = "";
  const svg = {
    set innerHTML(v) { markup = v; },
    get innerHTML() { return markup; },
    setAttribute() {},
    getBoundingClientRect: () => ({ left: 0, width: 720 }),
  };
  const out = { set textContent(v) { text = v; }, get textContent() { return text; } };
  const el = { querySelector: (sel) => (sel === ".readout" ? out : svg) };
  const pts = [[1_700_000_000_000, 50], [1_700_003_600_000, 60]];

  // One figure, panned: the stale state only exists because the same object
  // is redrawn, so a fresh one would never reach the bug.
  const fig = { el, pts, lo: pts[0][0], hi: pts[1][0], kind: "count" };
  draw(fig);
  readout(fig, 700);
  assert.match(text, /50|60/);

  text = "";
  fig.lo = pts[1][0] + 10_000_000;
  fig.hi = pts[1][0] + 20_000_000;
  draw(fig);
  assert.match(markup, /no samples in this range/);
  readout(fig, 700);
  assert.equal(text, "", "the previous viewport's reading must not persist");
});

test("the file reader measures what arrived, not what stat claimed", async () => {
  // Some regular files report size 0 and still have content. Trusting the
  // stat would read them as empty, and it is also the size a file can change
  // between the check and the read.
  const { fetchDocument } = await import("../src/appmetrics/collect.js");
  assert.equal(fs.statSync("/proc/self/status").size, 0);
  const text = await fetchDocument({ name: "a", source: { file: "/proc/self/status" } });
  assert.ok(text.length > 0, "content was read despite a zero stat size");
  assert.match(text, /^Name:/);
});

test("the zoom buttons zoom the right way and stop at the floor", () => {
  // Asserting the markup contains a button says nothing about what it does.
  const { zoomBy } = browserHelpers();
  const hour = 3_600_000;
  const pts = Array.from({ length: 400 }, (_, i) => [1_700_000_000_000 + i * hour, i]);
  const fig = { el: { querySelector: () => null }, pts, gap: hour, lo: pts[0][0], hi: pts[pts.length - 1][0] };
  const full = fig.hi - fig.lo;

  // The shipped zoomBy, not a copy of it: a copy proves nothing about which
  // way the buttons are wired.
  zoomBy(fig, 0.5);
  assert.ok(fig.hi - fig.lo < full, "zoom in narrows the window");
  const narrowed = fig.hi - fig.lo;
  zoomBy(fig, 2);
  assert.ok(fig.hi - fig.lo > narrowed, "zoom out widens it again");

  for (let i = 0; i < 40; i++) zoomBy(fig, 0.5);
  assert.ok(fig.hi - fig.lo >= hour * 3, "zooming in stops short of an empty chart");
  for (let i = 0; i < 40; i++) zoomBy(fig, 2);
  assert.equal(fig.hi - fig.lo, full, "zooming out cannot escape the data");
});

test("a press on a chart control does not start a pan", () => {
  // Capturing the pointer on the figure retargets the click away from the
  // button, so the control can pan the chart and never fire at all.
  const { BROWSER_SCRIPT } = uiModule;
  assert.match(BROWSER_SCRIPT, /if \(e\.target\.closest\("button"\)\) return;/);
  assert.doesNotMatch(BROWSER_SCRIPT, /closest\("\.reset"\)/);
});

test("frozen numbers under a fresh timestamp are called out, not shown as healthy", () => {
  // An endpoint that keeps answering 200 with an empty metrics object would
  // otherwise leave the last real values on the page forever, in green, under
  // a collection time from a minute ago.
  const day = 86_400_000;
  const snapshots = [
    { collectedAt: new Date(Date.now() - 9 * day).toISOString(), metrics: { rows: { value: 500, label: "Rows", kind: "count" } } },
    { collectedAt: new Date(Date.now() - 60_000).toISOString(), metrics: {} },
  ];
  const html = metricsPage({
    session: uiSession,
    apps: [{ name: "demo" }],
    app: { name: "demo" },
    snapshots,
    windowId: "90d",
    state: { lastResult: "ok" },
  });
  assert.match(html, /last publish was empty/);
  assert.match(html, /values are from 9d ago/);
  assert.match(html, /status warn/);
  assert.doesNotMatch(html, /status ok/);
});

/**
 * Run the shipped chart script against a stub DOM and hand back the figure's
 * live state plus a way to click its controls. This is the only way to test
 * the wiring rather than the helpers: which handler is attached to which
 * button is exactly where a chart silently does the wrong thing.
 */
function mountChart(points, kind = "count") {
  const listeners = new Map();
  const buttons = {};
  const svg = {
    innerHTML: "",
    setAttribute() {},
    getBoundingClientRect: () => ({ left: 0, width: 720 }),
  };
  const makeButton = (name) => {
    const el = {
      hidden: false,
      disabled: false,
      addEventListener(type, fn) {
        if (type === "click") this._click = fn;
      },
      click() {
        this._click?.({ target: this });
      },
      closest: () => el,
    };
    buttons[name] = el;
    return el;
  };
  const figure = {
    getAttribute: (name) =>
      name === "data-points" ? JSON.stringify(points) : name === "data-kind" ? kind : null,
    addEventListener(type, fn) {
      listeners.set(type, fn);
    },
    querySelector(sel) {
      if (sel === "svg") return svg;
      if (sel === ".zoom-in") return buttons["zoom-in"] ?? makeButton("zoom-in");
      if (sel === ".zoom-out") return buttons["zoom-out"] ?? makeButton("zoom-out");
      if (sel === ".reset") return buttons.reset ?? makeButton("reset");
      if (sel === ".readout") return { textContent: "" };
      return null;
    },
    setPointerCapture() {},
    releasePointerCapture() {},
    hasPointerCapture: () => false,
  };
  const document = { addEventListener() {}, querySelectorAll: () => [figure] };
  new Function("document", uiModule.BROWSER_SCRIPT)(document);
  // The window the chart currently shows, read back off the rendered axis.
  const span = () => {
    const labels = [...svg.innerHTML.matchAll(/class="xlab"[^>]*>([^<]+)</g)].map((m) => m[1]);
    return labels.length;
  };
  return { buttons, listeners, svg, span };
}

test("the zoom buttons are wired the right way round", () => {
  const hour = 3_600_000;
  const points = Array.from({ length: 400 }, (_, i) => [1_700_000_000_000 + i * hour, i]);
  const chart = mountChart(points);
  const plotted = () => (chart.svg.innerHTML.match(/<polyline class="line" points="([^"]+)"/)?.[1] ?? "").split(" ").length;

  const whole = plotted();
  chart.buttons["zoom-in"].click();
  const narrowed = plotted();
  assert.ok(narrowed < whole, `zoom in should show fewer samples (${narrowed} vs ${whole})`);

  chart.buttons["zoom-out"].click();
  assert.ok(plotted() > narrowed, "zoom out should show more again");

  chart.buttons["zoom-in"].click();
  chart.buttons.reset.click();
  assert.equal(plotted(), whole, "reset returns the whole range");
});

test("a press on a control does not pan the chart", () => {
  const hour = 3_600_000;
  const points = Array.from({ length: 100 }, (_, i) => [1_700_000_000_000 + i * hour, i]);
  const chart = mountChart(points);
  chart.buttons["zoom-in"].click();
  const afterZoom = chart.svg.innerHTML;

  // pointerdown on a button, then a move: with the guard missing this drags.
  chart.listeners.get("pointerdown")({ target: chart.buttons["zoom-in"], clientX: 100, pointerId: 1 });
  chart.listeners.get("pointermove")({ clientX: 400, pointerId: 1 });
  assert.equal(chart.svg.innerHTML, afterZoom, "the chart did not move");
});
