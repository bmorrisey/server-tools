/**
 * The long-running agent: schedules checks, backups, and housekeeping, routes
 * alerts, and (when enabled) serves the admin dashboard.
 *
 *   node src/agent.js            (config from ./config.json or SERVER_TOOLS_CONFIG)
 */
import { loadConfig } from "./config.js";
import { Store } from "./store.js";
import { Docker } from "./docker.js";
import { CheckEngine } from "./checks.js";
import { Alerter } from "./alerts.js";
import { runBackup } from "./backup/backup.js";
import { housekeep } from "./housekeep.js";
import { parseDuration, parseSchedule, msUntilNext, formatDuration } from "./util.js";
import { logger } from "./log.js";

const log = logger("agent");

/** Schedule a recurring job; daily/weekly specs re-anchor after each run. */
function schedule(spec, name, fn) {
  const sched = parseSchedule(spec);
  if (!sched) {
    log.warn(`job ${name}: invalid schedule "${spec}", skipping`);
    return;
  }
  const arm = () => {
    const delay = msUntilNext(sched);
    log.debug(`job ${name}: next run in ${formatDuration(delay)}`);
    setTimeout(async () => {
      try {
        await fn();
      } catch (e) {
        log.error(`job ${name} failed: ${e.message}`);
      }
      arm();
    }, delay).unref();
  };
  arm();
}

export async function startAgent({ configPath, withWeb = true } = {}) {
  const config = loadConfig(configPath);
  const store = new Store(config.dataDir);
  store.ensureDirs();
  const docker = new Docker(config.docker);
  const alerter = new Alerter(config, store);

  if (!(await docker.ping())) {
    log.warn("docker socket not reachable; container/postgres checks and backups will fail until it is mounted");
  }

  const engine = new CheckEngine({
    config,
    store,
    docker,
    onTransition: async (transition, check) => {
      await alerter.send({
        title: `${check.name}: ${transition.kind === "fail" ? "FAILING" : "recovered"}`,
        body: `${check.type} check "${check.name}"\n${transition.result.detail}`,
        level: transition.kind === "fail" ? "fail" : "recover",
        source: check.name,
      });
    },
  });

  // Checks: stagger initial runs so a restart does not thundering-herd.
  for (const [i, check] of config.checks.entries()) {
    const interval = parseDuration(check.interval ?? config.checkDefaults.interval);
    const kickoff = Math.min(3000 + i * 500, 15_000);
    setTimeout(() => {
      engine.runOne(check).catch((e) => log.error(`check ${check.name}: ${e.message}`));
      setInterval(() => {
        engine.runOne(check).catch((e) => log.error(`check ${check.name}: ${e.message}`));
      }, interval).unref();
    }, kickoff).unref();
  }
  log.info(`scheduled ${config.checks.length} checks`);

  // Backups.
  for (const target of config.backups) {
    if (!target.schedule) {
      log.info(`backup ${target.name}: no schedule, manual only`);
      continue;
    }
    schedule(target.schedule, `backup:${target.name}`, async () => {
      try {
        await runBackup(target, { docker, store });
      } catch (e) {
        await alerter.send({
          title: `backup ${target.name} FAILED`,
          body: e.message,
          level: "fail",
          source: `backup:${target.name}`,
        });
      }
    });
  }
  log.info(`scheduled ${config.backups.filter((b) => b.schedule).length} backup targets`);

  // Housekeeping.
  schedule(config.housekeeping.schedule ?? "04:30", "housekeep", () => housekeep(config, store));

  // Dashboard.
  let web = null;
  if (withWeb && config.web.enabled !== false) {
    try {
      const { startWebServer } = await import("./web/server.js");
      web = await startWebServer({ config, store, docker, alerter });
    } catch (e) {
      if (e.code === "ERR_MODULE_NOT_FOUND") {
        log.warn("dashboard module not present in this build; running headless");
      } else {
        throw e;
      }
    }
  }

  log.info("agent started");
  return { config, store, docker, engine, alerter, web };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (isMain) {
  startAgent().catch((e) => {
    log.error(e.message);
    process.exit(1);
  });
}
