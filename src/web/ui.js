/**
 * Server-rendered dashboard UI. Plain HTML + inline CSS/SVG, no external
 * assets (strict CSP friendly), light and dark from one palette. Charts
 * follow fixed mark specs: 2px lines, >=8px end markers with a surface ring,
 * ~10% area washes, hairline grid, status always icon + label (never color
 * alone).
 */
import crypto from "node:crypto";
import { escapeHtml as esc, formatBytes, formatDuration } from "../util.js";

/**
 * The only script the dashboard ships. It confirms destructive actions and,
 * once one is running, says so: several cleanups take minutes, and a form POST
 * gives no feedback of its own.
 *
 * It lives in one static block on purpose. Inline event handlers (onsubmit=...)
 * are blocked by our CSP, and rather than weaken the policy to 'unsafe-inline'
 * we allow exactly this text by hash. Change the text and the hash changes with
 * it, so a tampered or injected script still cannot run.
 */
const SCRIPT = `
document.addEventListener("submit", function (e) {
  var form = e.target;
  var message = form.getAttribute("data-confirm");
  if (!message) return;
  if (form.getAttribute("data-busy") === "1") { e.preventDefault(); return; }
  if (!window.confirm(message)) { e.preventDefault(); return; }
  form.setAttribute("data-busy", "1");
  var status = document.getElementById("working");
  if (status) {
    status.textContent = form.getAttribute("data-working") || "Working on it...";
    status.hidden = false;
  }
  setTimeout(function () {
    var buttons = document.querySelectorAll("button[type=submit]");
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = true;
  }, 0);
});
`;

/** CSP source expression that allows exactly the script above. */
export const SCRIPT_HASH = `'sha256-${crypto.createHash("sha256").update(SCRIPT).digest("base64")}'`;

const CSS = `
:root {
  color-scheme: light dark;
  --page: #f9f9f7; --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e;
  --muted: #898781; --grid: #e1e0d9; --border: rgba(11,11,11,0.10);
  --series: #2a78d6; --good: #0ca30c; --warn: #b97e00; --crit: #d03b3b;
  --good-bg: rgba(12,163,12,0.10); --warn-bg: rgba(250,178,25,0.14); --crit-bg: rgba(208,59,59,0.10);
  /* Categorical, for the storage breakdown only. Status colors stay reserved
     for status; every segment is labelled in the table beside it. */
  --c-images: #2a78d6; --c-writable: #0f8a8a; --c-volumes: #7a5cd6;
  --c-cache: #b07a2a; --c-backups: #4d6b8a; --c-toolkit: #a15c94; --c-other: #c9c7bf;
}
@media (prefers-color-scheme: dark) {
  :root {
    --page: #0d0d0d; --surface: #1a1a19; --ink: #ffffff; --ink-2: #c3c2b7;
    --muted: #898781; --grid: #2c2c2a; --border: rgba(255,255,255,0.10);
    --series: #3987e5; --good: #0ca30c; --warn: #fab219; --crit: #d03b3b;
    --c-images: #3987e5; --c-writable: #22a5a5; --c-volumes: #9a7ff0;
    --c-cache: #d19a3e; --c-backups: #7f9bb8; --c-toolkit: #c887ba; --c-other: #46453f;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--page); color: var(--ink);
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
}
a { color: inherit; }
header {
  display: flex; align-items: center; gap: 20px; flex-wrap: wrap;
  padding: 14px 24px; border-bottom: 1px solid var(--border); background: var(--surface);
}
header .brand { font-weight: 700; letter-spacing: -0.01em; }
header nav { display: flex; gap: 4px; flex-wrap: wrap; }
header nav a {
  text-decoration: none; color: var(--ink-2); padding: 5px 11px; border-radius: 8px; font-size: 14px;
}
header nav a:hover { background: var(--page); color: var(--ink); }
header nav a[aria-current="page"] { background: var(--page); color: var(--ink); font-weight: 600; }
header form { margin-left: auto; }
main { max-width: 1080px; margin: 0 auto; padding: 24px; }
h1 { font-size: 22px; margin: 0 0 4px; letter-spacing: -0.01em; }
h2 { font-size: 15px; margin: 0 0 10px; color: var(--ink-2); font-weight: 600; }
.sub { color: var(--muted); font-size: 13px; margin: 0 0 20px; }
.grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); }
.grid.wide { grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); }
.card {
  background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 16px;
}
a.card { display: block; text-decoration: none; color: inherit; }
a.card:hover { border-color: var(--series); }
a.card .label .go { color: var(--series); font-weight: 600; }
.card .label { font-size: 13px; color: var(--ink-2); }
.card .value { font-size: 26px; font-weight: 600; margin: 2px 0 0; }
.card .detail { font-size: 13px; color: var(--muted); margin-top: 2px; overflow-wrap: anywhere; }
.hero { display: flex; align-items: baseline; gap: 14px; margin: 6px 0 20px; flex-wrap: wrap; }
.hero .headline { font-size: 30px; font-weight: 700; letter-spacing: -0.02em; }
.status { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600;
  padding: 2px 10px; border-radius: 999px; white-space: nowrap; }
.status.ok   { color: var(--good); background: var(--good-bg); }
.status.warn { color: var(--warn); background: var(--warn-bg); }
.status.fail { color: var(--crit); background: var(--crit-bg); }
table { width: 100%; border-collapse: collapse; background: var(--surface);
  border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
th, td { text-align: left; padding: 9px 14px; font-size: 14px; border-top: 1px solid var(--grid); }
thead th { border-top: 0; font-size: 12.5px; color: var(--muted); font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.04em; background: var(--surface); }
td.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
td .detail { color: var(--muted); font-size: 13px; }
.meter { height: 8px; border-radius: 4px; background: color-mix(in srgb, var(--series) 16%, var(--surface));
  overflow: hidden; margin-top: 8px; }
.meter > i { display: block; height: 100%; border-radius: 4px; background: var(--series); }
.meter.warn > i { background: #fab219; }
.meter.fail > i { background: var(--crit); }
.spark { display: block; margin-top: 8px; }
.spark polyline { fill: none; stroke: var(--series); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.spark .wash { fill: var(--series); opacity: 0.1; stroke: none; }
.spark .dot { fill: var(--series); stroke: var(--surface); stroke-width: 2; }
.spark .base { stroke: var(--grid); stroke-width: 1; }
.events li { margin: 0 0 8px; font-size: 14px; }
.events { list-style: none; padding: 0; margin: 0; }
.events time { color: var(--muted); font-size: 12.5px; font-variant-numeric: tabular-nums; margin-right: 8px; }
.working { margin: 0; padding: 12px 24px; font-size: 14px; font-weight: 600;
  background: var(--warn-bg); color: var(--warn); border-bottom: 1px solid var(--border); }
.working[hidden] { display: none; }
button[disabled] { opacity: 0.55; cursor: progress; }
.banner { margin: 0 0 18px; padding: 11px 16px; border-radius: 10px; font-size: 14px; border: 1px solid var(--border); }
.banner.ok { background: var(--good-bg); color: var(--good); border-color: transparent; }
.banner.err { background: var(--crit-bg); color: var(--crit); border-color: transparent; }
.incident { background: var(--surface); border: 1px solid var(--border); border-left: 3px solid var(--crit);
  border-radius: 12px; padding: 16px 18px; margin: 0 0 14px; }
.incident.warn { border-left-color: #fab219; }
.incident h3 { margin: 0 0 4px; font-size: 16px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.incident .meaning { margin: 6px 0 10px; color: var(--ink); font-size: 14.5px; }
.incident .why { color: var(--ink-2); font-size: 13.5px; margin: 0 0 6px; font-weight: 600; }
.incident ul.causes { margin: 0 0 12px; padding-left: 18px; color: var(--ink-2); font-size: 13.5px; }
.incident ul.causes li { margin: 2px 0; }
.incident .guidance { font-size: 13.5px; color: var(--ink-2); background: var(--page); border-radius: 8px; padding: 9px 12px; margin: 4px 0 0; }
.actions-row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-top: 4px; }
.btn-action { display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px; border-radius: 8px;
  font-size: 13.5px; font-weight: 600; cursor: pointer; border: 1px solid transparent; background: var(--series); color: #fff; }
.btn-action.caution { background: var(--surface); color: var(--ink); border-color: var(--grid); }
a.btn-action { text-decoration: none; }
.btn-action.sm { padding: 5px 11px; font-size: 12.5px; }
.btn-action:hover { filter: brightness(1.06); }
.btn-row { display: flex; gap: 6px; flex-wrap: wrap; }
.context { margin-top: 10px; font-size: 13px; color: var(--ink-2); }
.context .hint { color: var(--good); font-weight: 600; }
pre.logs { margin: 8px 0 0; padding: 12px 14px; background: var(--page); border: 1px solid var(--border);
  border-radius: 8px; font: 12px/1.5 ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  color: var(--ink-2); overflow-x: auto; max-height: 300px; overflow-y: auto; white-space: pre; }
.top-list { list-style: none; padding: 0; margin: 8px 0 0; font-size: 13px; }
.top-list li { display: flex; justify-content: space-between; padding: 3px 0; border-top: 1px solid var(--grid); }
.top-list li:first-child { border-top: 0; }
.top-list .n { color: var(--ink-2); font-variant-numeric: tabular-nums; }
details.logs-wrap { margin-top: 10px; }
details.logs-wrap summary { cursor: pointer; font-size: 13px; color: var(--ink-2); font-weight: 600; }
/* Storage page */
.headline-row { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; margin: 6px 0 4px; }
.headline-row .big { font-size: 30px; font-weight: 700; letter-spacing: -0.02em; }
.stack { display: flex; height: 28px; border-radius: 8px; overflow: hidden;
  border: 1px solid var(--border); background: var(--page); margin: 14px 0 12px; }
.stack > span { display: block; height: 100%; min-width: 2px; }
.swatch { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 8px;
  vertical-align: baseline; border: 1px solid var(--border); }
.seg-images { background: var(--c-images); }
.seg-writable { background: var(--c-writable); }
.seg-volumes { background: var(--c-volumes); }
.seg-cache { background: var(--c-cache); }
.seg-backups { background: var(--c-backups); }
.seg-toolkit { background: var(--c-toolkit); }
.seg-other { background: var(--c-other); }
.reclaim { display: grid; gap: 14px; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); }
.reclaim .card { display: flex; flex-direction: column; gap: 8px; }
.reclaim .amount { font-size: 25px; font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
.reclaim .amount small { font-size: 13px; font-weight: 400; color: var(--muted); letter-spacing: 0; }
.reclaim .what { font-size: 14px; margin: 0; }
.reclaim .risk { font-size: 13px; color: var(--ink-2); margin: 0; }
.reclaim form { margin-top: auto; }
.safe-note { border: 1px solid var(--border); border-left: 3px solid var(--good); background: var(--surface);
  border-radius: 10px; padding: 12px 16px; font-size: 13.5px; color: var(--ink-2); margin: 0 0 18px; }
.safe-note strong { color: var(--ink); }
code { font: 12.5px/1.5 ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  background: var(--page); border: 1px solid var(--border); border-radius: 5px; padding: 1px 5px; }
.tag { font-size: 12px; color: var(--muted); }
details.more { margin-top: 10px; }
details.more > summary { cursor: pointer; font-size: 13.5px; color: var(--ink-2); font-weight: 600; padding: 4px 0; }
details.more > summary:hover { color: var(--ink); }
.login { max-width: 380px; margin: 12vh auto 0; }
.login input[type=email] { width: 100%; padding: 10px 12px; border: 1px solid var(--grid);
  border-radius: 8px; background: var(--page); color: var(--ink); font-size: 15px; }
.login button, header button {
  padding: 8px 16px; border: 1px solid var(--border); border-radius: 8px; font-size: 14px;
  background: var(--surface); color: var(--ink); cursor: pointer;
}
.login button { width: 100%; margin-top: 10px; background: var(--series); color: #fff; border-color: transparent; font-weight: 600; }
header button { padding: 5px 11px; color: var(--ink-2); }
.notice { margin-top: 14px; padding: 10px 14px; border-radius: 8px; background: var(--surface);
  border: 1px solid var(--border); font-size: 14px; color: var(--ink-2); }
footer { text-align: center; color: var(--muted); font-size: 12.5px; padding: 20px; }
`;

const STATUS_GLYPH = { ok: "✓", warn: "⚠", fail: "✕" };
const STATUS_TEXT = { ok: "ok", warn: "warn", fail: "fail" };

export function statusPill(status) {
  const s = STATUS_TEXT[status] ? status : "fail";
  return `<span class="status ${s}">${STATUS_GLYPH[s]} ${STATUS_TEXT[s]}</span>`;
}

export function flashBanner(flash) {
  if (!flash || !flash.message) return "";
  return `<div class="banner ${flash.ok ? "ok" : "err"}">${flash.ok ? "✓" : "✕"} ${esc(flash.message)}</div>`;
}

/**
 * An incident card: plain-language meaning, likely causes, live context
 * (reclaimable space / busiest containers / recent logs), and action buttons.
 * `returnPath` is where the action POST returns to.
 */
export function incidentCard({ check, incident, context = {}, csrf, returnPath }) {
  if (!incident) return "";
  const causes = incident.causes?.length
    ? `<div class="why">Likely causes</div><ul class="causes">${incident.causes.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>`
    : "";

  let ctxHtml = "";
  if (context.reclaimableText) {
    ctxHtml += `<div class="context"><span class="hint">${esc(context.reclaimableText)}.</span></div>`;
  }
  if (context.top?.length) {
    ctxHtml += `<ul class="top-list">${context.top.map((t) => `<li><span>${esc(t.name)}</span><span class="n">${esc(t.text)}</span></li>`).join("")}</ul>`;
  }
  if (context.logs) {
    ctxHtml += `<details class="logs-wrap"><summary>Recent logs from ${esc(check.container)}</summary><pre class="logs">${esc(context.logs)}</pre></details>`;
  }

  const actions =
    (incident.actions ?? [])
      .map((a) =>
        actionForm({
          id: a.id,
          label: a.label,
          kind: a.kind,
          confirm: a.confirm,
          params: { container: a.container, target: a.target },
          csrf,
          returnPath,
        }),
      )
      .join("") +
    (incident.link ? `<a class="btn-action caution" href="${esc(incident.link.href)}">${esc(incident.link.label)}</a>` : "");

  const guidance = incident.guidance ? `<div class="guidance">${esc(incident.guidance)}</div>` : "";

  return `<div class="incident ${incident.severity === "warn" ? "warn" : ""}">
  <h3>${statusPill(incident.severity)} ${esc(incident.title)}</h3>
  <p class="meaning">${esc(incident.meaning)}</p>
  ${causes}
  ${actions ? `<div class="actions-row">${actions}</div>` : ""}
  ${guidance}
  ${ctxHtml}
</div>`;
}

/**
 * A single action button as a self-contained POST form (CSRF token, action id,
 * params, and a confirmation). Used by incident cards, the backups page, and
 * the storage page.
 *
 * The confirmation text and the "now running" message ride on data attributes
 * rather than inline handlers, so the one hashed script above can pick them up
 * under a strict CSP. `working` should say something true about duration:
 * clearing a large build cache or running a backup takes minutes.
 */
export function actionForm({ id, label, kind = "safe", confirm, params = {}, csrf, returnPath, small = false, working }) {
  const hidden = Object.entries(params)
    .filter(([, v]) => v != null)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join("");
  const busy = working ?? `Running: ${label}. You can leave this page; the result is recorded under Events.`;
  return `<form method="post" action="/action" data-confirm="${esc(confirm)}" data-working="${esc(busy)}" style="margin:0">
  <input type="hidden" name="csrf" value="${esc(csrf)}">
  <input type="hidden" name="actionId" value="${esc(id)}">
  <input type="hidden" name="return" value="${esc(returnPath)}">
  ${hidden}
  <button type="submit" class="btn-action ${kind === "caution" ? "caution" : ""} ${small ? "sm" : ""}">${esc(label)}</button>
</form>`;
}

export function layout({ title, page, session, body, flash }) {
  const nav = [
    ["/", "Overview"],
    ["/storage", "Storage"],
    ["/checks", "Checks"],
    ["/backups", "Backups"],
    ["/deploys", "Deploys"],
    ["/events", "Events"],
  ]
    .map(
      ([href, label]) =>
        `<a href="${href}"${page === href ? ' aria-current="page"' : ""}>${label}</a>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)} - server-tools</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <span class="brand">server-tools</span>
  <nav>${nav}</nav>
  <form method="post" action="/logout"><input type="hidden" name="csrf" value="${esc(session.csrf ?? "")}"><button type="submit" title="Signed in as ${esc(session.email)}">Sign out</button></form>
</header>
<p class="working" id="working" hidden></p>
<main>
${flashBanner(flash)}
${body}
</main>
<footer>server-tools admin</footer>
<script>${SCRIPT}</script>
</body>
</html>`;
}

export function loginPage({ message = "", sent = false } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Sign in - server-tools</title>
<style>${CSS}</style>
</head>
<body>
<main class="login">
  <h1>server-tools</h1>
  <p class="sub">Admin dashboard. Enter your email to receive a sign-in link.</p>
  <form method="post" action="/login">
    <input type="email" name="email" placeholder="you@example.com" required autofocus autocomplete="email">
    <button type="submit">Email me a sign-in link</button>
  </form>
  ${sent ? `<div class="notice">If that address is authorized, a sign-in link is on its way. Links expire in 15 minutes.</div>` : ""}
  ${message ? `<div class="notice">${esc(message)}</div>` : ""}
</main>
</body>
</html>`;
}

/**
 * Inline SVG sparkline. values: numbers (nulls skipped); the mark is a 2px
 * line with a ~10% area wash and an 8px end marker ringed in the surface
 * color. A native <title> carries the min/max/latest tooltip.
 */
export function sparkline(values, { width = 220, height = 44, unit = "" } = {}) {
  const pts = values.filter((v) => Number.isFinite(v));
  if (pts.length < 2) return "";
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = max - min || 1;
  const padX = 5;
  const padY = 7;
  const stepX = (width - padX * 2) / (pts.length - 1);
  const y = (v) => height - padY - ((v - min) / span) * (height - padY * 2);
  const coords = pts.map((v, i) => [padX + i * stepX, y(v)]);
  const line = coords.map(([cx, cy]) => `${cx.toFixed(1)},${cy.toFixed(1)}`).join(" ");
  const wash = `${padX},${height - padY} ${line} ${(padX + (pts.length - 1) * stepX).toFixed(1)},${height - padY}`;
  const [ex, ey] = coords[coords.length - 1];
  const latest = pts[pts.length - 1];
  const fmt = (v) => `${Math.round(v * 10) / 10}${unit}`;
  return `<svg class="spark" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="trend, latest ${fmt(latest)}">
<title>latest ${fmt(latest)} - min ${fmt(min)} - max ${fmt(max)} (${pts.length} samples)</title>
<line class="base" x1="${padX}" y1="${height - padY}" x2="${width - padX}" y2="${height - padY}"/>
<polygon class="wash" points="${wash}"/>
<polyline points="${line}"/>
<circle class="dot" cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="4"/>
</svg>`;
}

export function meter(pct, { warnPct = 80, failPct = 92 } = {}) {
  const cls = pct >= failPct ? "fail" : pct >= warnPct ? "warn" : "";
  const clamped = Math.max(0, Math.min(100, pct));
  return `<div class="meter ${cls}" role="img" aria-label="${clamped}% used"><i style="width:${clamped}%"></i></div>`;
}

/** A stat tile. With `href` the whole tile becomes a link to that page. */
export function statCard({ label, value, detail = "", extra = "", href = "" }) {
  const inner = `
  <div class="label">${esc(label)}${href ? ' <span class="go">&rarr;</span>' : ""}</div>
  <div class="value">${value}</div>
  ${detail ? `<div class="detail">${detail}</div>` : ""}
  ${extra}`;
  return href
    ? `<a class="card" href="${esc(href)}">${inner}</a>`
    : `<div class="card">${inner}</div>`;
}

export function overviewPage({ session, host, checks, backups, deploys, events, sparks, incidents = [], flash, csrf }) {
  const counts = { ok: 0, warn: 0, fail: 0 };
  for (const c of Object.values(checks)) counts[c.status] = (counts[c.status] ?? 0) + 1;
  const headline =
    counts.fail > 0
      ? `${counts.fail} check${counts.fail > 1 ? "s" : ""} failing`
      : counts.warn > 0
        ? `${counts.warn} warning${counts.warn > 1 ? "s" : ""}`
        : "All systems normal";
  const heroPill = counts.fail > 0 ? statusPill("fail") : counts.warn > 0 ? statusPill("warn") : statusPill("ok");

  const hostCards = [
    statCard({
      label: "CPU",
      value: host.cpuPct == null ? "-" : `${host.cpuPct}%`,
      extra: sparkline(sparks.cpu, { unit: "%" }),
    }),
    statCard({
      label: "Memory",
      value: `${host.mem.usedPct}%`,
      detail: `${formatBytes(host.mem.usedBytes)} of ${formatBytes(host.mem.totalBytes)}`,
      extra: meter(host.mem.usedPct, { warnPct: 85, failPct: 95 }) + sparkline(sparks.mem, { unit: "%" }),
    }),
    statCard({
      label: "Load (1m/core)",
      value: (host.load.m1 / Math.max(host.load.cores, 1)).toFixed(2),
      detail: `${host.load.m1.toFixed(2)} on ${host.load.cores} cores`,
      extra: sparkline(sparks.load, {}),
    }),
    ...host.disks.map((d) =>
      statCard({
        label: `Disk ${d.path}`,
        value: `${d.usedPct}%`,
        detail: `${formatBytes(d.freeBytes)} free of ${formatBytes(d.totalBytes)}<br>See what is using it`,
        extra: meter(d.usedPct, {}),
        href: "/storage",
      }),
    ),
    statCard({ label: "Host uptime", value: formatDuration(host.uptimeSeconds * 1000) }),
  ].join("\n");

  const checkRows = Object.entries(checks)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([name, c]) =>
        `<tr><td>${statusPill(c.status)}</td><td><a href="/checks/${encodeURIComponent(name)}">${esc(name)}</a></td><td class="detail-cell"><span class="detail">${esc(c.detail ?? "")}</span></td></tr>`,
    )
    .join("");

  const backupCards = Object.entries(backups)
    .map(([name, b]) => {
      const ok = b.lastResult === "ok";
      const age = b.lastSuccess ? formatDuration(Date.now() - Date.parse(b.lastSuccess)) + " ago" : "never";
      return statCard({
        label: `Backup: ${esc(name)}`,
        value: statusPill(ok ? "ok" : "fail"),
        detail: `last success ${esc(age)}${b.lastSizeBytes ? ` - ${formatBytes(b.lastSizeBytes)}` : ""}${b.offsite ? " - offsite" : ""}<br>${esc(b.lastDetail ?? "")}${b.lastDrill ? `<br>drill ${esc(b.lastDrillResult)}: ${esc((b.lastDrillDetail ?? "").slice(0, 120))}` : ""}`,
      });
    })
    .join("\n");

  const eventItems = events
    .slice(-10)
    .reverse()
    .map(
      (e) =>
        `<li><time>${esc((e.ts ?? "").replace("T", " ").replace("Z", ""))}</time>${statusPill(e.kind === "ok" || e.kind === "recover" ? "ok" : e.kind === "fail" ? "fail" : "warn")} ${esc(e.topic ?? "")} ${esc(e.name ?? "")}: ${esc((e.detail ?? "").slice(0, 140))}</li>`,
    )
    .join("");

  const attention = incidents.length
    ? `<h2>Attention needed</h2>${incidents
        .map((it) => incidentCard({ check: it.check, incident: it.incident, context: it.context, csrf, returnPath: "/" }))
        .join("")}`
    : "";

  const body = `
<h1>Overview</h1>
<div class="hero"><span class="headline">${esc(headline)}</span>${heroPill}
  <span class="sub" style="margin:0">${counts.ok} ok - ${counts.warn} warn - ${counts.fail} fail</span></div>

${attention}

<h2>Host</h2>
<div class="grid">${hostCards}</div>

<h2 style="margin-top:24px">Backups</h2>
<div class="grid wide">${backupCards || '<p class="sub">No backup targets configured.</p>'}</div>

<h2 style="margin-top:24px">Checks</h2>
<table>
<thead><tr><th>Status</th><th>Check</th><th>Detail</th></tr></thead>
<tbody>${checkRows || '<tr><td colspan="3" class="detail">No checks have run yet.</td></tr>'}</tbody>
</table>

<h2 style="margin-top:24px">Recent events</h2>
<ul class="events">${eventItems || '<li class="sub">Nothing yet.</li>'}</ul>`;
  return layout({ title: "Overview", page: "/", session, body, flash });
}

export function checksPage({ session, checks, historyByName, flash }) {
  const cards = Object.entries(checks)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, c]) => {
      const samples = historyByName[name] ?? [];
      const values = samples.map((s) => (Number.isFinite(s.value) ? s.value : null));
      const hasValues = values.some((v) => v !== null);
      return statCard({
        label: name,
        value: statusPill(c.status),
        detail: `${esc(c.detail ?? "")}<br><span class="sub">${esc(c.type)} - checked ${esc((c.at ?? "").replace("T", " ").replace("Z", " UTC"))}</span>`,
        extra: hasValues ? sparkline(values, {}) : "",
      });
    })
    .join("\n");
  const body = `<h1>Checks</h1><p class="sub">Latest result per check; sparklines show recorded values (latency, %, days) over recent history.</p>
<div class="grid wide">${cards || '<p class="sub">No checks configured.</p>'}</div>`;
  return layout({ title: "Checks", page: "/checks", session, body, flash });
}

export function checkDetailPage({ session, name, current, samples, incident, context, csrf, flash, checkConfig }) {
  const values = samples.map((s) => (Number.isFinite(s.value) ? s.value : null));
  const rows = samples
    .slice(-100)
    .reverse()
    .map(
      (s) =>
        `<tr><td>${statusPill(s.status)}</td><td class="num">${s.value ?? ""}</td><td><span class="detail">${esc(s.detail ?? "")}</span></td><td class="num"><time>${esc((s.ts ?? "").replace("T", " ").replace("Z", ""))}</time></td></tr>`,
    )
    .join("");
  const card = incident
    ? incidentCard({ check: checkConfig ?? { name }, incident, context, csrf, returnPath: `/checks/${encodeURIComponent(name)}` })
    : "";
  const body = `<h1>${esc(name)}</h1>
<p class="sub">${current ? `${esc(current.type)} - currently ${current.status}: ${esc(current.detail ?? "")}` : "No current state."}</p>
${card}
${values.filter((v) => v !== null).length > 1 ? sparkline(values, { width: 640, height: 80 }) : ""}
<h2 style="margin-top:20px">History (${samples.length} samples)</h2>
<table>
<thead><tr><th>Status</th><th>Value</th><th>Detail</th><th>At</th></tr></thead>
<tbody>${rows || '<tr><td colspan="4" class="detail">No samples recorded.</td></tr>'}</tbody>
</table>`;
  return layout({ title: name, page: "/checks", session, body, flash });
}

export function backupsPage({ session, backups, targets, flash, csrf }) {
  const rows = targets
    .map((t) => {
      const b = backups[t.name] ?? {};
      const ok = b.lastResult === "ok";
      const buttons = [
        actionForm({
          id: "run-backup",
          label: "Back up now",
          kind: "safe",
          confirm: `Run the "${t.name}" backup now?`,
          params: { target: t.name },
          csrf,
          returnPath: "/backups",
          small: true,
          working: `Backing up "${t.name}". A large database can take several minutes. You can leave this page; the result is recorded under Events.`,
        }),
        t.type === "postgres"
          ? actionForm({
              id: "run-drill",
              label: "Test restore",
              kind: "caution",
              confirm: `Run a restore drill for "${t.name}"? It restores the latest backup into a temporary database to prove it works, then removes it. This can take a moment.`,
              params: { target: t.name },
              csrf,
              returnPath: "/backups",
              small: true,
              working: `Running a restore drill for "${t.name}". This restores a full copy, so it can take several minutes. You can leave this page; the result is recorded under Events.`,
            })
          : "",
      ].join("");
      return `<tr>
<td>${b.lastResult ? statusPill(ok ? "ok" : "fail") : '<span class="detail">never run</span>'}</td>
<td>${esc(t.name)}<br><span class="detail">${esc(t.type)}${t.schedule ? ` - ${esc(t.schedule)}` : " - manual"}</span></td>
<td class="num">${b.lastSuccess ? esc(formatDuration(Date.now() - Date.parse(b.lastSuccess))) + " ago" : "-"}</td>
<td class="num">${b.lastSizeBytes ? formatBytes(b.lastSizeBytes) : "-"}</td>
<td>${b.offsite ? "yes" : "-"}</td>
<td>${b.lastDrill ? `${statusPill(b.lastDrillResult === "ok" ? "ok" : "fail")} <span class="detail">${esc(formatDuration(Date.now() - Date.parse(b.lastDrill)))} ago</span>` : '<span class="detail">never</span>'}</td>
<td><div class="btn-row">${buttons}</div></td>
</tr>`;
    })
    .join("");
  const body = `<h1>Backups</h1>
<p class="sub">Back up any target now, or run a restore drill to prove a database backup actually restores - no terminal needed. Encrypted artifacts are kept locally and, when configured, uploaded offsite.</p>
<table>
<thead><tr><th>Status</th><th>Target</th><th>Last success</th><th>Size</th><th>Offsite</th><th>Restore drill</th><th>Actions</th></tr></thead>
<tbody>${rows || '<tr><td colspan="7" class="detail">No backup targets configured.</td></tr>'}</tbody>
</table>`;
  return layout({ title: "Backups", page: "/backups", session, body, flash });
}

/** Wrap a long table in a collapsed disclosure once it stops being scannable. */
function collapsible(summary, html, { open = false } = {}) {
  return `<details class="more"${open ? " open" : ""}><summary>${esc(summary)}</summary>${html}</details>`;
}

function ago(iso) {
  const t = Date.parse(iso ?? "");
  return Number.isFinite(t) ? `${formatDuration(Date.now() - t)} ago` : "-";
}

/**
 * The storage page: where the disk went, and the safe ways to get some back.
 *
 * Every cleanup option is shown with the exact amount it frees and the exact
 * items it would remove, so the button only ever does what the operator just
 * read. Volumes are listed but never actionable; that is the whole point.
 */
export function storagePage({ session, report, flash, csrf }) {
  const r = report;
  const total = r.disk?.totalBytes ?? r.accountedBytes ?? 0;
  const share = (bytes) => (total > 0 ? (bytes / total) * 100 : 0);

  const headline = r.reclaimableBytes > 0 ? `${formatBytes(r.reclaimableBytes)} can be reclaimed safely` : "Nothing worth reclaiming right now";

  const diskLine = r.disk
    ? `<div class="card" style="margin:0 0 20px">
  <div class="label">Disk ${esc(r.diskPath)}</div>
  <div class="value">${r.disk.usedPct}% used</div>
  <div class="detail">${formatBytes(r.disk.freeBytes)} free of ${formatBytes(r.disk.totalBytes)}</div>
  ${meter(r.disk.usedPct, {})}
</div>`
    : `<p class="sub">Filesystem usage for ${esc(r.diskPath)} is not visible from here.</p>`;

  const segments = r.breakdown
    .filter((b) => b.bytes > 0)
    .map(
      (b) =>
        `<span class="seg-${esc(b.key)}" style="width:${share(b.bytes).toFixed(2)}%" title="${esc(b.label)}: ${formatBytes(b.bytes)}"></span>`,
    )
    .join("");

  const breakdownRows = r.breakdown
    .map(
      (b) => `<tr>
<td><span class="swatch seg-${esc(b.key)}"></span>${esc(b.label)}</td>
<td class="num">${formatBytes(b.bytes)}</td>
<td class="num">${total > 0 ? `${share(b.bytes).toFixed(1)}%` : "-"}</td>
<td><span class="detail">${esc(b.note)}</span></td>
</tr>`,
    )
    .join("");

  const reclaimCards = r.plan
    .map((a) => {
      const button = actionForm({
        id: a.id,
        label: `Free ${formatBytes(a.bytes)}`,
        kind: a.kind,
        confirm: `${a.label}\n\n${a.what}\n\n${a.risk}\n\nFrees about ${formatBytes(a.bytes)}. Continue?`,
        params: { target: a.target },
        csrf,
        returnPath: "/storage",
        working: `Running: ${a.label}. Clearing this much can take several minutes. You can leave this page; the result is recorded under Events.`,
      });
      return `<div class="card">
  <div class="label">${esc(a.label)} ${a.kind === "caution" ? '<span class="status warn">&#9888; review first</span>' : '<span class="status ok">&#10003; safe</span>'}</div>
  <div class="amount">${formatBytes(a.bytes)} <small>${a.count ? `${a.count} item${a.count > 1 ? "s" : ""}` : ""}</small></div>
  <p class="what">${esc(a.what)}</p>
  <p class="risk">${esc(a.risk)}</p>
  ${button}
</div>`;
    })
    .join("");

  const projectRows = r.projects
    .map(
      (p) => `<tr>
<td>${esc(p.name)}${p.serviceCount ? `<br><span class="detail">${p.serviceCount} service${p.serviceCount > 1 ? "s" : ""}</span>` : ""}</td>
<td class="num">${p.running} / ${p.containers}</td>
<td class="num">${formatBytes(p.imageBytes)}</td>
<td class="num">${formatBytes(p.volumeBytes)}${p.volumeCount ? `<br><span class="detail">${p.volumeCount} volume${p.volumeCount > 1 ? "s" : ""}</span>` : ""}</td>
<td class="num">${formatBytes(p.writableBytes)}</td>
</tr>`,
    )
    .join("");

  const imageRows = r.unusedImages
    .map(
      (i) => `<tr>
<td>${esc(i.name)}${i.tags.length > 1 ? `<br><span class="tag">also tagged ${esc(i.tags.slice(1).join(", "))}</span>` : ""}</td>
<td>${i.dangling ? '<span class="detail">untagged leftover</span>' : '<span class="detail">named</span>'}</td>
<td class="num">${i.createdAt ? esc(ago(i.createdAt)) : "-"}</td>
<td class="num">${formatBytes(i.sizeBytes)}</td>
</tr>`,
    )
    .join("");

  const imagesTable = `<table>
<thead><tr><th>Image</th><th>Kind</th><th>Built</th><th>Size</th></tr></thead>
<tbody>${imageRows}</tbody>
</table>`;

  const containerRows = r.staleContainers
    .map(
      (c) => `<tr>
<td>${esc(c.name)}${c.project ? `<br><span class="detail">${esc(c.project)}${c.service ? ` / ${esc(c.service)}` : ""}</span>` : ""}</td>
<td><span class="detail">${esc(c.status ?? "exited")}</span></td>
<td class="num">${esc(formatDuration(c.stoppedForMs))}</td>
<td class="num">${formatBytes(c.sizeBytes)}</td>
</tr>`,
    )
    .join("");

  const containersTable = `<table>
<thead><tr><th>Container</th><th>State</th><th>Stopped for</th><th>Writable size</th></tr></thead>
<tbody>${containerRows || '<tr><td colspan="4" class="detail">None. Nothing has been sitting stopped.</td></tr>'}</tbody>
</table>`;

  // Unreferenced volumes first: they are what an operator came here to see.
  const unreferenced = r.volumes.filter((v) => !v.inUse);
  const volumesTable = `<table>
<thead><tr><th>Volume</th><th>Referenced</th><th>Size</th></tr></thead>
<tbody>${
    [...unreferenced, ...r.volumes.filter((v) => v.inUse)]
      .map(
        (v) => `<tr>
<td>${esc(v.name)}${v.project ? `<br><span class="detail">${esc(v.project)}</span>` : ""}</td>
<td>${v.inUse ? `${statusPill("ok")} in use` : '<span class="status warn">&#9888; not referenced</span>'}</td>
<td class="num">${formatBytes(v.sizeBytes)}</td>
</tr>`,
      )
      .join("") || '<tr><td colspan="3" class="detail">No volumes.</td></tr>'
  }</tbody>
</table>`;

  const backupRows = r.backups
    .map(
      (b) => `<tr>
<td>${esc(b.name)}<br><span class="detail">keeps ${b.retention.daily} daily, ${b.retention.weekly} weekly, ${b.retention.monthly} monthly</span></td>
<td class="num">${b.artifactCount}</td>
<td class="num">${formatBytes(b.totalBytes)}</td>
<td class="num">${b.prunableCount ? `${b.prunableCount} (${formatBytes(b.prunableBytes)})` : "none"}</td>
<td>${
        b.prunableCount
          ? actionForm({
              id: "prune-backups",
              label: "Apply retention",
              kind: "safe",
              confirm: `Delete ${b.prunableCount} backup artifact(s) for "${b.name}" that are already past your retention policy? This frees about ${formatBytes(b.prunableBytes)}.`,
              params: { target: b.name },
              csrf,
              returnPath: "/storage",
              small: true,
            })
          : '<span class="detail">nothing to remove</span>'
      }</td>
</tr>`,
    )
    .join("");

  const findings = r.findings
    .map(
      (f) => `<div class="incident warn">
  <h3><span class="status warn">&#9888; heads up</span> ${esc(f.title)}</h3>
  <p class="meaning">${esc(f.detail)}</p>
  ${f.names?.length ? `<div class="context">${esc(f.names.join(", "))}</div>` : ""}
</div>`,
    )
    .join("");

  const logsPanel = r.logs.available
    ? `<h2 style="margin-top:24px">Container log files</h2>
<p class="sub">${formatBytes(r.logs.totalBytes)} of log files on disk. Trim these by setting a log size limit in your compose file and recreating the service.</p>
<ul class="top-list">${r.logs.top.map((l) => `<li><span>${esc(l.name)}</span><span class="n">${formatBytes(l.sizeBytes)}</span></li>`).join("")}</ul>`
    : "";

  const dockerWarning = r.dockerAvailable
    ? ""
    : `<div class="banner err">&#10007; Docker is not reachable from here, so only backup and history usage is shown.</div>`;

  const body = `
<h1>Storage</h1>
<p class="sub">Where the disk is going on this box, and the ways to get some of it back that will not disturb anything running.</p>

${dockerWarning}

<div class="headline-row"><span class="big">${esc(headline)}</span></div>

${diskLine}

<h2>Where the space is going</h2>
<div class="stack" role="img" aria-label="disk usage by category">${segments}</div>
<table>
<thead><tr><th>Category</th><th>Size</th><th>Share of disk</th><th>What it is</th></tr></thead>
<tbody>${breakdownRows}</tbody>
</table>
<p class="sub" style="margin-top:8px">Shares are of the filesystem at ${esc(r.diskPath)}, and assume Docker stores its data there, which is the default. Image sizes count shared layers once.</p>

<h2 style="margin-top:24px">Ways to reclaim space</h2>
<div class="safe-note"><strong>What will never happen here:</strong> no volume is ever deleted, no running container is stopped or removed, and no application data is touched. Every option below lists exactly what it removes before you click.</div>
${r.plan.length ? `<div class="reclaim">${reclaimCards}</div>` : '<p class="sub">Nothing to reclaim. Images, build cache, and backups are all within policy.</p>'}

${findings ? `<h2 style="margin-top:24px">Worth fixing before it costs you</h2>${findings}` : ""}

<h2 style="margin-top:24px">By compose project</h2>
<p class="sub">Which project is holding the space. Image sizes include shared base layers, so projects built on the same base each count it.</p>
<table>
<thead><tr><th>Project</th><th>Running / total</th><th>Images</th><th>Volumes</th><th>Writable</th></tr></thead>
<tbody>${projectRows || '<tr><td colspan="5" class="detail">No containers found.</td></tr>'}</tbody>
</table>

<h2 style="margin-top:24px">Images no container is using (${r.unusedImages.length})</h2>
${
  r.unusedImages.length
    ? r.unusedImages.length > 8
      ? collapsible(`Show all ${r.unusedImages.length} unused images`, imagesTable)
      : imagesTable
    : '<p class="sub">Every image on the box backs a container. Nothing to remove.</p>'
}
${r.keepImages.length ? `<p class="sub" style="margin-top:8px">Protected by your config and never listed here: ${esc(r.keepImages.join(", "))}</p>` : ""}

<h2 style="margin-top:24px">Stopped containers safe to remove (${r.staleContainers.length})</h2>
<p class="sub">Containers that exited more than ${esc(formatDuration(r.staleAgeMs))} ago and are not set to restart. Anything meant to be running is left out of this list on purpose, along with its logs.</p>
${
  r.staleContainers.length > 10
    ? collapsible(`Show all ${r.staleContainers.length} stopped containers`, containersTable)
    : containersTable
}

<h2 style="margin-top:24px">Volumes (${formatBytes(r.summary?.volumes.totalBytes ?? 0)})</h2>
<div class="safe-note"><strong>These are your data.</strong> A volume with nothing referencing it is often still a database from a project that is currently down, so this toolkit will never delete one for you. If you have confirmed a volume is genuinely finished with, remove it yourself on the box with <code>docker volume rm &lt;name&gt;</code>.</div>
${r.volumes.length > 10 ? collapsible(`Show all ${r.volumes.length} volumes (${unreferenced.length} not referenced)`, volumesTable) : volumesTable}

<h2 style="margin-top:24px">Backups on this box</h2>
<table>
<thead><tr><th>Target</th><th>Artifacts</th><th>Size</th><th>Past retention</th><th>Action</th></tr></thead>
<tbody>${backupRows || '<tr><td colspan="5" class="detail">No backup targets configured.</td></tr>'}</tbody>
</table>

${logsPanel}`;
  return layout({ title: "Storage", page: "/storage", session, body, flash });
}

export function deploysPage({ session, deploys, targets, events, flash }) {
  const rows = targets
    .map((t) => {
      const d = deploys[t.name];
      return `<tr>
<td>${d ? statusPill(d.kind === "ok" ? "ok" : "fail") : '<span class="detail">no deploys recorded</span>'}</td>
<td>${esc(t.name)}<br><span class="detail">${esc(t.dir)}</span></td>
<td class="num">${d ? esc((d.at ?? "").replace("T", " ").replace("Z", "")) : "-"}</td>
<td>${d ? `${esc(d.from)} &rarr; ${esc(d.to)}` : "-"}</td>
<td><span class="detail">${d ? esc((d.detail ?? "").slice(0, 140)) : ""}</span></td>
</tr>`;
    })
    .join("");
  const history = events
    .filter((e) => e.topic === "deploy")
    .slice(-30)
    .reverse()
    .map(
      (e) =>
        `<li><time>${esc((e.ts ?? "").replace("T", " ").replace("Z", ""))}</time>${statusPill(e.kind === "ok" ? "ok" : "fail")} ${esc(e.name ?? "")}: ${esc((e.detail ?? "").slice(0, 160))}</li>`,
    )
    .join("");
  const body = `<h1>Deploys</h1>
<p class="sub">Deploy from the box: <code>server-tools deploy &lt;target&gt; &lt;tag&gt;</code>. Failed health checks roll back automatically.</p>
<table>
<thead><tr><th>Last result</th><th>Target</th><th>When</th><th>Refs</th><th>Detail</th></tr></thead>
<tbody>${rows || '<tr><td colspan="5" class="detail">No deploy targets configured.</td></tr>'}</tbody>
</table>
<h2 style="margin-top:24px">History</h2>
<ul class="events">${history || '<li class="sub">No deploy events recorded.</li>'}</ul>`;
  return layout({ title: "Deploys", page: "/deploys", session, body, flash });
}

export function eventsPage({ session, events, flash }) {
  const rows = events
    .slice(-300)
    .reverse()
    .map(
      (e) =>
        `<tr><td class="num"><time>${esc((e.ts ?? "").replace("T", " ").replace("Z", ""))}</time></td><td>${statusPill(e.kind === "ok" || e.kind === "recover" ? "ok" : e.kind === "fail" ? "fail" : "warn")}</td><td>${esc(e.topic ?? "")}</td><td>${esc(e.name ?? "")}</td><td><span class="detail">${esc((e.detail ?? "").slice(0, 200))}</span></td></tr>`,
    )
    .join("");
  const body = `<h1>Events</h1>
<p class="sub">Everything the toolkit did or noticed: check transitions, backups, drills, deploys, housekeeping, alerts.</p>
<table>
<thead><tr><th>At (UTC)</th><th>Kind</th><th>Topic</th><th>Target</th><th>Detail</th></tr></thead>
<tbody>${rows || '<tr><td colspan="5" class="detail">Nothing recorded yet.</td></tr>'}</tbody>
</table>`;
  return layout({ title: "Events", page: "/events", session, body, flash });
}
