import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Store } from "../src/store.js";
import { startWebServer } from "../src/web/server.js";
import { createLoginToken } from "../src/web/auth.js";
import { backupsPage, coverageBanners, deploysPage, metricsPage, sparkline, meter, statusPill, timeChart } from "../src/web/ui.js";

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
