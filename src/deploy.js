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
 * A registry target names one image or several. Several is the ordinary shape
 * for an application built as a frontend and a backend: two repositories, one
 * tag, one release. They move together, so the whole set is pulled before
 * anything is written, and a failure anywhere puts every reference back at
 * once - a stack left half on the new tag is the outcome worth the most care
 * here, because health can pass against the half that did not move.
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
  "DOCKER_API_VERSION",
  "SSH_AUTH_SOCK",
  "XDG_RUNTIME_DIR",
  // A build on a box behind an egress proxy needs these, and BuildKit passes
  // them into the build itself; dropping them breaks package installs.
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "DOCKER_BUILDKIT",
  "BUILDKIT_PROGRESS",
];

function composeEnv(target) {
  const env = {};
  for (const key of [...COMPOSE_PASSTHROUGH, ...(target?.composeEnv ?? [])]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

async function compose(exec, target, subcommand, { timeoutMs = 30 * 60_000 } = {}) {
  const r = await exec("docker", composeArgs(target, subcommand), {
    cwd: target.dir,
    env: composeEnv(target),
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
  // A .env that is a symlink to a shared secrets file is a real arrangement.
  // Renaming over the link would replace it with a regular file and leave the
  // canonical copy silently diverged, so the target is what gets rewritten.
  const target = await fsp.realpath(envPath).catch(() => envPath);
  const st = await fsp.stat(target).catch(() => null);
  const mode = st ? st.mode & 0o777 : 0o600;
  const tmp = `${target}.server-tools.${process.pid}.tmp`;
  try {
    await fsp.writeFile(tmp, text, { mode });
    // writeFile only applies mode when it creates the file; a leftover temp
    // from an earlier crash would otherwise keep its old permissions.
    await fsp.chmod(tmp, mode);
    if (st) {
      await fsp
        .chown(tmp, st.uid, st.gid)
        .catch((e) => log.warn(`could not preserve ownership of ${target}: ${e.message}`));
    }
    await fsp.rename(tmp, target);
  } catch (e) {
    // Cleanup must not become the reported reason.
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw new Error(`cannot write ${target}: ${e.message}`);
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
  e.rollout = true;
  return e;
}

/** A rollout that answered, and the answer was no. */
function rolloutFailure(message) {
  const e = new Error(message);
  e.rollout = true;
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
      env: composeEnv(target),
      timeoutMs: 60_000,
    });
    if (ps.code !== 0) {
      const reason = (ps.stderr || ps.stdout).slice(-300);
      // "no such service" is a config error: leniency there would leave the
      // whole verification guarantee switched off for every deploy.
      if (/no such service/i.test(reason)) {
        const e = new Error(`service "${service}" is not in the compose file`);
        e.rollout = true;
        throw e;
      }
      throw unverifiable(`docker compose ps failed: ${reason}`);
    }
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

/**
 * The images a registry target deploys, as a list of slots.
 *
 * A target states either one image (`image` / `imageEnvVar` / `services`) or
 * several (`images`, each entry with its own `image`, `envVar` and
 * `services`). One is the same thing as many with a single entry, so the
 * deploy sequence below only ever handles a list and there is no second code
 * path for the multi-image case to drift away from.
 */
export function imageSlots(target) {
  const entries =
    Array.isArray(target.images) && target.images.length
      ? target.images
      : [{ image: target.image, envVar: target.imageEnvVar, services: target.services }];
  return entries.map((e) => ({
    image: e.image,
    envVar: e.envVar ?? DEFAULT_IMAGE_ENV_VAR,
    services: e.services ?? [],
  }));
}

/** Every service a target's images between them must leave running. */
const slotServices = (slots) => [...new Set(slots.flatMap((s) => s.services))];

/** How the running images read in an event: "image abc123" for the single case. */
function imagesRunning(slots) {
  return slots.length === 1
    ? `image ${short(slots[0].imageId)}`
    : `images ${slots.map((s) => `${s.envVar}=${short(s.imageId)}`).join(", ")}`;
}

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
 * Prove each slot's services are running that slot's image.
 *
 * Every slot is checked even after one has already failed: at 3am "the
 * frontend is still on the old tag" and "the frontend is still on the old tag
 * and the backend is missing" call for different reactions, and the second
 * one is only visible if the loop does not stop early.
 */
async function verifySlots(exec, target, slots) {
  const problems = [];
  for (const s of slots) {
    const verify = verifyContainers(await inspectServices(exec, target, s.services), { imageId: s.imageId });
    problems.push(...verify.problems);
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Recreate the stack on whatever `.env` currently names, and prove the named
 * services are running the images that were pulled for it. The caller writes
 * `.env` and pulls first, so reaching this function is the moment the box
 * starts changing.
 *
 * One `up` covers every slot: they share a compose project, so recreating it
 * once per image would tear the stack down and back up several times over.
 */
async function bringUp(exec, target, slots) {
  await compose(exec, target, ["up", "-d", "--no-build"], { timeoutMs: 15 * 60_000 });
  const verify = await verifySlots(exec, target, slots);
  if (!verify.ok) {
    throw new Error(`services are not running ${slots.map((s) => s.ref).join(", ")}: ${verify.problems.join("; ")}`);
  }
}

async function deployRegistry(target, tag, { store, dryRun, exec, health }) {
  const slots = imageSlots(target);
  const envPath = path.join(target.dir, ".env");
  for (const s of slots) s.ref = imageRef(s.image, tag);
  const to = slots.map((s) => s.ref).join(", ");

  // A directory that is not visible to the agent produces a chain of
  // misleading symptoms later; say so here instead.
  const dir = await fsp.stat(target.dir).catch(() => null);
  if (!dir?.isDirectory()) {
    throw new Error(`deploy target directory ${target.dir} is not visible here; bind-mount it into the agent`);
  }

  const envText = await readEnvFile(envPath);
  for (const s of slots) s.previous = readEnvVar(envText, s.envVar);
  const from = slots.map((s) => s.previous ?? "(unset)").join(", ");

  log.info(`deploy ${target.name}: ${from} -> ${to}${dryRun ? " (dry run)" : ""}`);
  if (dryRun) {
    return {
      ok: true,
      from,
      to,
      rolledBack: false,
      detail: `dry run - would pull ${to} and recreate ${slotServices(slots).join(", ")}`,
    };
  }

  const record = recorder(store, target, from, to, "registry");

  // Stage 1: pull, all of them. Nothing on the box has changed yet, so a
  // failure here is reported as a failure and not as a rollback of a stack we
  // never touched - and pulling every image before writing anything is what
  // keeps a missing second image from stranding the stack half-deployed.
  try {
    for (const s of slots) s.imageId = await pullImage(exec, s.ref);
  } catch (e) {
    const detail = `${e.message.slice(0, 300)}; nothing on this box was changed`;
    log.error(`deploy ${target.name} failed before any change: ${e.message}`);
    record("fail", detail);
    return { ok: false, from, to, rolledBack: false, detail };
  }

  // Stage 2: from here the stack is being changed, so every exit restores it.
  const rollback = (reason, what) =>
    rollbackRegistry(exec, target, { record, envPath, envText, slots, from, to, reason, what, health });

  // Writing .env is the first thing that changes the box, so its own failure
  // belongs with the pull: nothing has happened yet, and recreating a healthy
  // stack to "roll back" from it would be the only damage done. Every
  // reference goes in one write, so the file is never briefly half-updated.
  try {
    let text = envText;
    for (const s of slots) text = upsertEnvVar(text, s.envVar, s.ref);
    await writeEnvFile(envPath, text);
  } catch (e) {
    const detail = `${e.message.slice(0, 300)}; nothing on this box was changed`;
    log.error(`deploy ${target.name} could not write ${envPath}: ${e.message}`);
    record("fail", detail);
    return { ok: false, from, to, rolledBack: false, detail };
  }

  let unproven = null;
  try {
    await bringUp(exec, target, slots);
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
    const settled = await verifySlots(exec, target, slots);
    if (!settled.ok) throw new Error(settled.problems.join("; "));
    unproven = null;
  } catch (e) {
    if (!e.unverifiable) return rollback(e.message, "post-health check");
    unproven = e.message;
  }

  const caveat = unproven ? `, but ${unproven}` : "";
  const running = imagesRunning(slots);
  record(unproven ? "warn" : "ok", `${from} -> ${to} (${running}), healthy after ${healthResult.tries} checks${caveat}`);
  log.info(`deploy ${target.name} ok: ${to} healthy${caveat}`);
  return {
    ok: true,
    from,
    to,
    rolledBack: false,
    detail: `running ${running}, healthy after ${healthResult.tries} checks${caveat}`,
  };
}

/**
 * Put the stack back.
 *
 * `.env` is restored to the exact bytes it had before this deploy, always and
 * first: leaving a failed tag in a file compose re-reads on every later
 * `up -d` is how a rolled-back release deploys itself again a week later. One
 * write restores every reference, which is also why a partial rollback is not
 * a state this can end in. If any variable named no image before, there is
 * nothing to roll forward onto and saying so is more useful than guessing at
 * a tag - the stack cannot come up on a reference that is unset.
 */
async function rollbackRegistry(exec, target, { record, envPath, envText, slots, from, to, reason, what, health }) {
  const why = `${what} failed on ${to} (${String(reason).slice(0, 200)})`;
  const restoreError = await writeEnvFile(envPath, envText).then(
    () => null,
    (e) => e.message,
  );
  // If the file could not be put back it still names the failed images, so the
  // next routine "compose up -d" redeploys them. That has to reach the
  // operator, not just the log.
  const names = slots.map((s) => s.envVar).join(", ");
  const stillBroken = restoreError
    ? ` ${names} in ${envPath} could NOT be restored (${restoreError.slice(0, 150)}) and still names ${to} - fix it before any later compose up, or it redeploys - intervene.`
    : "";
  if (restoreError) log.error(`could not restore ${envPath}: ${restoreError}`);

  const unset = slots.filter((s) => !s.previous);
  if (unset.length) {
    const which = unset.map((s) => s.envVar).join(", ");
    const detail = `${why}; ${which} named no image before this deploy, so there is nothing to roll back to - intervene.${stillBroken}`;
    log.error(`${what} failed for ${target.name} and no previous image is recorded for ${which}; intervene`);
    record("fail", detail);
    return { ok: false, from, to, rolledBack: false, detail };
  }

  const back = slots.map((s) => s.previous).join(", ");
  log.error(`${what} failed for ${target.name}; rolling back to ${back}`);
  try {
    // A previous image may have been pruned since; a local copy is enough.
    // .env already names them again, byte for byte, so nothing rewrites it
    // here. The slots are rebuilt around the previous refs so the same
    // verification runs on the way back as on the way out.
    const previousSlots = slots.map((s) => ({ ...s, ref: s.previous }));
    for (const s of previousSlots) s.imageId = await pullImage(exec, s.ref, { allowLocal: true });
    await bringUp(exec, target, previousSlots);
  } catch (e) {
    const detail = `${why}; rollback to ${back} ALSO FAILED (${e.message.slice(0, 200)}) - intervene.${stillBroken}`;
    record("rollback", detail);
    return { ok: false, from, to, rolledBack: true, detail };
  }
  const healthResult = await health(target.healthUrl, healthWaitFor(target));
  const detail = `${why}; rolled back to ${back}, now ${healthResult.healthy ? "healthy" : "STILL UNHEALTHY - intervene"}.${stillBroken}`;
  record(restoreError ? "fail" : "rollback", detail);
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

  let unproven = null;
  try {
    await build();
    // A build leaves the previous containers up and healthy the whole time, so
    // health polling alone cannot tell a rollout from a no-op. When the target
    // names its services, require them to be running before believing it.
    if (target.services?.length) {
      try {
        const verify = verifyContainers(await inspectServices(exec, target, target.services));
        if (!verify.ok) throw rolloutFailure(`services did not come up: ${verify.problems.join("; ")}`);
      } catch (e) {
        // Same rule as registry mode: a read-only check that could not be
        // performed must not cause a write. Let the health gate decide - but
        // say so, because health alone passing against the previous release
        // is the exact thing this check was added to catch.
        if (!e.unverifiable) throw e;
        unproven = e.message;
        log.warn(`deploy ${target.name}: ${e.message}; falling back to the health check`);
      }
    }
  } catch (e) {
    // The build and the rollout fail for different reasons and are read in
    // different logs, so the label has to come from the error rather than
    // from matching its text.
    const what = e.rollout ? "rollout" : "build";
    log.error(`${what} failed for ${target.name}; rolling back to ${from}`);
    await git(exec, dir, "checkout", from);
    await build().catch((e2) => log.error(`rollback build also failed: ${e2.message}`));
    record("rollback", `${what} failed (${e.message.slice(0, 200)}); rolled back to ${fromRef}`);
    return { ok: false, from: fromRef, to: ref, rolledBack: true, detail: `${what} failed: ${e.message.slice(0, 300)}` };
  }

  const healthResult = await health(target.healthUrl, healthWaitFor(target));
  const rollbackTo = async (reason) => {
    log.error(`${reason} after deploy of ${target.name}; rolling back to ${from}`);
    await git(exec, dir, "checkout", from);
    await build().catch((e2) => log.error(`rollback build failed: ${e2.message}`));
    const rollbackHealth = await health(target.healthUrl, healthWaitFor(target));
    record(
      "rollback",
      `${reason} on ${ref}; rolled back to ${fromRef} (${rollbackHealth.healthy ? "healthy" : "STILL UNHEALTHY"})`,
    );
    return {
      ok: false,
      from: fromRef,
      to: ref,
      rolledBack: true,
      detail: `${reason}; rolled back, now ${rollbackHealth.healthy ? "healthy" : "STILL UNHEALTHY - intervene"}`,
    };
  };

  if (!healthResult.healthy) return rollbackTo(`health check failed (${healthResult.lastError})`);

  // The same second look registry mode takes, for the same reason: `up`
  // returns as soon as containers start, so the first check cannot see a
  // worker that boots and dies a few seconds later.
  if (target.services?.length) {
    try {
      const settled = verifyContainers(await inspectServices(exec, target, target.services));
      if (!settled.ok) throw rolloutFailure(settled.problems.join("; "));
      unproven = null;
    } catch (e) {
      if (!e.unverifiable) return rollbackTo(`services did not stay up (${e.message})`);
      unproven = e.message;
    }
  }

  const caveat = unproven ? `, but ${unproven}` : "";
  record(unproven ? "warn" : "ok", `${fromRef} -> ${ref}, healthy after ${healthResult.tries} checks${caveat}`);
  log.info(`deploy ${target.name} ok: ${ref} healthy${caveat}`);
  return {
    ok: true,
    from: fromRef,
    to: ref,
    rolledBack: false,
    detail: `healthy after ${healthResult.tries} checks${caveat}`,
  };
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
