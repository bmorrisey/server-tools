/**
 * Health checks. Each check produces a result:
 *   { status: "ok" | "warn" | "fail", detail: string, value?: number, unit?: string }
 *
 * The runner tracks consecutive failures per check and reports state
 * transitions to the alert router: a check only alerts after
 * `failuresBeforeAlert` consecutive failures (no flapping), and sends a
 * recovery notice when it returns to ok.
 *
 * Check types:
 *   http             GET a URL; assert status (default 200-299) and optional
 *                    max latency; optional JSON body assertions
 *   tcp              connect to host:port
 *   tls-cert         days remaining on a host's TLS certificate
 *   disk             used% threshold for a mounted path
 *   memory           host memory used% threshold
 *   load             host load average (1m) per-core threshold
 *   container        docker container running + healthy
 *   postgres         SELECT 1 inside a database container (docker exec)
 *   backup-freshness age of the last successful backup for a target
 *   command          run a command in a container; exit code 0 = ok
 */
import net from "node:net";
import tls from "node:tls";
import { parseDuration, dget, formatDuration, formatBytes } from "./util.js";
import * as metrics from "./metrics.js";
import { logger } from "./log.js";

const log = logger("checks");

async function httpCheck(check, { timeoutMs }) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(check.url, {
      redirect: "manual",
      signal: controller.signal,
      headers: { "user-agent": "server-tools-check" },
    });
    const latency = Date.now() - started;
    const okStatus = check.expectStatus ? res.status === check.expectStatus : res.status >= 200 && res.status < 400;
    if (!okStatus) return { status: "fail", detail: `HTTP ${res.status}`, value: latency, unit: "ms" };
    if (check.expectJson) {
      let body;
      try {
        body = await res.json();
      } catch {
        return { status: "fail", detail: "response is not JSON", value: latency, unit: "ms" };
      }
      for (const [path, expected] of Object.entries(check.expectJson)) {
        const actual = dget(body, path);
        if (actual !== expected)
          return { status: "fail", detail: `json ${path} = ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`, value: latency, unit: "ms" };
      }
    }
    const maxLatency = check.maxLatency ? parseDuration(check.maxLatency) : null;
    if (maxLatency && latency > maxLatency)
      return { status: "warn", detail: `slow: ${latency}ms > ${maxLatency}ms`, value: latency, unit: "ms" };
    return { status: "ok", detail: `HTTP ${res.status} in ${latency}ms`, value: latency, unit: "ms" };
  } catch (e) {
    return { status: "fail", detail: e.name === "AbortError" ? `timeout after ${timeoutMs}ms` : e.message };
  } finally {
    clearTimeout(timer);
  }
}

function tcpCheck(check, { timeoutMs }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const sock = net.connect({ host: check.host, port: check.port });
    const done = (result) => {
      sock.destroy();
      resolve(result);
    };
    sock.setTimeout(timeoutMs, () => done({ status: "fail", detail: `timeout after ${timeoutMs}ms` }));
    sock.on("connect", () => done({ status: "ok", detail: `connected in ${Date.now() - started}ms`, value: Date.now() - started, unit: "ms" }));
    sock.on("error", (e) => done({ status: "fail", detail: e.message }));
  });
}

function tlsCertCheck(check, { timeoutMs }) {
  const warnDays = check.warnDays ?? 21;
  const failDays = check.failDays ?? 7;
  return new Promise((resolve) => {
    const sock = tls.connect(
      { host: check.host, port: check.port ?? 443, servername: check.host, rejectUnauthorized: false },
      () => {
        const cert = sock.getPeerCertificate();
        sock.destroy();
        if (!cert || !cert.valid_to) return resolve({ status: "fail", detail: "no certificate presented" });
        const days = Math.floor((new Date(cert.valid_to).getTime() - Date.now()) / 86_400_000);
        const detail = `expires in ${days}d (${cert.valid_to})`;
        if (days <= failDays) return resolve({ status: "fail", detail, value: days, unit: "days" });
        if (days <= warnDays) return resolve({ status: "warn", detail, value: days, unit: "days" });
        resolve({ status: "ok", detail, value: days, unit: "days" });
      },
    );
    sock.setTimeout(timeoutMs, () => {
      sock.destroy();
      resolve({ status: "fail", detail: `timeout after ${timeoutMs}ms` });
    });
    sock.on("error", (e) => resolve({ status: "fail", detail: e.message }));
  });
}

async function diskCheck(check) {
  const warnPct = check.warnPct ?? 80;
  const failPct = check.failPct ?? 92;
  const d = await metrics.disk(check.path);
  const detail = `${d.usedPct}% used, ${formatBytes(d.freeBytes)} free`;
  if (d.usedPct >= failPct) return { status: "fail", detail, value: d.usedPct, unit: "%" };
  if (d.usedPct >= warnPct) return { status: "warn", detail, value: d.usedPct, unit: "%" };
  return { status: "ok", detail, value: d.usedPct, unit: "%" };
}

function memoryCheck(check) {
  const warnPct = check.warnPct ?? 85;
  const failPct = check.failPct ?? 95;
  const m = metrics.memory();
  const detail = `${m.usedPct}% used, ${formatBytes(m.availableBytes)} available`;
  if (m.usedPct >= failPct) return { status: "fail", detail, value: m.usedPct, unit: "%" };
  if (m.usedPct >= warnPct) return { status: "warn", detail, value: m.usedPct, unit: "%" };
  return { status: "ok", detail, value: m.usedPct, unit: "%" };
}

function loadCheck(check) {
  const warnPerCore = check.warnPerCore ?? 1.5;
  const failPerCore = check.failPerCore ?? 3;
  const l = metrics.load();
  const perCore = l.m1 / Math.max(l.cores, 1);
  const detail = `load ${l.m1.toFixed(2)} on ${l.cores} cores (${perCore.toFixed(2)}/core)`;
  if (perCore >= failPerCore) return { status: "fail", detail, value: perCore };
  if (perCore >= warnPerCore) return { status: "warn", detail, value: perCore };
  return { status: "ok", detail, value: perCore };
}

async function containerCheck(check, { docker }) {
  const c = await docker.findContainer(check.container);
  if (!c) return { status: "fail", detail: `container "${check.container}" not found` };
  const state = c.State ?? {};
  if (!state.Running) return { status: "fail", detail: `not running (${state.Status})` };
  const health = state.Health?.Status;
  if (health && health !== "healthy") {
    return { status: health === "starting" ? "warn" : "fail", detail: `health: ${health}` };
  }
  const startedMs = Date.parse(state.StartedAt);
  const up = Number.isFinite(startedMs) ? formatDuration(Date.now() - startedMs) : "?";
  return { status: "ok", detail: `running${health ? " + healthy" : ""}, up ${up}` };
}

async function postgresCheck(check, { docker, timeoutMs }) {
  const user = check.user ?? "postgres";
  const database = check.database ?? user;
  try {
    const r = await docker.exec(check.container, ["psql", "-U", user, "-d", database, "-tAc", "SELECT 1"], {
      timeoutMs,
    });
    if (r.exitCode === 0 && r.stdout.trim() === "1") return { status: "ok", detail: "SELECT 1 ok" };
    return { status: "fail", detail: `psql exit ${r.exitCode}: ${(r.stderr || r.stdout).trim().slice(0, 200)}` };
  } catch (e) {
    return { status: "fail", detail: e.message };
  }
}

function backupFreshnessCheck(check, { store }) {
  const warnAfter = parseDuration(check.warnAfter ?? "26h");
  const failAfter = parseDuration(check.failAfter ?? "50h");
  const state = store.readState("backups", {});
  const last = state[check.target]?.lastSuccess;
  if (!last) return { status: "fail", detail: `no successful backup recorded for "${check.target}"` };
  const age = Date.now() - Date.parse(last);
  const detail = `last success ${formatDuration(age)} ago`;
  if (age >= failAfter) return { status: "fail", detail, value: Math.round(age / 3_600_000), unit: "h" };
  if (age >= warnAfter) return { status: "warn", detail, value: Math.round(age / 3_600_000), unit: "h" };
  return { status: "ok", detail, value: Math.round(age / 3_600_000), unit: "h" };
}

async function commandCheck(check, { docker, timeoutMs }) {
  try {
    const r = await docker.exec(check.container, ["sh", "-c", check.command], { timeoutMs });
    const out = (r.stdout || r.stderr).trim().slice(0, 200);
    if (r.exitCode !== 0) return { status: "fail", detail: `exit ${r.exitCode}: ${out}` };
    // Optional numeric threshold on the command's output (e.g. queue depth).
    if (check.warnAbove !== undefined || check.failAbove !== undefined) {
      const value = Number(r.stdout.trim());
      if (!Number.isFinite(value)) return { status: "fail", detail: `output not numeric: ${out}` };
      if (check.failAbove !== undefined && value > check.failAbove)
        return { status: "fail", detail: `${value} > ${check.failAbove}`, value };
      if (check.warnAbove !== undefined && value > check.warnAbove)
        return { status: "warn", detail: `${value} > ${check.warnAbove}`, value };
      return { status: "ok", detail: `${value}`, value };
    }
    return { status: "ok", detail: out || "exit 0" };
  } catch (e) {
    return { status: "fail", detail: e.message };
  }
}

const RUNNERS = {
  http: httpCheck,
  tcp: tcpCheck,
  "tls-cert": tlsCertCheck,
  disk: diskCheck,
  memory: memoryCheck,
  load: loadCheck,
  container: containerCheck,
  postgres: postgresCheck,
  "backup-freshness": backupFreshnessCheck,
  command: commandCheck,
};

/** Run a single check definition once. Never throws. */
export async function runCheck(check, ctx) {
  const timeoutMs = parseDuration(check.timeout ?? ctx.defaults?.timeout ?? "10s");
  try {
    return await RUNNERS[check.type](check, { ...ctx, timeoutMs });
  } catch (e) {
    return { status: "fail", detail: `check crashed: ${e.message}` };
  }
}

/**
 * Stateful runner for the agent: runs all configured checks on their
 * intervals, persists results, and emits alert-worthy transitions.
 */
export class CheckEngine {
  constructor({ config, store, docker, onTransition }) {
    this.config = config;
    this.store = store;
    this.docker = docker;
    this.onTransition = onTransition ?? (() => {});
    this.runtime = new Map(); // name -> { consecutiveFails, alerted, last }
  }

  /** Consecutive-failure gating; returns a transition event or null. */
  evaluateTransition(name, result, threshold) {
    const rt = this.runtime.get(name) ?? { consecutiveFails: 0, alerted: false };
    if (result.status === "fail") {
      rt.consecutiveFails++;
      if (!rt.alerted && rt.consecutiveFails >= threshold) {
        rt.alerted = true;
        this.runtime.set(name, rt);
        return { kind: "fail", name, result };
      }
    } else {
      const wasAlerted = rt.alerted;
      rt.consecutiveFails = 0;
      rt.alerted = false;
      this.runtime.set(name, rt);
      if (wasAlerted) return { kind: "recover", name, result };
    }
    this.runtime.set(name, rt);
    return null;
  }

  async runOne(check) {
    const result = await runCheck(check, {
      docker: this.docker,
      store: this.store,
      defaults: this.config.checkDefaults,
    });
    const threshold = check.failuresBeforeAlert ?? this.config.checkDefaults.failuresBeforeAlert;

    // Persist latest state + history sample.
    const states = this.store.readState("checks", {});
    states[check.name] = { ...result, type: check.type, at: new Date().toISOString() };
    this.store.writeState("checks", states);
    this.store.append("checks", { name: check.name, status: result.status, value: result.value ?? null, detail: result.detail });

    const transition = this.evaluateTransition(check.name, result, threshold);
    if (transition) {
      log.info(`${transition.kind === "fail" ? "ALERT" : "RECOVERED"}: ${check.name} - ${result.detail}`);
      this.store.append("events", {
        topic: "check",
        kind: transition.kind,
        name: check.name,
        detail: result.detail,
      });
      await this.onTransition(transition, check);
    }
    return result;
  }
}
