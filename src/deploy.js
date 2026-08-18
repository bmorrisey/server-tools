/**
 * Safe deploy helper for compose-managed applications.
 *
 * Two source modes, chosen per target with `"source"`:
 *
 *   git (default)  record current ref -> fetch -> checkout -> compose up
 *                  --build -> poll health -> on failure check the previous
 *                  ref back out and rebuild. The working tree IS the
 *                  deployment. Simple, and fine on a box that runs one app.
 *
 *   registry       pull an already-built image by tag -> write the image
 *                  reference into the target's .env -> compose up --no-build
 *                  -> prove the named services are running that exact image
 *                  -> poll health -> on failure re-point the tag and repeat.
 *                  Nothing compiles on the box, so a deploy cannot starve the
 *                  other stacks sharing it, and a rollback is a pull rather
 *                  than a second build.
 *
 * Three details in registry mode that look optional and are not:
 *
 *   1. The image reference is WRITTEN to `.env`, not exported for one
 *      command. Compose keeps no such state, so the next plain
 *      `docker compose up -d` would re-resolve the variable's default and
 *      silently recreate everything on whatever tag that names.
 *   2. Verification compares each container's image ID to the ID that was
 *      pulled and requires state "running". `compose ps -q` lists only
 *      running containers, so a service whose replicas all crash-loop comes
 *      back as an empty list, which reads like "no such service" rather than
 *      like failure. We list with `-a` and look at the state.
 *   3. The compose project name is required rather than defaulted: a bare
 *      `docker compose` on a host with several stacks acts on a project
 *      derived from the directory, which is not necessarily the project the
 *      operator meant, and only errors if ports happen to collide.
 *
 * The deploy target's directory is bind-mounted into the agent container (or
 * the CLI runs on the host) - see DEPLOY.md.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { parseDuration } from "./util.js";
import { safeRef } from "./docker.js";
import { logger } from "./log.js";

const log = logger("deploy");

const DEFAULT_IMAGE_ENV_VAR = "APP_IMAGE";

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

/**
 * Compose invocation for a target. `-p` is passed whenever the target names a
 * project so that every command in a deploy acts on the same stack, whichever
 * directory the caller happens to be in.
 */
export function composeArgs(target, subcommand) {
  const args = ["compose", "--project-directory", target.dir];
  if (target.project) args.push("-p", target.project);
  return [...args, ...subcommand];
}

async function compose(target, subcommand, { timeoutMs = 30 * 60_000 } = {}) {
  const r = await run("docker", composeArgs(target, subcommand), { cwd: target.dir, timeoutMs });
  if (r.code !== 0) {
    throw new Error(`docker compose ${subcommand[0]} failed: ${(r.stderr || r.stdout).slice(-500)}`);
  }
  return r.stdout;
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

/* -------------------------------------------------------------------------
 * .env editing
 *
 * Compose reads `.env` beside the project; it is the only place an image
 * reference survives the next `docker compose up`. Editing it has to leave
 * every other line exactly as it was, because that file is also where the
 * application's own secrets live.
 * ---------------------------------------------------------------------- */

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function envKeyOf(line) {
  const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
  return m ? m[1] : null;
}

/** Value of `key` in a .env file body, or null. Last assignment wins. */
export function readEnvVar(text, key) {
  const lines = String(text ?? "").split("\n");
  let value = null;
  for (const line of lines) {
    if (envKeyOf(line) !== key) continue;
    let raw = line.slice(line.indexOf("=") + 1).trim();
    if (raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))) {
      raw = raw.slice(1, -1);
    }
    value = raw;
  }
  return value;
}

/**
 * Set `key` to `value` in a .env file body, preserving every other line.
 * Earlier duplicate assignments of the same key are removed so the result
 * cannot depend on which one the reader honours.
 */
export function upsertEnvVar(text, key, value) {
  if (!ENV_KEY_RE.test(String(key))) throw new Error(`invalid environment variable name: ${JSON.stringify(key)}`);
  const v = String(value);
  if (/[\n\r]/.test(v)) throw new Error(`refusing to write a multi-line value for ${key}`);

  const lines = String(text ?? "").split("\n");
  const hits = [];
  for (const [i, line] of lines.entries()) {
    if (envKeyOf(line) === key) hits.push(i);
  }
  if (!hits.length) {
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    lines.push(`${key}=${v}`, "");
    return lines.join("\n");
  }
  const last = hits[hits.length - 1];
  lines[last] = `${key}=${v}`;
  const drop = new Set(hits.slice(0, -1));
  return lines.filter((_, i) => !drop.has(i)).join("\n");
}

async function readEnvFile(envPath) {
  try {
    return await fsp.readFile(envPath, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return "";
    throw new Error(`cannot read ${envPath}: ${e.message}`);
  }
}

/** Rewrite .env atomically so a crash mid-write cannot truncate app secrets. */
async function writeEnvFile(envPath, text) {
  const tmp = `${envPath}.server-tools.tmp`;
  await fsp.writeFile(tmp, text);
  await fsp.rename(tmp, envPath);
}

/* -------------------------------------------------------------------------
 * Proving what is running
 * ---------------------------------------------------------------------- */

/**
 * Parse `docker inspect --format '{{.Id}}\t{{.Image}}\t{{.State.Status}}\t{{.Name}}'`
 * output into container records. Malformed lines are ignored; missing
 * containers simply produce no line, which the caller reports as a problem.
 */
export function parseInspectLines(stdout) {
  return String(stdout ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split("\t"))
    .filter((parts) => parts.length >= 3)
    .map(([id, image, status, name = ""]) => ({ id, image, status, name: name.replace(/^\//, "") }));
}

const short = (id) => String(id ?? "").replace(/^sha256:/, "").slice(0, 12) || "?";

/**
 * Decide whether the containers backing each service are actually running,
 * and (when an image ID is given) running that exact image.
 *
 * `entries` is [{ service, containers: [{ id, image, status, name }] }].
 * A service with no containers is a failure, not an absence: that is what a
 * service whose every replica died on boot looks like.
 */
export function verifyContainers(entries, { imageId = null } = {}) {
  const problems = [];
  for (const { service, containers } of entries) {
    if (!containers?.length) {
      problems.push(`service "${service}" has no container`);
      continue;
    }
    for (const c of containers) {
      const who = `${service}/${c.name || short(c.id)}`;
      if (c.status !== "running") {
        problems.push(`${who} is ${c.status || "gone"}`);
        continue;
      }
      if (imageId && c.image !== imageId) {
        problems.push(`${who} runs image ${short(c.image)}, expected ${short(imageId)}`);
      }
    }
  }
  return { ok: problems.length === 0, problems };
}

/** Collect the containers compose has for each named service. */
async function inspectServices(target, services) {
  const entries = [];
  for (const service of services) {
    const ps = await run("docker", composeArgs(target, ["ps", "-a", "-q", service]), {
      cwd: target.dir,
      timeoutMs: 60_000,
    });
    if (ps.code !== 0) throw new Error(`docker compose ps failed: ${(ps.stderr || ps.stdout).slice(-300)}`);
    const ids = ps.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!ids.length) {
      entries.push({ service, containers: [] });
      continue;
    }
    const inspect = await run(
      "docker",
      ["inspect", "--format", "{{.Id}}\t{{.Image}}\t{{.State.Status}}\t{{.Name}}", ...ids.map(safeRef)],
      { timeoutMs: 60_000 },
    );
    entries.push({ service, containers: parseInspectLines(inspect.stdout) });
  }
  return entries;
}

/* -------------------------------------------------------------------------
 * Registry mode
 * ---------------------------------------------------------------------- */

/** Full image reference for a tag, validated for use as a command argument. */
export function imageRef(image, tag) {
  const t = String(tag ?? "").trim();
  if (!t) throw new Error("a tag is required");
  const ref = t.startsWith("sha256:") ? `${image}@${t}` : `${image}:${t}`;
  return safeRef(ref);
}

async function pullImage(ref, { allowLocal = false } = {}) {
  const pull = await run("docker", ["pull", safeRef(ref)], { timeoutMs: 30 * 60_000 });
  if (pull.code !== 0) {
    const local = await run("docker", ["image", "inspect", "--format", "{{.Id}}", safeRef(ref)], { timeoutMs: 60_000 });
    if (!(allowLocal && local.code === 0)) {
      throw new Error(`docker pull ${ref} failed: ${(pull.stderr || pull.stdout).slice(-300)}`);
    }
    log.warn(`pull of ${ref} failed but the image is present locally; continuing`);
    return local.stdout.trim();
  }
  const id = await run("docker", ["image", "inspect", "--format", "{{.Id}}", safeRef(ref)], { timeoutMs: 60_000 });
  if (id.code !== 0 || !id.stdout.trim()) {
    throw new Error(`pulled ${ref} but could not read its image ID: ${(id.stderr || id.stdout).slice(-200)}`);
  }
  return id.stdout.trim();
}

/**
 * Point the stack at `ref` and bring it up without building, then prove the
 * named services are running that image. Returns the pulled image ID.
 */
async function applyImage(target, ref, { envPath, envVar, allowLocal = false }) {
  const imageId = await pullImage(ref, { allowLocal });
  const before = await readEnvFile(envPath);
  await writeEnvFile(envPath, upsertEnvVar(before, envVar, ref));
  await compose(target, ["up", "-d", "--no-build"], { timeoutMs: 15 * 60_000 });
  const verify = verifyContainers(await inspectServices(target, target.services), { imageId });
  if (!verify.ok) throw new Error(`services are not running ${ref}: ${verify.problems.join("; ")}`);
  return imageId;
}

async function deployRegistry(target, tag, { store, dryRun }) {
  const envVar = target.imageEnvVar ?? DEFAULT_IMAGE_ENV_VAR;
  const envPath = path.join(target.dir, ".env");
  const previous = readEnvVar(await readEnvFile(envPath), envVar);
  const to = imageRef(target.image, tag);
  const from = previous ?? "(unset)";

  log.info(`deploy ${target.name}: ${from} -> ${to}${dryRun ? " (dry run)" : ""}`);
  if (dryRun) {
    return { ok: true, from, to, rolledBack: false, detail: `dry run - would pull ${to} and recreate ${target.services.join(", ")}` };
  }

  const record = recorder(store, target, from, to, "registry");

  let imageId;
  try {
    imageId = await applyImage(target, to, { envPath, envVar });
  } catch (e) {
    return rollbackRegistry(target, {
      record,
      envPath,
      envVar,
      previous,
      from,
      to,
      reason: e.message,
      what: "rollout",
    });
  }

  const health = await waitHealthy(target.healthUrl, healthWaitFor(target));
  if (!health.healthy) {
    return rollbackRegistry(target, {
      record,
      envPath,
      envVar,
      previous,
      from,
      to,
      reason: health.lastError,
      what: "health check",
    });
  }

  record("ok", `${from} -> ${to} (image ${short(imageId)}), healthy after ${health.tries} checks`);
  log.info(`deploy ${target.name} ok: ${to} running and healthy`);
  return { ok: true, from, to, rolledBack: false, detail: `running ${short(imageId)}, healthy after ${health.tries} checks` };
}

/**
 * Re-point the tag at whatever was there before and bring the stack back.
 * With no previous reference recorded there is nothing to roll back to, and
 * saying so is more useful than guessing at a tag.
 */
async function rollbackRegistry(target, { record, envPath, envVar, previous, from, to, reason, what }) {
  const why = `${what} failed on ${to} (${String(reason).slice(0, 200)})`;
  if (!previous) {
    log.error(`${what} failed for ${target.name} and no previous image is recorded in .env; leaving it as is`);
    record("fail", `${why}; no previous image recorded in ${envVar}, so nothing to roll back to - intervene`);
    return {
      ok: false,
      from,
      to,
      rolledBack: false,
      detail: `${why}; no previous image recorded in ${envVar} - intervene`,
    };
  }

  log.error(`${what} failed for ${target.name}; rolling back to ${previous}`);
  try {
    // The previous image may have been pruned since; a local copy is enough.
    await applyImage(target, previous, { envPath, envVar, allowLocal: true });
  } catch (e) {
    record("rollback", `${why}; rollback to ${previous} ALSO FAILED (${e.message.slice(0, 200)}) - intervene`);
    return {
      ok: false,
      from,
      to,
      rolledBack: true,
      detail: `${why}; rollback to ${previous} also failed: ${e.message.slice(0, 200)} - intervene`,
    };
  }
  const health = await waitHealthy(target.healthUrl, healthWaitFor(target));
  record("rollback", `${why}; rolled back to ${previous} (${health.healthy ? "healthy" : "STILL UNHEALTHY"})`);
  return {
    ok: false,
    from,
    to,
    rolledBack: true,
    detail: `${why}; rolled back to ${previous}, now ${health.healthy ? "healthy" : "STILL UNHEALTHY - intervene"}`,
  };
}

/* -------------------------------------------------------------------------
 * Git mode (build on the box)
 * ---------------------------------------------------------------------- */

async function deployGit(target, ref, { store, dryRun }) {
  const dir = target.dir;
  const from = (await git(dir, "rev-parse", "--short", "HEAD")).trim();
  const fromRef = (await git(dir, "describe", "--tags", "--always").catch(() => from)).trim?.() ?? from;
  log.info(`deploy ${target.name}: ${fromRef} -> ${ref}${dryRun ? " (dry run)" : ""}`);
  if (dryRun) return { ok: true, from: fromRef, to: ref, rolledBack: false, detail: "dry run - no changes" };

  const dirty = await git(dir, "status", "--porcelain");
  if (dirty.trim()) throw new Error(`working tree at ${dir} has local changes; refusing to deploy over them`);

  await git(dir, "fetch", "origin", "--tags", "--prune");
  await git(dir, "checkout", ref);

  const record = recorder(store, target, fromRef, ref, "git");
  const build = () => compose(target, ["up", "-d", "--build"]);

  try {
    await build();
    // A build leaves the previous containers up and healthy the whole time, so
    // health polling alone cannot tell a rollout from a no-op. When the target
    // names its services, require them to be running before believing it.
    if (target.services?.length) {
      const verify = verifyContainers(await inspectServices(target, target.services));
      if (!verify.ok) throw new Error(`services did not come up: ${verify.problems.join("; ")}`);
    }
  } catch (e) {
    log.error(`build/up failed for ${target.name}; rolling back to ${from}`);
    await git(dir, "checkout", from);
    await build().catch((e2) => log.error(`rollback build also failed: ${e2.message}`));
    record("rollback", `build failed (${e.message.slice(0, 200)}); rolled back to ${fromRef}`);
    return { ok: false, from: fromRef, to: ref, rolledBack: true, detail: `build failed: ${e.message.slice(0, 300)}` };
  }

  const health = await waitHealthy(target.healthUrl, healthWaitFor(target));
  if (!health.healthy) {
    log.error(`health check failed after deploy of ${target.name}; rolling back to ${from}`);
    await git(dir, "checkout", from);
    await build().catch((e2) => log.error(`rollback build failed: ${e2.message}`));
    const rollbackHealth = await waitHealthy(target.healthUrl, healthWaitFor(target));
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

/* ---------------------------------------------------------------------- */

function healthWaitFor(target) {
  return {
    attempts: target.healthAttempts ?? 20,
    delayMs: parseDuration(target.healthDelay ?? "6s"),
  };
}

/** Event + state recorder shared by both modes. */
function recorder(store, target, from, to, source) {
  return (kind, detail) => {
    store?.append("events", { topic: "deploy", kind, name: target.name, detail });
    const state = store?.readState("deploys", {}) ?? {};
    state[target.name] = { at: new Date().toISOString(), from, to, kind, detail, source };
    store?.writeState("deploys", state);
  };
}

/**
 * Deploy `ref` for a configured target: a git tag/branch/sha in git mode, an
 * image tag in registry mode. Returns { ok, from, to, rolledBack, detail }.
 */
export async function deploy(target, ref, { store, dryRun = false } = {}) {
  return target.source === "registry"
    ? deployRegistry(target, ref, { store, dryRun })
    : deployGit(target, ref, { store, dryRun });
}
