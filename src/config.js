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
import { shouldArchive } from "./backup/backup.js";

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
    if (c.type === "backup-freshness") {
      need(typeof c.target === "string", `${where}.target (backup target name) is required`);
      if (typeof c.target === "string") {
        const target = (cfg.backups ?? []).find((b) => b.name === c.target);
        need(Boolean(target), `${where}.target "${c.target}" is not a configured backup target, so it can never be fresh`);
        need(
          target?.type !== "external",
          `${where}.target "${c.target}" is an external target; it is never backed up here, so freshness is not a thing to check`,
        );
      }
    }
    if (c.type === "command") need(typeof c.command === "string", `${where}.command is required`);
  }

  for (const [i, b] of (cfg.backups ?? []).entries()) {
    const where = `backups[${i}]`;
    need(typeof b.name === "string" && b.name, `${where}.name is required`);
    need(["postgres", "files", "external"].includes(b.type), `${where}.type must be "postgres", "files", or "external"`);
    if (b.app !== undefined)
      need(typeof b.app === "string" && b.app.trim(), `${where}.app must be a non-empty application name`);
    if (b.schedule !== undefined)
      need(parseSchedule(b.schedule) !== null, `${where}.schedule "${b.schedule}" is not a valid schedule`);
    if (b.type === "postgres") {
      need(typeof b.container === "string", `${where}.container is required (database container name)`);
      need(typeof b.database === "string", `${where}.database is required`);
      need(typeof b.user === "string", `${where}.user is required`);
    }
    if (b.type === "files") {
      // Where the data lives is stated, never inferred: a target that guesses
      // produces a partial backup that reads as a complete one.
      const s = b.source;
      if (s === undefined) {
        need(typeof b.path === "string" && b.path, `${where}.path is required (or use "source")`);
      } else {
        need(s && typeof s === "object" && !Array.isArray(s), `${where}.source must be an object`);
        if (s && typeof s === "object" && !Array.isArray(s)) {
          const named = ["volume", "container", "path"].filter((k) => s[k] !== undefined);
          need(
            named.length > 0,
            `${where}.source must name one of "volume", "container" (with "path"), or "path"`,
          );
          need(
            !(s.volume !== undefined && s.container !== undefined),
            `${where}.source names both a volume and a container; pick one`,
          );
          for (const k of named) need(typeof s[k] === "string" && s[k], `${where}.source.${k} must be a non-empty string`);
          if (typeof s.path === "string")
            need(
              !s.path.split("/").includes(".."),
              `${where}.source.path must not contain ".."; name the directory directly`,
            );
          if (s.container !== undefined) need(typeof s.path === "string" && s.path, `${where}.source.container needs source.path`);
          // The Engine hands back the whole subtree in one stream, so an
          // exclude could only be applied to the manifest, leaving it
          // describing something the archive does not contain and failing
          // every restore drill from then on. Narrow the source instead.
          need(
            !(b.exclude !== undefined && (s.volume !== undefined || s.container !== undefined)),
            `${where}.exclude cannot be applied to a volume or container source; point source.path at a narrower directory instead`,
          );
        }
      }
      if (b.exclude !== undefined) {
        need(
          Array.isArray(b.exclude) && b.exclude.every((x) => typeof x === "string" && x),
          `${where}.exclude must be an array of relative paths`,
        );
        // Exclusions are matched literally and anchored at the root, so that
        // the archive and the manifest drop exactly the same files. A glob
        // would quietly match nothing rather than what the operator meant.
        if (Array.isArray(b.exclude))
          need(
            b.exclude.every((x) => typeof x !== "string" || !/[*?[\]]/.test(x)),
            `${where}.exclude entries are literal paths relative to the source root, not patterns`,
          );
      }
      if (b.allowEmpty !== undefined)
        need(typeof b.allowEmpty === "boolean", `${where}.allowEmpty must be true or false`);
      if (b.archive !== undefined) {
        need(typeof b.archive === "boolean", `${where}.archive must be true or false`);
        // A manifest taken through the Docker socket describes no tree this
        // box can re-read, so without an archive nothing could ever verify it.
        need(
          !(b.archive === false && b.source && (b.source.volume || b.source.container)),
          `${where}.archive cannot be false for a volume or container source; there would be no tree left to verify the manifest against`,
        );
      }
    }
    if (b.type === "external") {
      // An external target exists to be honest about what is not covered, so
      // the note is the whole point of it, and it must never look "fresh".
      need(typeof b.note === "string" && b.note.trim(), `${where}.note is required for an external target (say where the data actually lives)`);
      need(b.schedule === undefined, `${where}.schedule does not apply to an external target; nothing is copied`);
      need(b.s3 === undefined, `${where}.s3 does not apply to an external target; nothing is copied`);
      need(b.retention === undefined, `${where}.retention does not apply to an external target; nothing is copied`);
    }
    if (b.type !== "external" && b.encrypt !== false)
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
      // Every one of them zero means "delete the backup you just took". The
      // dashboard offers pruning as a safe action on the promise that recent
      // backups survive it, so a policy that keeps nothing is refused here.
      const counts = ["daily", "weekly", "monthly"].map((k) => b.retention[k] ?? 0);
      need(
        counts.some((n) => Number.isInteger(n) && n > 0),
        `${where}.retention must keep at least one backup; all-zero would delete every artifact including the newest`,
      );
    }
  }

  for (const [i, d] of (cfg.deploys ?? []).entries()) {
    const where = `deploys[${i}]`;
    need(typeof d.name === "string" && d.name, `${where}.name is required`);
    need(typeof d.dir === "string" && d.dir, `${where}.dir is required (compose project directory)`);
    need(typeof d.healthUrl === "string" && d.healthUrl.startsWith("http"), `${where}.healthUrl must be an http(s) URL`);
    const source = d.source ?? "git";
    need(["git", "registry"].includes(source), `${where}.source must be "git" or "registry"`);
    if (d.project !== undefined)
      need(
        typeof d.project === "string" && /^[a-z0-9][a-z0-9_-]*$/.test(d.project),
        `${where}.project must be a compose project name (lowercase letters, digits, "-" or "_")`,
      );
    if (d.services !== undefined)
      need(
        Array.isArray(d.services) &&
          d.services.length > 0 &&
          d.services.every((s) => typeof s === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s)),
        `${where}.services must be a non-empty array of compose service names (a name starting with "-" would be read as a flag)`,
      );
    if (d.composeEnv !== undefined)
      need(
        Array.isArray(d.composeEnv) && d.composeEnv.every((v) => typeof v === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(v)),
        `${where}.composeEnv must be an array of environment variable names`,
      );
    if (d.healthAttempts !== undefined)
      need(Number.isInteger(d.healthAttempts) && d.healthAttempts > 0, `${where}.healthAttempts must be a positive integer`);
    if (d.healthDelay !== undefined)
      need(parseDuration(d.healthDelay) !== null, `${where}.healthDelay "${d.healthDelay}" is not a duration`);
    if (source === "registry") {
      // A bare "docker compose" on a box with several stacks acts on a project
      // derived from the directory, so the project name is stated, not guessed.
      need(typeof d.project === "string" && d.project, `${where}.project is required for registry deploys (the "docker compose -p" name)`);
      need(typeof d.image === "string" && d.image, `${where}.image is required for registry deploys (repository without a tag)`);
      if (typeof d.image === "string" && d.image)
        // A private registry carries a port ("registry.example.com:5000/o/app"),
        // so a colon is legal here; the tag check below is what rejects one.
        need(
          /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(d.image),
          `${where}.image is not a valid image repository name`,
        );
      if (typeof d.image === "string" && d.image)
        need(
          !d.image.split("/").pop().includes(":") && !d.image.includes("@"),
          `${where}.image must not include a tag or digest; the tag is the deploy argument`,
        );
      need(
        Array.isArray(d.services) && d.services.length > 0,
        `${where}.services is required for registry deploys (the services that must end up running the new image)`,
      );
      if (d.imageEnvVar !== undefined)
        need(
          typeof d.imageEnvVar === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(d.imageEnvVar),
          `${where}.imageEnvVar must be a valid environment variable name`,
        );
    } else {
      need(d.image === undefined, `${where}.image only applies to registry deploys (set "source": "registry")`);
      need(d.imageEnvVar === undefined, `${where}.imageEnvVar only applies to registry deploys (set "source": "registry")`);
    }
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

/**
 * Gaps in a deployment that only the operator can resolve.
 *
 * These are not validation errors - a box may legitimately have nothing but
 * databases to back up. They exist because the one answer the dashboard must
 * not give on its own is "all green" for a deployment whose media has never
 * been backed up at all. A database restored without its media is not a
 * restore: the app boots, the pages render, and every image 404s.
 *
 * Declaring an `external` target is a valid resolution: it says the media is
 * outside this toolkit, which is a recovery shape an operator can plan for.
 */
export function coverageNotes(cfg) {
  const backups = cfg?.backups ?? [];
  // Targets can name the application they belong to. When they do, coverage
  // is judged per application, because "some app on this box backs up media"
  // says nothing about the one being restored. Without that grouping the
  // whole deployment is treated as one, which is the honest reading of a
  // config that does not say otherwise.
  const groups = new Map();
  for (const b of backups) {
    const key = typeof b.app === "string" && b.app ? b.app : "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  }

  const notes = [];
  for (const [app, targets] of groups) {
    const databases = targets.filter((b) => b.type === "postgres");
    if (databases.length === 0) continue;
    const which = app ? `"${app}"` : "this deployment";
    // A manifest-only files target indexes media without copying a byte of
    // it, so on its own it is not coverage - it just makes the gap harder to
    // see, which is the shape this warning exists to catch.
    const indexedOnly = targets.filter((b) => b.type === "files" && !shouldArchive(b));
    const copied = targets.filter((b) => b.type === "files" && shouldArchive(b));
    const declared = targets.filter((b) => b.type === "external");
    if (copied.length > 0 || declared.length > 0) continue;
    notes.push(
      indexedOnly.length > 0
        ? {
            id: app ? `media-indexed-only:${app}` : "media-indexed-only",
            app: app || null,
            title: app
              ? `${app}: media is indexed but not copied`
              : "Media is indexed but not copied",
            detail:
              `${indexedOnly.map((b) => b.name).join(", ")} writes a manifest and no archive, so it can verify media that still exists but restores none of it. ` +
              'Set "archive": true to keep a copy, or declare an "external" target if the real copy lives somewhere else.',
          }
        : {
            id: app ? `media-not-declared:${app}` : "media-not-declared",
            app: app || null,
            title: app
              ? `${app}: databases are backed up, media is not declared`
              : "Databases are backed up; media is not declared",
            detail:
              `Every backup target for ${which} is a database (${databases.map((b) => b.name).join(", ")}). ` +
              "A database restored without its media is not a restore - the app comes up and every image 404s. " +
              'Add a "files" target for media this toolkit can copy, or an "external" target naming where it lives instead.',
          },
    );
  }
  return notes;
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
