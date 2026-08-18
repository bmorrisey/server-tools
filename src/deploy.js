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
 *                  -> poll health -> prove it again -> on failure put .env
 *                  back exactly as it was and bring the stack back on it.
 *                  Nothing compiles on the box, so a deploy cannot starve the
 *                  other stacks sharing it, and a rollback is a pull rather
 *                  than a second build.
 *
 * Three details in registry mode that look optional and are not:
 *
 *   1. The image reference is WRITTEN to `.env`, not exported for one
 *      command. Compose keeps no such state, so the next plain
 *      `docker compose up -d` would re-resolve the variable's default and
 *      silently recreate everything on whatever tag that names. The flip
 *      side is that a failed deploy must put the file back, or the same
 *      persistence redeploys the broken tag later.
 *   2. Verification compares each container's image ID to the ID that was
 *      pulled and requires state "running". `compose ps -q` lists only
 *      running containers, so a service whose replicas all crash-loop comes
 *      back as an empty list, which reads like "no such service" rather than
 *      like failure. We list with -a, look at the state, and look again
 *      after health polling, because a container that dies four seconds in
 *      is still "running" the moment `up` returns.
 *   3. The compose project name is required rather than defaulted: a bare
 *      `docker compose` on a host with several stacks acts on a project
 *      derived from the directory, which is not necessarily the project the
 *      operator meant, and only errors if ports happen to collide.
 *
 * Every failure path distinguishes "nothing was changed" from "changed and
 * put back", because those call for very different reactions at 3am.
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

/**
 * Run a process and collect its output. Injectable through the options bag so
 * the deploy sequence can be driven in tests without a Docker daemon; the
 * order of these calls is most of what can go wrong here.
 */
function run(cmd, args, { cwd, env, timeoutMs = 15 * 60_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code: timedOut ? -1 : code,
        stdout: stdout.trim(),
        stderr: timedOut ? `timed out after ${timeoutMs}ms` : stderr.trim(),
      });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: "", stderr: e.message });
    });
  });
}

async function git(exec, dir, ...args) {
  const r = await exec("git", ["-C", dir, ...args]);
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

/**
 * Environment for a compose command.
 *
 * Compose interpolates from the process environment in preference to `.env`.
 * The agent's environment is where every secret the toolkit's own config
 * references lives (backup passphrase, S3 keys, SMTP password), so inheriting
 * it wholesale means a name collision silently overrides the application's
 * own value with one of ours and injects it into the deployed containers - and
 * it would also outrank the image reference we just wrote to `.env`, making
 * that write pointless. So compose gets only what it needs to talk to Docker.
 * Everything the application needs comes from its own `.env`, which is the
 * documented contract.
 */
const COMPOSE_PASSTHROUGH = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "TZ",
  "DOCKER_HOST",
  "DOCKER_CONFIG",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CONTEXT",
  "SSH_AUTH_SOCK",
];

function composeEnv() {
  const env = {};
  for (const key of COMPOSE_PASSTHROUGH) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

async function compose(exec, target, subcommand, { timeoutMs = 30 * 60_000 } = {}) {
  const r = await exec("docker", composeArgs(target, subcommand), {
    cwd: target.dir,
    env: composeEnv(),
    timeoutMs,
  });
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
 * application's own secrets live - which is equally why the rewrite keeps the
 * file's mode and owner instead of handing it whatever the umask says.
 * ---------------------------------------------------------------------- */

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_LINE_RE = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)\s*=/;

function envKeyOf(line) {
  return line.match(ENV_LINE_RE)?.[2] ?? null;
}

/**
 * Value of `key` in a .env file body, or null. Last assignment wins.
 *
 * Quotes and a trailing `# comment` are stripped the way compose's own
 * dotenv reader strips them. Getting this wrong is not cosmetic: the value
 * read here is the reference a rollback deploys, so an annotated line would
 * otherwise turn a routine auto-rollback into a manual incident.
 */
export function readEnvVar(text, key) {
  const lines = String(text ?? "").split("\n");
  let value = null;
  for (const line of lines) {
    if (envKeyOf(line) !== key) continue;
    value = parseEnvValue(line.slice(line.indexOf("=") + 1));
  }
  return value;
}

function parseEnvValue(raw) {
  const s = String(raw).trim();
  const quote = s[0];
  if (quote === '"' || quote === "'") {
    const end = s.indexOf(quote, 1);
    if (end > 0) return s.slice(1, end);
    return s.slice(1);
  }
  // An unquoted value ends at a whitespace-preceded "#".
  return s.replace(/\s+#.*$/, "").trim();
}

/**
 * Set `key` to `value` in a .env file body, preserving every other line.
 * Earlier duplicate assignments of the same key are removed so the result
 * cannot depend on which one the reader honours, and an `export ` prefix is
 * kept: that file is often sourced by a start script as well as read by
 * compose, and there the prefix is what makes the variable reach the app.
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
  const prefix = lines[last].match(ENV_LINE_RE)?.[1] ?? "";
  lines[last] = `${prefix}${key}=${v}`;
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

/**
 * Rewrite .env atomically, keeping its mode and owner. Without that, the
 * replacement lands with the agent's umask and an 0600 file full of the
 * application's secrets becomes world-readable.
 */
async function writeEnvFile(envPath, text) {
  const st = await fsp.stat(envPath).catch(() => null);
  const mode = st ? st.mode & 0o777 : 0o600;
  const tmp = `${envPath}.server-tools.tmp`;
  try {
    await fsp.writeFile(tmp, text, { mode });
    // writeFile only applies mode when it creates the file; a leftover temp
    // from an earlier crash would otherwise keep its old permissions.
    await fsp.chmod(tmp, mode);
    if (st) await fsp.chown(tmp, st.uid, st.gid).catch(() => {});
    await fsp.rename(tmp, envPath);
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    throw new Error(`cannot write ${envPath}: ${e.message}`);
  }
}

/* -------------------------------------------------------------------------
 * Proving what is running
 * ---------------------------------------------------------------------- */

const INSPECT_FORMAT = "{{.Id}}\t{{.Image}}\t{{.State.Status}}\t{{.Name}}";

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

/**
 * A failure to ask the question, as opposed to an unwelcome answer.
 *
 * These two must not be confused. Reporting a daemon hiccup as "no
 * containers" would blame the new release for it and roll a working deploy
 * back; a read-only verification step should never be able to cause a write.
 */
function unverifiable(message) {
  const e = new Error(`could not verify services: ${message}`);
  e.unverifiable = true;
  return e;
}

/**
 * Collect the containers compose has for each named service.
 *
 * A docker call that fails, or that returns fewer containers than compose
 * just listed, is unverifiable rather than an empty result.
 */
async function inspectServices(exec, target, services) {
  const entries = [];
  for (const service of services) {
    const ps = await exec("docker", composeArgs(target, ["ps", "-a", "-q", service]), {
      cwd: target.dir,
      env: composeEnv(),
      timeoutMs: 60_000,
    });
    if (ps.code !== 0) throw unverifiable(`docker compose ps failed: ${(ps.stderr || ps.stdout).slice(-300)}`);
    const ids = ps.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!ids.length) {
      entries.push({ service, containers: [] });
      continue;
    }
    const inspect = await exec("docker", ["inspect", "--format", INSPECT_FORMAT, ...ids.map(safeRef)], {
      timeoutMs: 60_000,
    });
    if (inspect.code !== 0) {
      throw unverifiable(`docker inspect failed: ${(inspect.stderr || inspect.stdout).slice(-300)}`);
    }
    const containers = parseInspectLines(inspect.stdout);
    if (containers.length !== ids.length) {
      throw unverifiable(`inspected ${containers.length} of ${ids.length} containers for service "${service}"`);
    }
    entries.push({ service, containers });
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

async function pullImage(exec, ref, { allowLocal = false } = {}) {
  const inspect = () => exec("docker", ["image", "inspect", "--format", "{{.Id}}", safeRef(ref)], { timeoutMs: 60_000 });
  const pull = await exec("docker", ["pull", safeRef(ref)], { timeoutMs: 30 * 60_000 });
  if (pull.code !== 0) {
    const local = await inspect();
    if (!(allowLocal && local.code === 0 && local.stdout.trim())) {
      throw new Error(`docker pull ${ref} failed: ${(pull.stderr || pull.stdout).slice(-300)}`);
    }
    log.warn(`pull of ${ref} failed but the image is present locally; continuing`);
    return local.stdout.trim();
  }
  const id = await inspect();
  if (id.code !== 0 || !id.stdout.trim()) {
    throw new Error(`pulled ${ref} but could not read its image ID: ${(id.stderr || id.stdout).slice(-200)}`);
  }
  return id.stdout.trim();
}

/**
 * Recreate the stack on whatever `.env` currently names, and prove the named
 * services are running the image that was pulled for it. The caller writes
 * `.env` and pulls first, so reaching this function is the moment the box
 * starts changing.
 */
async function bringUp(exec, target, ref, imageId) {
  await compose(exec, target, ["up", "-d", "--no-build"], { timeoutMs: 15 * 60_000 });
  const verify = verifyContainers(await inspectServices(exec, target, target.services), { imageId });
  if (!verify.ok) throw new Error(`services are not running ${ref}: ${verify.problems.join("; ")}`);
}

async function deployRegistry(target, tag, { store, dryRun, exec, health }) {
  const envVar = target.imageEnvVar ?? DEFAULT_IMAGE_ENV_VAR;
  const envPath = path.join(target.dir, ".env");
  const to = imageRef(target.image, tag);

  // A directory that is not visible to the agent produces a chain of
  // misleading symptoms later; say so here instead.
  const dir = await fsp.stat(target.dir).catch(() => null);
  if (!dir?.isDirectory()) {
    throw new Error(`deploy target directory ${target.dir} is not visible here; bind-mount it into the agent`);
  }

  const envText = await readEnvFile(envPath);
  const previous = readEnvVar(envText, envVar);
  const from = previous ?? "(unset)";

  log.info(`deploy ${target.name}: ${from} -> ${to}${dryRun ? " (dry run)" : ""}`);
  if (dryRun) {
    return {
      ok: true,
      from,
      to,
      rolledBack: false,
      detail: `dry run - would pull ${to} and recreate ${target.services.join(", ")}`,
    };
  }

  const record = recorder(store, target, from, to, "registry");

  // Stage 1: pull. Nothing on the box has changed yet, so a failure here is
  // reported as a failure and not as a rollback of a stack we never touched.
  let imageId;
  try {
    imageId = await pullImage(exec, to);
  } catch (e) {
    const detail = `${e.message.slice(0, 300)}; nothing on this box was changed`;
    log.error(`deploy ${target.name} failed before any change: ${e.message}`);
    record("fail", detail);
    return { ok: false, from, to, rolledBack: false, detail };
  }

  // Stage 2: from here the stack is being changed, so every exit restores it.
  const rollback = (reason, what) =>
    rollbackRegistry(exec, target, { record, envPath, envVar, envText, previous, from, to, reason, what, health });

  let unproven = null;
  try {
    await writeEnvFile(envPath, upsertEnvVar(envText, envVar, to));
    await bringUp(exec, target, to, imageId);
  } catch (e) {
    if (!e.unverifiable) return rollback(e.message, "rollout");
    // Docker could not answer. The stack may well be fine, so let the health
    // gate decide rather than recreating production over a failed question.
    unproven = e.message;
    log.warn(`deploy ${target.name}: ${e.message}; falling back to the health check`);
  }

  const healthResult = await health(target.healthUrl, healthWaitFor(target));
  if (!healthResult.healthy) return rollback(healthResult.lastError, "health check");

  // Stage 3: look again. `up` returns as soon as containers start, so the
  // first check cannot see a container that dies a few seconds in; by now
  // health polling has given it time to fall over.
  try {
    const settled = verifyContainers(await inspectServices(exec, target, target.services), { imageId });
    if (!settled.ok) throw new Error(settled.problems.join("; "));
    unproven = null;
  } catch (e) {
    if (!e.unverifiable) return rollback(e.message, "post-health check");
    unproven = e.message;
  }

  const caveat = unproven ? `, but ${unproven}` : "";
  record(unproven ? "warn" : "ok", `${from} -> ${to} (image ${short(imageId)}), healthy after ${healthResult.tries} checks${caveat}`);
  log.info(`deploy ${target.name} ok: ${to} healthy${caveat}`);
  return {
    ok: true,
    from,
    to,
    rolledBack: false,
    detail: `running ${short(imageId)}, healthy after ${healthResult.tries} checks${caveat}`,
  };
}

/**
 * Put the stack back.
 *
 * `.env` is restored to the exact bytes it had before this deploy, always and
 * first: leaving a failed tag in a file compose re-reads on every later
 * `up -d` is how a rolled-back release deploys itself again a week later. If
 * the file named no image before, there is nothing to roll forward onto and
 * saying so is more useful than guessing at a tag.
 */
async function rollbackRegistry(exec, target, { record, envPath, envVar, envText, previous, from, to, reason, what, health }) {
  const why = `${what} failed on ${to} (${String(reason).slice(0, 200)})`;
  const restore = await writeEnvFile(envPath, envText).then(
    () => null,
    (e) => e.message,
  );
  if (restore) log.error(`could not restore ${envPath}: ${restore}`);

  if (!previous) {
    const detail = `${why}; ${envVar} named no image before this deploy, so there is nothing to roll back to - intervene`;
    log.error(`${what} failed for ${target.name} and no previous image is recorded; intervene`);
    record("fail", detail);
    return { ok: false, from, to, rolledBack: false, detail };
  }

  log.error(`${what} failed for ${target.name}; rolling back to ${previous}`);
  try {
    // The previous image may have been pruned since; a local copy is enough.
    // .env already names it again, byte for byte, so nothing rewrites it here.
    const imageId = await pullImage(exec, previous, { allowLocal: true });
    await bringUp(exec, target, previous, imageId);
  } catch (e) {
    const detail = `${why}; rollback to ${previous} ALSO FAILED (${e.message.slice(0, 200)}) - intervene`;
    record("rollback", detail);
    return { ok: false, from, to, rolledBack: true, detail };
  }
  const healthResult = await health(target.healthUrl, healthWaitFor(target));
  const detail = `${why}; rolled back to ${previous}, now ${healthResult.healthy ? "healthy" : "STILL UNHEALTHY - intervene"}`;
  record("rollback", detail);
  return { ok: false, from, to, rolledBack: true, detail };
}

/* -------------------------------------------------------------------------
 * Git mode (build on the box)
 * ---------------------------------------------------------------------- */

async function deployGit(target, ref, { store, dryRun, exec, health }) {
  const dir = target.dir;
  const from = (await git(exec, dir, "rev-parse", "--short", "HEAD")).trim();
  const fromRef = (await git(exec, dir, "describe", "--tags", "--always").catch(() => from)).trim?.() ?? from;
  log.info(`deploy ${target.name}: ${fromRef} -> ${ref}${dryRun ? " (dry run)" : ""}`);
  if (dryRun) return { ok: true, from: fromRef, to: ref, rolledBack: false, detail: "dry run - no changes" };

  const dirty = await git(exec, dir, "status", "--porcelain");
  if (dirty.trim()) throw new Error(`working tree at ${dir} has local changes; refusing to deploy over them`);

  await git(exec, dir, "fetch", "origin", "--tags", "--prune");
  await git(exec, dir, "checkout", ref);

  const record = recorder(store, target, fromRef, ref, "git");
  const build = () => compose(exec, target, ["up", "-d", "--build"]);

  try {
    await build();
    // A build leaves the previous containers up and healthy the whole time, so
    // health polling alone cannot tell a rollout from a no-op. When the target
    // names its services, require them to be running before believing it.
    if (target.services?.length) {
      const verify = verifyContainers(await inspectServices(exec, target, target.services));
      if (!verify.ok) throw new Error(`services did not come up: ${verify.problems.join("; ")}`);
    }
  } catch (e) {
    log.error(`build/up failed for ${target.name}; rolling back to ${from}`);
    await git(exec, dir, "checkout", from);
    await build().catch((e2) => log.error(`rollback build also failed: ${e2.message}`));
    record("rollback", `build failed (${e.message.slice(0, 200)}); rolled back to ${fromRef}`);
    return { ok: false, from: fromRef, to: ref, rolledBack: true, detail: `build failed: ${e.message.slice(0, 300)}` };
  }

  const healthResult = await health(target.healthUrl, healthWaitFor(target));
  if (!healthResult.healthy) {
    log.error(`health check failed after deploy of ${target.name}; rolling back to ${from}`);
    await git(exec, dir, "checkout", from);
    await build().catch((e2) => log.error(`rollback build failed: ${e2.message}`));
    const rollbackHealth = await health(target.healthUrl, healthWaitFor(target));
    record(
      "rollback",
      `health failed on ${ref} (${healthResult.lastError}); rolled back to ${fromRef} (${rollbackHealth.healthy ? "healthy" : "STILL UNHEALTHY"})`,
    );
    return {
      ok: false,
      from: fromRef,
      to: ref,
      rolledBack: true,
      detail: `health check failed (${healthResult.lastError}); rolled back, now ${rollbackHealth.healthy ? "healthy" : "STILL UNHEALTHY - intervene"}`,
    };
  }

  record("ok", `${fromRef} -> ${ref}, healthy after ${healthResult.tries} checks`);
  log.info(`deploy ${target.name} ok: ${ref} healthy`);
  return { ok: true, from: fromRef, to: ref, rolledBack: false, detail: `healthy after ${healthResult.tries} checks` };
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
 *
 * `exec` and `health` exist so the sequence can be tested without a daemon.
 */
export async function deploy(target, ref, { store, dryRun = false, exec = run, health = waitHealthy } = {}) {
  return target.source === "registry"
    ? deployRegistry(target, ref, { store, dryRun, exec, health })
    : deployGit(target, ref, { store, dryRun, exec, health });
}
