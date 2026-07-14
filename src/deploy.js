/**
 * Safe deploy helper for a compose-managed application checked out from git.
 *
 * Flow: record current ref -> fetch tags -> checkout requested ref ->
 * `docker compose up -d --build` -> poll the app's health URL -> on failure,
 * check out the previous ref, rebuild, and report the rollback.
 *
 * Assumes the application repo deploys the way a tagged single-box app
 * usually does: the working tree IS the deployment, and the compose build
 * uses it. The deploy target's directory is bind-mounted into the agent
 * container (or the CLI runs on the host) - see DEPLOY.md.
 */
import { spawn } from "node:child_process";
import { parseDuration } from "./util.js";
import { logger } from "./log.js";

const log = logger("deploy");

function run(cmd, args, { cwd, timeoutMs = 15 * 60_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: "", stderr: e.message });
    });
  });
}

async function git(dir, ...args) {
  const r = await run("git", ["-C", dir, ...args]);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.slice(0, 300)}`);
  return r.stdout;
}

async function composeUp(dir) {
  const r = await run("docker", ["compose", "--project-directory", dir, "up", "-d", "--build"], {
    cwd: dir,
    timeoutMs: 30 * 60_000,
  });
  if (r.code !== 0) throw new Error(`docker compose up failed: ${r.stderr.slice(-500)}`);
}

/** Poll a health URL until healthy or attempts exhausted. */
export async function waitHealthy(url, { attempts = 20, delayMs = 6000, timeoutMs = 8000 } = {}) {
  let lastError = "";
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
      if (res.ok) return { healthy: true, tries: i + 1 };
      lastError = `HTTP ${res.status}`;
    } catch (e) {
      lastError = e.message;
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return { healthy: false, tries: attempts, lastError };
}

/**
 * Deploy `ref` (tag/branch/sha) for a configured target.
 * Returns { ok, from, to, rolledBack, detail }.
 */
export async function deploy(target, ref, { store, dryRun = false } = {}) {
  const dir = target.dir;
  const healthWait = {
    attempts: target.healthAttempts ?? 20,
    delayMs: parseDuration(target.healthDelay ?? "6s"),
  };

  const from = (await git(dir, "rev-parse", "--short", "HEAD")).trim();
  const fromRef = (await git(dir, "describe", "--tags", "--always").catch(() => from)).trim?.() ?? from;
  log.info(`deploy ${target.name}: ${fromRef} -> ${ref}${dryRun ? " (dry run)" : ""}`);
  if (dryRun) return { ok: true, from: fromRef, to: ref, rolledBack: false, detail: "dry run - no changes" };

  const dirty = await git(dir, "status", "--porcelain");
  if (dirty.trim()) throw new Error(`working tree at ${dir} has local changes; refusing to deploy over them`);

  await git(dir, "fetch", "origin", "--tags", "--prune");
  await git(dir, "checkout", ref);

  const record = (kind, detail) => {
    store?.append("events", { topic: "deploy", kind, name: target.name, detail });
    const state = store?.readState("deploys", {}) ?? {};
    state[target.name] = { at: new Date().toISOString(), from: fromRef, to: ref, kind, detail };
    store?.writeState("deploys", state);
  };

  try {
    await composeUp(dir);
  } catch (e) {
    log.error(`build/up failed for ${target.name}; rolling back to ${from}`);
    await git(dir, "checkout", from);
    await composeUp(dir).catch((e2) => log.error(`rollback build also failed: ${e2.message}`));
    record("rollback", `build failed (${e.message.slice(0, 200)}); rolled back to ${fromRef}`);
    return { ok: false, from: fromRef, to: ref, rolledBack: true, detail: `build failed: ${e.message.slice(0, 300)}` };
  }

  const health = await waitHealthy(target.healthUrl, healthWait);
  if (!health.healthy) {
    log.error(`health check failed after deploy of ${target.name}; rolling back to ${from}`);
    await git(dir, "checkout", from);
    await composeUp(dir).catch((e2) => log.error(`rollback build failed: ${e2.message}`));
    const rollbackHealth = await waitHealthy(target.healthUrl, healthWait);
    record(
      "rollback",
      `health failed on ${ref} (${health.lastError}); rolled back to ${fromRef} (${rollbackHealth.healthy ? "healthy" : "STILL UNHEALTHY"})`,
    );
    return {
      ok: false,
      from: fromRef,
      to: ref,
      rolledBack: true,
      detail: `health check failed (${health.lastError}); rolled back, now ${rollbackHealth.healthy ? "healthy" : "STILL UNHEALTHY - intervene"}`,
    };
  }

  record("ok", `${fromRef} -> ${ref}, healthy after ${health.tries} checks`);
  log.info(`deploy ${target.name} ok: ${ref} healthy`);
  return { ok: true, from: fromRef, to: ref, rolledBack: false, detail: `healthy after ${health.tries} checks` };
}
