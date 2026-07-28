/**
 * Configuration loader.
 *
 * A single JSON file (default ./config.json, override with SERVER_TOOLS_CONFIG)
 * describes everything the toolkit watches and does. Secrets never live in the
 * file: any string value of the form "${ENV_NAME}" is replaced with the value
 * of that environment variable at load time (missing variables resolve to "",
 * and features depending on them fail soft or report clearly).
 *
 * See docs/CONFIG.md for the full reference and config.example.json for a
 * working starting point.
 */
import fs from "node:fs";
import path from "node:path";
import { parseDuration, parseSchedule } from "./util.js";

export const DEFAULT_CONFIG_PATH = process.env.SERVER_TOOLS_CONFIG || "./config.json";

/** Recursively substitute "${VAR}" strings from process.env. */
function interpolate(value) {
  if (typeof value === "string") {
    const m = value.match(/^\$\{([A-Z0-9_]+)\}$/);
    if (m) return process.env[m[1]] ?? "";
    return value;
  }
  if (Array.isArray(value)) return value.map(interpolate);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolate(v);
    return out;
  }
  return value;
}

/** Collect human-readable validation problems; empty array = valid. */
export function validateConfig(cfg) {
  const problems = [];
  const need = (cond, msg) => {
    if (!cond) problems.push(msg);
  };

  need(cfg && typeof cfg === "object", "config must be a JSON object");
  if (!cfg || typeof cfg !== "object") return problems;

  need(typeof cfg.dataDir === "string" && cfg.dataDir.length > 0, "dataDir (string) is required");

  for (const [i, c] of (cfg.checks ?? []).entries()) {
    const where = `checks[${i}]`;
    need(typeof c.name === "string" && c.name, `${where}.name is required`);
    need(
      ["http", "tcp", "tls-cert", "disk", "memory", "load", "container", "postgres", "backup-freshness", "command"].includes(c.type),
      `${where}.type "${c.type}" is not a known check type`,
    );
    if (c.interval !== undefined)
      need(parseDuration(c.interval) !== null, `${where}.interval "${c.interval}" is not a duration`);
    if (c.type === "http") need(typeof c.url === "string" && c.url.startsWith("http"), `${where}.url must be an http(s) URL`);
    if (c.type === "tcp") need(typeof c.host === "string" && Number.isInteger(c.port), `${where} needs host + port`);
    if (c.type === "tls-cert") need(typeof c.host === "string", `${where}.host is required`);
    if (c.type === "disk") need(typeof c.path === "string", `${where}.path is required`);
    if (c.type === "container") need(typeof c.container === "string", `${where}.container is required`);
    if (c.type === "postgres") need(typeof c.container === "string", `${where}.container is required`);
    if (c.type === "backup-freshness")
      need(typeof c.target === "string", `${where}.target (backup target name) is required`);
    if (c.type === "command") need(typeof c.command === "string", `${where}.command is required`);
  }

  for (const [i, b] of (cfg.backups ?? []).entries()) {
    const where = `backups[${i}]`;
    need(typeof b.name === "string" && b.name, `${where}.name is required`);
    need(["postgres", "files"].includes(b.type), `${where}.type must be "postgres" or "files"`);
    if (b.schedule !== undefined)
      need(parseSchedule(b.schedule) !== null, `${where}.schedule "${b.schedule}" is not a valid schedule`);
    if (b.type === "postgres") {
      need(typeof b.container === "string", `${where}.container is required (database container name)`);
      need(typeof b.database === "string", `${where}.database is required`);
      need(typeof b.user === "string", `${where}.user is required`);
    }
    if (b.type === "files") need(typeof b.path === "string", `${where}.path is required`);
    if (b.encrypt !== false)
      need(
        typeof b.passphrase === "string" && b.passphrase.length >= 12,
        `${where}.passphrase must be set (>= 12 chars) unless encrypt is false; use "\${ENV_VAR}"`,
      );
    if (b.s3) {
      for (const k of ["bucket", "region", "accessKeyId", "secretAccessKey"]) {
        need(typeof b.s3[k] === "string" && b.s3[k], `${where}.s3.${k} is required when s3 is configured`);
      }
    }
    if (b.retention) {
      for (const k of ["daily", "weekly", "monthly"]) {
        if (b.retention[k] !== undefined)
          need(Number.isInteger(b.retention[k]) && b.retention[k] >= 0, `${where}.retention.${k} must be a non-negative integer`);
      }
    }
  }

  for (const [i, d] of (cfg.deploys ?? []).entries()) {
    const where = `deploys[${i}]`;
    need(typeof d.name === "string" && d.name, `${where}.name is required`);
    need(typeof d.dir === "string" && d.dir, `${where}.dir is required (compose project directory)`);
    need(typeof d.healthUrl === "string" && d.healthUrl.startsWith("http"), `${where}.healthUrl must be an http(s) URL`);
  }

  const hk = cfg.housekeeping ?? {};
  if (hk.schedule !== undefined)
    need(parseSchedule(hk.schedule) !== null, `housekeeping.schedule "${hk.schedule}" is not a valid schedule`);
  if (hk.historyDays !== undefined)
    need(Number.isInteger(hk.historyDays) && hk.historyDays >= 0, "housekeeping.historyDays must be a non-negative integer");
  if (hk.tmpAge !== undefined) need(parseDuration(hk.tmpAge) !== null, `housekeeping.tmpAge "${hk.tmpAge}" is not a duration`);
  if (hk.staleContainerAge !== undefined)
    need(
      parseDuration(hk.staleContainerAge) !== null,
      `housekeeping.staleContainerAge "${hk.staleContainerAge}" is not a duration`,
    );
  if (hk.keepImages !== undefined)
    need(
      Array.isArray(hk.keepImages) && hk.keepImages.every((p) => typeof p === "string" && p),
      "housekeeping.keepImages must be an array of image tag patterns",
    );
  for (const [i, rule] of (hk.clean ?? []).entries()) {
    need(typeof rule.path === "string" && rule.path, `housekeeping.clean[${i}].path is required`);
    if (rule.maxAge !== undefined)
      need(parseDuration(rule.maxAge) !== null, `housekeeping.clean[${i}].maxAge "${rule.maxAge}" is not a duration`);
  }

  const alerts = cfg.alerts ?? {};
  if (alerts.smtp) {
    for (const k of ["host", "from", "to"]) {
      need(alerts.smtp[k], `alerts.smtp.${k} is required when smtp alerting is configured`);
    }
  }
  if (alerts.webhook) need(typeof alerts.webhook.url === "string", "alerts.webhook.url is required");

  const web = cfg.web ?? {};
  if (web.enabled !== false) {
    need(typeof web.baseUrl === "string" && web.baseUrl.startsWith("http"), "web.baseUrl must be set (used in login links)");
    need(Array.isArray(web.allowedEmails) && web.allowedEmails.length > 0, "web.allowedEmails must list at least one login email");
  }

  return problems;
}

/** Fill defaults the rest of the code relies on. */
export function withDefaults(cfg) {
  return {
    dataDir: "./data",
    checkDefaults: { interval: "60s", timeout: "10s", failuresBeforeAlert: 2 },
    checks: [],
    backups: [],
    deploys: [],
    housekeeping: {},
    alerts: {},
    web: { enabled: true, port: 9090, bind: "127.0.0.1", sessionDays: 30 },
    docker: { socketPath: "/var/run/docker.sock" },
    ...cfg,
    web: { enabled: true, port: 9090, bind: "127.0.0.1", sessionDays: 30, ...(cfg.web ?? {}) },
    checkDefaults: { interval: "60s", timeout: "10s", failuresBeforeAlert: 2, ...(cfg.checkDefaults ?? {}) },
    docker: { socketPath: "/var/run/docker.sock", ...(cfg.docker ?? {}) },
  };
}

export function loadConfig(configPath = DEFAULT_CONFIG_PATH) {
  const resolved = path.resolve(configPath);
  let raw;
  try {
    raw = fs.readFileSync(resolved, "utf8");
  } catch {
    throw new Error(`cannot read config file at ${resolved} (set SERVER_TOOLS_CONFIG or create config.json)`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`config file ${resolved} is not valid JSON: ${e.message}`);
  }
  const cfg = withDefaults(interpolate(parsed));
  const problems = validateConfig(cfg);
  if (problems.length) {
    throw new Error(`config file ${resolved} has problems:\n  - ${problems.join("\n  - ")}`);
  }
  return cfg;
}
