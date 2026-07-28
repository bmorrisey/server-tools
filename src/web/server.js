/**
 * Dashboard HTTP server. Plain node:http, no framework. Sits behind a
 * TLS-terminating reverse proxy; binds per config (compose maps it to
 * localhost on the host).
 *
 * Routes:
 *   GET  /healthz          liveness for the toolkit itself (public, no data)
 *   GET  /login            login form (public)
 *   POST /login            request a magic link (rate limited)
 *   GET  /auth?token=...   consume a link -> session cookie
 *   POST /logout
 *   GET  /                 overview          } session required
 *   GET  /storage          disk breakdown + safe cleanup options }
 *   GET  /checks[/name]    checks + history  }
 *   GET  /backups          backup targets    }
 *   GET  /deploys          deploy history    }
 *   GET  /events           event log         }
 *   POST /action           run one validated remediation (CSRF protected)
 *   GET  /api/status       machine-readable snapshot (session required)
 *   GET  /api/storage      machine-readable storage report (session required)
 */
import http from "node:http";
import { URL } from "node:url";
import * as ui from "./ui.js";
import * as auth from "./auth.js";
import * as metrics from "../metrics.js";
import * as storage from "../storage.js";
import { sendMail } from "../smtp.js";
import { diagnose, gatherContext, runAction, ACTION_IDS } from "../remediate.js";
import { logger } from "../log.js";

const log = logger("web");

const SECURITY_HEADERS = {
  // script-src allows exactly one script, by hash: the confirmation and
  // progress handler in ui.js. No 'unsafe-inline', so an injected script
  // still cannot run. Note that without a script-src, inline handlers are
  // blocked outright, which is why confirmations must live in that block.
  "content-security-policy":
    `default-src 'none'; script-src ${ui.SCRIPT_HASH}; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== "string";
  const payload = isJson ? JSON.stringify(body, null, 2) : body;
  res.writeHead(status, {
    "content-type": isJson ? "application/json; charset=utf-8" : "text/html; charset=utf-8",
    "cache-control": "no-store",
    ...SECURITY_HEADERS,
    ...headers,
  });
  res.end(payload);
}

function redirect(res, location, headers = {}) {
  res.writeHead(303, { location, ...SECURITY_HEADERS, ...headers });
  res.end();
}

function readBody(req, limit = 10_000) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > limit) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function clientIp(req) {
  // Behind the reverse proxy the socket address is the proxy; the standard
  // forwarded header carries the real client (first hop).
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();
  return req.socket.remoteAddress ?? "unknown";
}

async function collectHost(config) {
  const diskChecks = config.checks.filter((c) => c.type === "disk");
  const disks = [];
  for (const c of diskChecks) {
    try {
      disks.push(await metrics.disk(c.path));
    } catch {
      // Path not mounted in this environment; skip rather than break the page.
    }
  }
  return {
    cpuPct: metrics.cpu().pct,
    mem: metrics.memory(),
    load: metrics.load(),
    disks,
    uptimeSeconds: metrics.uptimeSeconds(),
  };
}

function hostSparks(store) {
  const samples = store.recent("host", { limit: 180, maxDays: 2 });
  return {
    cpu: samples.map((s) => s.cpuPct).filter((v) => v != null),
    mem: samples.map((s) => s.memPct).filter((v) => v != null),
    load: samples.map((s) => s.load1).filter((v) => v != null),
  };
}

/**
 * Build incident cards for checks that are not passing. On the overview we
 * include every failing check plus warnings that have a concrete action (so a
 * "disk getting full" warn shows its reclaim button, but a bare warn does not
 * clutter the page). Context (logs/df/stats) is gathered per incident.
 */
async function computeIncidents(config, checks, docker, { overviewOnly = false } = {}) {
  const out = [];
  for (const check of config.checks ?? []) {
    const state = checks[check.name];
    if (!state || state.status === "ok") continue;
    const incident = diagnose(check, state);
    if (!incident) continue;
    if (overviewOnly && state.status === "warn" && !(incident.actions?.length)) continue;
    const context = await gatherContext(check, { docker });
    out.push({ check, state, incident, context });
    if (out.length >= 8) break;
  }
  // Failures first, then warnings.
  return out.sort((a, b) => (a.state.status === "fail" ? 0 : 1) - (b.state.status === "fail" ? 0 : 1));
}

function parseFlash(url) {
  const message = url.searchParams.get("msg");
  if (!message) return null;
  return { ok: url.searchParams.get("ok") === "1", message: message.slice(0, 300) };
}

function flashUrl(path, ok, message) {
  const q = new URLSearchParams({ ok: ok ? "1" : "0", msg: String(message).slice(0, 300) });
  return `${path}?${q.toString()}`;
}

/** Only allow returning to an internal dashboard path (no open redirects). */
function safeReturn(path) {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) return "/";
  return path.split("?")[0];
}

function checkHistory(store, name = null) {
  const samples = store.recent("checks", { limit: 4000, maxDays: 3 });
  const byName = {};
  for (const s of samples) {
    (byName[s.name] ??= []).push(s);
  }
  for (const k of Object.keys(byName)) byName[k] = byName[k].slice(-120);
  return name ? (byName[name] ?? []) : byName;
}

export function startWebServer({ config, store, docker, alerter }) {
  const loginByIp = new auth.RateLimiter({ max: 10, windowMs: 15 * 60_000 });
  const loginByEmail = new auth.RateLimiter({ max: 4, windowMs: 15 * 60_000 });

  const server = http.createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (e) {
      log.error(`unhandled: ${req.method} ${req.url}: ${e.message}`);
      send(res, 500, "<h1>Something went wrong</h1>");
    }
  });

  async function route(req, res) {
    const url = new URL(req.url, "http://internal");
    const path = url.pathname.replace(/\/+$/, "") || "/";

    // Public endpoints.
    if (req.method === "GET" && path === "/healthz") {
      return send(res, 200, { status: "ok", uptime: Math.floor(process.uptime()) });
    }
    if (path === "/login") {
      if (req.method === "GET") return send(res, 200, ui.loginPage());
      if (req.method === "POST") {
        const ip = clientIp(req);
        if (!loginByIp.allow(ip)) return send(res, 429, ui.loginPage({ message: "Too many attempts; try again later." }));
        const body = new URLSearchParams(await readBody(req));
        const email = String(body.get("email") ?? "").trim().toLowerCase();
        // Uniform response regardless of whether the address is allowed.
        if (email && auth.emailAllowed(config, email) && loginByEmail.allow(email)) {
          const link = auth.createLoginToken({ config, store, email });
          if (config.alerts?.smtp) {
            sendMail(config.alerts.smtp, {
              to: email,
              subject: "Your server-tools sign-in link",
              text: `Sign in to the server-tools dashboard:\n\n${link}\n\nThis link is valid for 15 minutes and can be used once. If you did not request it, ignore this email.`,
            }).catch((e) => log.warn(`login mail failed: ${e.message}`));
          } else {
            log.info(`login link requested for ${email}; SMTP not configured - use: server-tools login-link ${email}`);
          }
          store.append("events", { topic: "auth", kind: "ok", name: email, detail: "login link requested" });
        }
        const hint = config.alerts?.smtp
          ? {}
          : { message: "Email sending is not configured on this instance; generate a link on the box with: server-tools login-link <email>" };
        return send(res, 200, ui.loginPage({ sent: true, ...hint }));
      }
    }
    if (req.method === "GET" && path === "/auth") {
      const sessionId = auth.consumeToken({ config, store, token: url.searchParams.get("token") ?? "" });
      if (!sessionId) return send(res, 400, ui.loginPage({ message: "That link is invalid or expired. Request a new one." }));
      return redirect(res, "/", { "set-cookie": auth.sessionCookie(config, sessionId) });
    }

    // Everything else requires a session.
    const session = auth.sessionFromCookie({ store, cookieHeader: req.headers.cookie });
    if (!session) {
      if (path.startsWith("/api/")) return send(res, 401, { error: "unauthorized" });
      return redirect(res, "/login");
    }

    if (req.method === "POST" && path === "/logout") {
      const body = new URLSearchParams(await readBody(req));
      if (!auth.csrfValid(session, body.get("csrf"))) return redirect(res, "/");
      auth.destroySession({ store, cookieHeader: req.headers.cookie });
      return redirect(res, "/login", { "set-cookie": auth.clearCookie() });
    }

    // One-click remediation. State-changing, so CSRF-protected and validated.
    if (req.method === "POST" && path === "/action") {
      const body = new URLSearchParams(await readBody(req));
      if (!auth.csrfValid(session, body.get("csrf"))) return send(res, 403, "<h1>Invalid request token</h1>");
      const actionId = body.get("actionId") ?? "";
      const returnPath = safeReturn(body.get("return"));
      if (!ACTION_IDS.has(actionId)) {
        return redirect(res, flashUrl(returnPath, false, `Unknown action "${actionId}"`));
      }
      log.info(`action requested: ${actionId} by ${session.email}`);
      const result = await runAction(actionId, { container: body.get("container"), target: body.get("target") }, { docker, store, config });
      return redirect(res, flashUrl(returnPath, result.ok, result.message));
    }

    if (req.method !== "GET") return send(res, 405, "<h1>Method not allowed</h1>");

    const flash = parseFlash(url);
    const checks = store.readState("checks", {});
    const backups = store.readState("backups", {});
    const deploys = store.readState("deploys", {});
    const events = store.recent("events", { limit: 400, maxDays: 7 });

    if (path === "/") {
      const [host, sparks, incidents] = [await collectHost(config), hostSparks(store), await computeIncidents(config, checks, docker, { overviewOnly: true })];
      return send(res, 200, ui.overviewPage({ session, host, checks, backups, deploys, events, sparks, incidents, flash, csrf: session.csrf }));
    }
    if (path === "/checks") {
      return send(res, 200, ui.checksPage({ session, checks, historyByName: checkHistory(store), flash }));
    }
    if (path.startsWith("/checks/")) {
      const name = decodeURIComponent(path.slice("/checks/".length));
      const checkConfig = config.checks.find((c) => c.name === name);
      if (!checkConfig && !checks[name]) {
        return send(res, 404, "<h1>No such check</h1>");
      }
      const current = checks[name];
      let incident = null;
      let context = {};
      if (checkConfig && current && current.status !== "ok") {
        incident = diagnose(checkConfig, current);
        if (incident) context = await gatherContext(checkConfig, { docker });
      }
      return send(
        res,
        200,
        ui.checkDetailPage({ session, name, current, samples: checkHistory(store, name), incident, context, checkConfig, csrf: session.csrf, flash }),
      );
    }
    if (path === "/storage") {
      const report = await storage.report({ docker, store, config });
      return send(res, 200, ui.storagePage({ session, report, flash, csrf: session.csrf }));
    }
    if (path === "/backups") {
      return send(res, 200, ui.backupsPage({ session, backups, targets: config.backups, flash, csrf: session.csrf }));
    }
    if (path === "/deploys") {
      return send(res, 200, ui.deploysPage({ session, deploys, targets: config.deploys, events, flash }));
    }
    if (path === "/events") {
      return send(res, 200, ui.eventsPage({ session, events, flash }));
    }
    if (path === "/api/status") {
      const host = await collectHost(config);
      return send(res, 200, {
        generatedAt: new Date().toISOString(),
        host: {
          cpuPct: host.cpuPct,
          memUsedPct: host.mem.usedPct,
          load1: host.load.m1,
          cores: host.load.cores,
          disks: host.disks.map((d) => ({ path: d.path, usedPct: d.usedPct, freeBytes: d.freeBytes })),
          uptimeSeconds: host.uptimeSeconds,
        },
        checks,
        backups,
        deploys,
        dockerReachable: await docker.ping(),
      });
    }
    if (path === "/api/storage") {
      return send(res, 200, await storage.report({ docker, store, config }));
    }

    return send(res, 404, "<h1>Not found</h1>");
  }

  const { port, bind } = config.web;
  return new Promise((resolve) => {
    server.listen(port, bind, () => {
      log.info(`dashboard listening on http://${bind}:${port} (public URL: ${config.web.baseUrl})`);
      resolve(server);
    });
  });
}
