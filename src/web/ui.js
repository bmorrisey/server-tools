/**
 * Server-rendered dashboard UI. Plain HTML + inline CSS/SVG, no external
 * assets (strict CSP friendly), light and dark from one palette. Charts
 * follow fixed mark specs: 2px lines, >=8px end markers with a surface ring,
 * ~10% area washes, hairline grid, status always icon + label (never color
 * alone).
 */
import { escapeHtml as esc, formatBytes, formatDuration } from "../util.js";

const CSS = `
:root {
  color-scheme: light dark;
  --page: #f9f9f7; --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e;
  --muted: #898781; --grid: #e1e0d9; --border: rgba(11,11,11,0.10);
  --series: #2a78d6; --good: #0ca30c; --warn: #b97e00; --crit: #d03b3b;
  --good-bg: rgba(12,163,12,0.10); --warn-bg: rgba(250,178,25,0.14); --crit-bg: rgba(208,59,59,0.10);
}
@media (prefers-color-scheme: dark) {
  :root {
    --page: #0d0d0d; --surface: #1a1a19; --ink: #ffffff; --ink-2: #c3c2b7;
    --muted: #898781; --grid: #2c2c2a; --border: rgba(255,255,255,0.10);
    --series: #3987e5; --good: #0ca30c; --warn: #fab219; --crit: #d03b3b;
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
td.num { font-variant-numeric: tabular-nums; }
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
.btn-action.caution { background: var(--surface); color: var(--ink); border-color: var(--input); }
.btn-action:hover { filter: brightness(1.06); }
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

  const actions = (incident.actions ?? [])
    .map((a) => {
      const params = a.container ? `<input type="hidden" name="container" value="${esc(a.container)}">` : "";
      const target = a.target ? `<input type="hidden" name="target" value="${esc(a.target)}">` : "";
      return `<form method="post" action="/action" onsubmit="return confirm(${jsStr(a.confirm)})" style="margin:0">
  <input type="hidden" name="csrf" value="${esc(csrf)}">
  <input type="hidden" name="actionId" value="${esc(a.id)}">
  <input type="hidden" name="return" value="${esc(returnPath)}">
  ${params}${target}
  <button type="submit" class="btn-action ${a.kind === "caution" ? "caution" : ""}">${esc(a.label)}</button>
</form>`;
    })
    .join("");

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

/** JSON-encode a string for safe inline use in a JS attribute. */
function jsStr(s) {
  return esc(JSON.stringify(String(s)));
}

export function layout({ title, page, session, body, flash }) {
  const nav = [
    ["/", "Overview"],
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
<main>
${flashBanner(flash)}
${body}
</main>
<footer>server-tools admin</footer>
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

export function statCard({ label, value, detail = "", extra = "" }) {
  return `<div class="card">
  <div class="label">${esc(label)}</div>
  <div class="value">${value}</div>
  ${detail ? `<div class="detail">${detail}</div>` : ""}
  ${extra}
</div>`;
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
        label: `Disk ${esc(d.path)}`,
        value: `${d.usedPct}%`,
        detail: `${formatBytes(d.freeBytes)} free of ${formatBytes(d.totalBytes)}`,
        extra: meter(d.usedPct, {}),
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

export function backupsPage({ session, backups, targets, flash }) {
  const rows = targets
    .map((t) => {
      const b = backups[t.name] ?? {};
      const ok = b.lastResult === "ok";
      return `<tr>
<td>${b.lastResult ? statusPill(ok ? "ok" : "fail") : '<span class="detail">never run</span>'}</td>
<td>${esc(t.name)}<br><span class="detail">${esc(t.type)}${t.schedule ? ` - ${esc(t.schedule)}` : " - manual"}</span></td>
<td class="num">${b.lastSuccess ? esc(formatDuration(Date.now() - Date.parse(b.lastSuccess))) + " ago" : "-"}</td>
<td class="num">${b.lastSizeBytes ? formatBytes(b.lastSizeBytes) : "-"}</td>
<td>${b.offsite ? "yes" : "-"}</td>
<td>${b.lastDrill ? `${statusPill(b.lastDrillResult === "ok" ? "ok" : "fail")} <span class="detail">${esc(formatDuration(Date.now() - Date.parse(b.lastDrill)))} ago</span>` : '<span class="detail">never</span>'}</td>
<td><span class="detail">${esc((b.lastDetail ?? "").slice(0, 120))}</span></td>
</tr>`;
    })
    .join("");
  const body = `<h1>Backups</h1>
<p class="sub">Run one now: <code>server-tools backup &lt;target&gt;</code> - prove restores work: <code>server-tools drill &lt;target&gt;</code> (see RUNBOOK.md).</p>
<table>
<thead><tr><th>Status</th><th>Target</th><th>Last success</th><th>Size</th><th>Offsite</th><th>Restore drill</th><th>Detail</th></tr></thead>
<tbody>${rows || '<tr><td colspan="7" class="detail">No backup targets configured.</td></tr>'}</tbody>
</table>`;
  return layout({ title: "Backups", page: "/backups", session, body, flash });
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
