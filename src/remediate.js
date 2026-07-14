/**
 * Plain-language incident diagnosis and one-click remediation.
 *
 * When a check is failing (or warning), `diagnose()` turns the raw result into
 * something a non-specialist can act on: what it means in plain words, the
 * likely causes, and a small set of concrete actions. `gatherContext()` adds
 * live detail (recent container logs, reclaimable disk space) for display.
 * `runAction()` executes a chosen action safely, validating its target against
 * the configured checks/backups so an action can never touch something the
 * operator did not already put under management.
 *
 * Design rules:
 * - Actions are conservative. Nothing here deletes application data. The most
 *   forceful thing is restarting a container or removing *unused* Docker images
 *   and build cache.
 * - Each action declares a `kind`: "safe" (do it without a second thought) or
 *   "caution" (reversible but worth a confirm, e.g. restarting a database).
 * - Everything is described so the UI and the CLI render the same words.
 */
import { runBackup, prune as pruneBackups } from "./backup/backup.js";
import { drill } from "./backup/restore.js";
import { formatBytes } from "./util.js";

/**
 * Build the incident for a check + its latest state. Pure function (no I/O) so
 * it is trivially testable; live context comes from gatherContext().
 *
 * Returns null when the check is healthy, otherwise:
 *   { severity, title, meaning, causes: [string], actions: [action], guidance? }
 * action: { id, label, kind, container?|target?, confirm }
 */
export function diagnose(check, state) {
  if (!check || !state) return null;
  const status = state.status;
  if (status === "ok") return null;
  const severity = status === "fail" ? "fail" : "warn";

  switch (check.type) {
    case "container":
      return {
        severity,
        title: `${check.container} is not running normally`,
        meaning: `The "${check.container}" container is ${severity === "fail" ? "down or unhealthy" : "still starting or flapping"}. Anything that depends on it - your site, its data - is affected until it recovers.`,
        causes: [
          "It crashed, was stopped, or ran out of memory",
          "A recent change or deploy failed to come up",
          "A dependency it needs (like the database) is unavailable",
        ],
        actions: [restartAction(check.container, "caution")],
      };

    case "http":
      return {
        severity,
        title: `${check.name} is not responding as healthy`,
        meaning: `A request to ${short(check.url)} did not return a healthy response${state.detail ? ` (${state.detail})` : ""}. Visitors may be seeing errors or slowness.`,
        causes: [
          "The app container is down, restarting, or overloaded",
          "A dependency (database, cache) it relies on is unavailable",
          "A bad deploy left it in a broken state",
        ],
        actions: check.container ? [restartAction(check.container, "caution")] : [],
        guidance: check.container
          ? undefined
          : `Add "container": "<name>" to this check in your config to enable a one-click restart here.`,
      };

    case "postgres":
      return {
        severity,
        title: `Database "${check.database ?? check.container}" is not answering`,
        meaning: `The database in "${check.container}" did not respond to a simple query. The app cannot read or write data until it recovers.`,
        causes: [
          "The database container is down or restarting",
          "The disk is full, so the database cannot write",
          "It hit its connection limit",
        ],
        // Restarting Postgres is safe (it recovers cleanly) but sensitive, so
        // caution. If disk is the cause, the disk card offers the real fix.
        actions: [restartAction(check.container, "caution")],
        guidance: "If the disk is also alerting, fix that first - restarting will not help a full disk.",
      };

    case "disk":
      return {
        severity,
        title: `Disk ${check.path} is ${severity === "fail" ? "almost full" : "getting full"}`,
        meaning: `The disk is ${state.detail ?? `${state.value ?? "very"}% used`}. If it fills completely, apps and the database can fail or corrupt data. This is worth acting on promptly.`,
        causes: [
          "Unused Docker images and build cache piling up (often the biggest, and safe to clear)",
          "Application media/uploads growing over time",
          "Old backup artifacts kept longer than needed",
        ],
        actions: [
          { id: "reclaim-docker-space", label: "Reclaim unused Docker space", kind: "safe", confirm: "Remove unused Docker images and build cache? This never touches running containers or their data." },
        ],
      };

    case "memory":
      return {
        severity,
        title: "Memory is nearly exhausted",
        meaning: `Memory is ${state.detail ?? `${state.value ?? "nearly all"}% used`}. When memory runs out the system starts killing processes, which can take an app or the database down.`,
        causes: [
          "One container is using far more than its share (see below)",
          "A traffic spike or a heavy job (import, backup) is in progress",
          "An app has a memory leak and needs a restart",
        ],
        actions: [],
        guidance: "Restart the heaviest container from its own card if it is the culprit; a spike often clears on its own.",
      };

    case "load":
      return {
        severity,
        title: "The server is overloaded",
        meaning: `Load is ${state.detail ?? "high"}. More work is queued than the CPUs can handle, so everything feels slow.`,
        causes: [
          "A traffic spike",
          "A heavy backup, import, or build running right now",
          "A runaway process stuck in a loop",
        ],
        actions: [],
        guidance: "Usually transient. If it persists, check which container is busiest (below) and consider restarting it.",
      };

    case "tls-cert":
      return {
        severity,
        title: `HTTPS certificate for ${check.host} is expiring soon`,
        meaning: `The certificate ${state.detail ?? "is close to expiry"}. If it lapses, browsers will show a security warning and some clients will refuse to connect.`,
        causes: [
          "Automatic renewal (handled by your reverse proxy) has stopped working",
          "A DNS or proxy change broke the renewal challenge",
        ],
        actions: [],
        guidance:
          "Certificates renew automatically via your reverse proxy, so this is a heads-up, not a break yet. Check its renewal: for Caddy, look at its service logs; for certbot, run `certbot renew --dry-run`. This is not auto-fixable from here because it needs host access.",
      };

    case "backup-freshness":
      return {
        severity,
        title: `No recent backup for "${check.target}"`,
        meaning: `The last successful backup of "${check.target}" is older than expected${state.detail ? ` (${state.detail})` : ""}. If something went wrong right now, you could lose recent data.`,
        causes: [
          "The database container was renamed, so the scheduled backup fails",
          "The disk is full, so backups cannot be written",
          "The schedule simply has not run yet since setup",
        ],
        actions: [{ id: "run-backup", label: `Back up "${check.target}" now`, kind: "safe", target: check.target, confirm: `Run the "${check.target}" backup now?` }],
      };

    default:
      return {
        severity,
        title: `${check.name} is ${severity === "fail" ? "failing" : "warning"}`,
        meaning: state.detail ?? "This check is not passing.",
        causes: [],
        actions: [],
      };
  }
}

function restartAction(container, kind) {
  return {
    id: "restart-container",
    label: `Restart ${container}`,
    kind,
    container,
    confirm: `Restart the "${container}" container? It will be briefly unavailable while it comes back up.`,
  };
}

function short(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Live context for an incident, for display only. Best-effort: any part that
 * fails (docker unreachable, etc.) is simply omitted.
 */
export async function gatherContext(check, { docker }) {
  const ctx = {};
  if (!docker) return ctx;
  const container = check.container;

  if ((check.type === "container" || check.type === "http" || check.type === "postgres") && container) {
    try {
      ctx.logs = (await docker.logs(container, { tail: 25 })).trim().split("\n").slice(-25).join("\n");
    } catch {
      // no logs available
    }
  }

  if (check.type === "disk") {
    try {
      const df = await docker.systemDf();
      const reclaimable =
        (df.Images ?? []).reduce((s, im) => s + (im.Containers === 0 ? im.Size : 0), 0) +
        (df.BuildCache ?? []).reduce((s, c) => s + (c.InUse ? 0 : (c.Size ?? 0)), 0);
      ctx.reclaimable = reclaimable;
      ctx.reclaimableText = `about ${formatBytes(reclaimable)} of unused Docker images and build cache can be cleared safely`;
    } catch {
      // df unavailable
    }
  }

  if (check.type === "memory" || check.type === "load") {
    try {
      const byMetric = check.type === "memory" ? "mem" : "cpu";
      ctx.top = await topContainers(docker, byMetric);
    } catch {
      // stats unavailable
    }
  }

  return ctx;
}

async function topContainers(docker, metric) {
  const list = await docker.listContainers();
  const running = list.filter((c) => c.State === "running").slice(0, 12);
  const rows = [];
  for (const c of running) {
    try {
      const s = await docker.stats(c.Id);
      const name = (c.Names?.[0] ?? c.Id).replace(/^\//, "");
      if (metric === "mem") {
        const used = s.memory_stats?.usage ?? 0;
        rows.push({ name, value: used, text: formatBytes(used) });
      } else {
        const cpuDelta = (s.cpu_stats?.cpu_usage?.total_usage ?? 0) - (s.precpu_stats?.cpu_usage?.total_usage ?? 0);
        const sysDelta = (s.cpu_stats?.system_cpu_usage ?? 0) - (s.precpu_stats?.system_cpu_usage ?? 0);
        const cores = s.cpu_stats?.online_cpus ?? 1;
        const pct = sysDelta > 0 ? (cpuDelta / sysDelta) * cores * 100 : 0;
        rows.push({ name, value: pct, text: `${pct.toFixed(0)}% CPU` });
      }
    } catch {
      // skip a container we cannot stat
    }
  }
  return rows.sort((a, b) => b.value - a.value).slice(0, 5);
}

/**
 * Execute an action by id, validating its target against the config. Returns
 * { ok, message }. Never throws for expected failures.
 */
export async function runAction(actionId, params, { docker, store, config }) {
  const record = (ok, message) => {
    store?.append("events", { topic: "action", kind: ok ? "ok" : "fail", name: actionId, detail: message });
    return { ok, message };
  };

  try {
    switch (actionId) {
      case "restart-container": {
        const container = params.container;
        if (!knownContainer(config, container)) {
          return record(false, `"${container}" is not a container this instance manages`);
        }
        await docker.restart(container);
        return record(true, `Restarted ${container}. Give it a moment to become healthy.`);
      }

      case "reclaim-docker-space": {
        const images = await docker.pruneImages();
        const cache = await docker.pruneBuildCache();
        const total = (images ?? 0) + (cache ?? 0);
        return record(true, `Reclaimed ${formatBytes(total)} of disk (unused images + build cache).`);
      }

      case "run-backup": {
        const target = configuredBackup(config, params.target);
        if (!target) return record(false, `"${params.target}" is not a configured backup target`);
        const result = await runBackup(target, { docker, store });
        return record(true, `Backup "${target.name}" complete: ${result.lastDetail}`);
      }

      case "prune-backups": {
        const target = configuredBackup(config, params.target);
        if (!target) return record(false, `"${params.target}" is not a configured backup target`);
        const plan = await pruneBackups(target, { store });
        return record(true, `Pruned ${plan.drop.length} old artifact(s) for "${target.name}".`);
      }

      case "run-drill": {
        const target = configuredBackup(config, params.target);
        if (!target) return record(false, `"${params.target}" is not a configured backup target`);
        if (target.type !== "postgres") return record(false, `Restore drills apply to database targets; "${target.name}" is a files target`);
        const result = await drill(target, { docker, store });
        return record(true, `Restore drill passed for "${target.name}": ${result.lastDrillDetail}`);
      }

      default:
        return record(false, `Unknown action "${actionId}"`);
    }
  } catch (e) {
    return record(false, `Action failed: ${e.message}`);
  }
}

/** Is this a container referenced by any configured check or backup? */
function knownContainer(config, name) {
  if (!name) return false;
  const fromChecks = (config.checks ?? []).some((c) => c.container === name);
  const fromBackups = (config.backups ?? []).some((b) => b.container === name);
  return fromChecks || fromBackups;
}

function configuredBackup(config, name) {
  return (config.backups ?? []).find((b) => b.name === name) ?? null;
}

/** The set of action ids that exist, for validating POSTs. */
export const ACTION_IDS = new Set(["restart-container", "reclaim-docker-space", "run-backup", "prune-backups", "run-drill"]);
