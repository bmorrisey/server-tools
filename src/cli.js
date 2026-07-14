#!/usr/bin/env node
/**
 * server-tools CLI. Every operation the agent runs on a schedule can also be
 * run by hand, plus restore/drill/deploy/login-link which are manual only.
 *
 *   server-tools check [name]            run all checks (or one) and print results
 *   server-tools backup <target>         run one backup target now
 *   server-tools backup-all              run every configured backup target
 *   server-tools restore <target> [artifact] [--force]
 *   server-tools drill <target> [artifact]
 *   server-tools artifacts <target>      list local + offsite artifacts
 *   server-tools deploy <target> <ref> [--dry-run]
 *   server-tools housekeep [--dry-run]
 *   server-tools status                  print latest check/backup state
 *   server-tools diagnose <check>        explain a failing check in plain words
 *   server-tools fix <check> [actionId]  run a suggested one-click remediation
 *   server-tools login-link <email>      print a one-time dashboard login URL
 *   server-tools validate                validate the config file and exit
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { loadConfig, DEFAULT_CONFIG_PATH } from "./config.js";
import { Store } from "./store.js";
import { Docker } from "./docker.js";
import { runCheck } from "./checks.js";
import { runBackup } from "./backup/backup.js";
import { restore, drill } from "./backup/restore.js";
import { S3 } from "./backup/s3.js";
import { deploy } from "./deploy.js";
import { housekeep } from "./housekeep.js";
import { formatBytes } from "./util.js";

const [, , command, ...args] = process.argv;
const flags = new Set(args.filter((a) => a.startsWith("--")));
const positional = args.filter((a) => !a.startsWith("--"));

function fail(msg) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

function findTarget(config, kind, name) {
  const list = config[kind] ?? [];
  const hit = list.find((t) => t.name === name);
  if (!hit) fail(`${kind.slice(0, -1)} target "${name}" not found; configured: ${list.map((t) => t.name).join(", ") || "(none)"}`);
  return hit;
}

const ICONS = { ok: "OK  ", warn: "WARN", fail: "FAIL" };

async function main() {
  if (!command || command === "help" || command === "--help" || flags.has("--help")) {
    const header = (await import("node:fs")).readFileSync(new URL(import.meta.url), "utf8");
    const usage = header
      .split("*/")[0]
      .split("\n")
      .filter((l) => /^ \* {2}server-tools /.test(l))
      .map((l) => l.replace(/^ \* {2}/, "  "))
      .join("\n");
    process.stdout.write(`usage:\n${usage}\n`);
    return;
  }

  if (command === "validate") {
    loadConfig();
    process.stdout.write(`config at ${path.resolve(DEFAULT_CONFIG_PATH)} is valid\n`);
    return;
  }

  const config = loadConfig();
  const store = new Store(config.dataDir);
  store.ensureDirs();
  const docker = new Docker(config.docker);

  switch (command) {
    case "check": {
      const only = positional[0];
      const checks = only ? config.checks.filter((c) => c.name === only) : config.checks;
      if (!checks.length) fail(only ? `no check named "${only}"` : "no checks configured");
      let worst = 0;
      for (const check of checks) {
        const r = await runCheck(check, { docker, store, defaults: config.checkDefaults });
        worst = Math.max(worst, { ok: 0, warn: 1, fail: 2 }[r.status]);
        process.stdout.write(`${ICONS[r.status]} ${check.name.padEnd(28)} ${r.detail}\n`);
      }
      process.exit(worst === 2 ? 1 : 0);
      break;
    }

    case "backup": {
      const target = findTarget(config, "backups", positional[0] ?? fail("usage: backup <target>"));
      const result = await runBackup(target, { docker, store });
      process.stdout.write(`backup ${target.name}: ${result.lastDetail}\n`);
      break;
    }

    case "backup-all": {
      let failed = 0;
      for (const target of config.backups) {
        try {
          const result = await runBackup(target, { docker, store });
          process.stdout.write(`OK   ${target.name}: ${result.lastDetail}\n`);
        } catch (e) {
          failed++;
          process.stdout.write(`FAIL ${target.name}: ${e.message}\n`);
        }
      }
      process.exit(failed ? 1 : 0);
      break;
    }

    case "restore": {
      const target = findTarget(config, "backups", positional[0] ?? fail("usage: restore <target> [artifact]"));
      if (target.type !== "postgres") fail("restore currently supports postgres targets (files targets restore from their archive by hand; see RUNBOOK.md)");
      const result = await restore(target, {
        docker,
        store,
        artifact: positional[1] ?? null,
        force: flags.has("--force"),
      });
      process.stdout.write(`restored ${result.artifact} into ${result.database} (${result.tables} tables)\n`);
      break;
    }

    case "drill": {
      const target = findTarget(config, "backups", positional[0] ?? fail("usage: drill <target> [artifact]"));
      if (target.type !== "postgres") fail("drill supports postgres targets");
      const result = await drill(target, { docker, store, artifact: positional[1] ?? null });
      process.stdout.write(`drill ok: ${result.lastDrillDetail}\n`);
      break;
    }

    case "artifacts": {
      const target = findTarget(config, "backups", positional[0] ?? fail("usage: artifacts <target>"));
      const dir = store.backupDir(target.name);
      const local = await fsp.readdir(dir).catch(() => []);
      process.stdout.write("local:\n");
      for (const f of local.sort()) {
        const st = await fsp.stat(path.join(dir, f));
        process.stdout.write(`  ${f}  ${formatBytes(st.size)}\n`);
      }
      if (target.s3) {
        process.stdout.write("offsite:\n");
        for (const k of (await new S3(target.s3).list(`${target.name}/`)).sort()) {
          process.stdout.write(`  ${k}\n`);
        }
      }
      break;
    }

    case "deploy": {
      const target = findTarget(config, "deploys", positional[0] ?? fail("usage: deploy <target> <ref>"));
      const ref = positional[1] ?? fail("usage: deploy <target> <ref>");
      const result = await deploy(target, ref, { store, dryRun: flags.has("--dry-run") });
      process.stdout.write(`${result.ok ? "OK" : "FAILED"}: ${result.from} -> ${result.to}${result.rolledBack ? " (rolled back)" : ""}\n${result.detail}\n`);
      process.exit(result.ok ? 0 : 1);
      break;
    }

    case "housekeep": {
      const result = await housekeep(config, store, { dryRun: flags.has("--dry-run") });
      process.stdout.write(`${result.dryRun ? "(dry run) " : ""}${result.summary.join("\n") || "nothing to remove"}\n`);
      break;
    }

    case "status": {
      const checks = store.readState("checks", {});
      const backups = store.readState("backups", {});
      process.stdout.write("checks:\n");
      for (const [name, s] of Object.entries(checks)) {
        process.stdout.write(`  ${ICONS[s.status] ?? "?   "} ${name.padEnd(26)} ${s.detail}  (${s.at})\n`);
      }
      process.stdout.write("backups:\n");
      for (const [name, s] of Object.entries(backups)) {
        process.stdout.write(
          `  ${s.lastResult === "ok" ? "OK  " : "FAIL"} ${name.padEnd(26)} last ${s.lastSuccess ?? "never"}  ${s.lastDetail ?? ""}\n`,
        );
      }
      break;
    }

    case "diagnose": {
      const name = positional[0] ?? fail("usage: diagnose <check>");
      const check = findTarget({ checks: config.checks }, "checks", name);
      const state = store.readState("checks", {})[name];
      if (!state) fail(`check "${name}" has not run yet (run: server-tools check ${name})`);
      const { diagnose, gatherContext } = await import("./remediate.js");
      const incident = diagnose(check, state);
      if (!incident) {
        process.stdout.write(`${name} is healthy: ${state.detail ?? "ok"}\n`);
        break;
      }
      const ctx = await gatherContext(check, { docker });
      process.stdout.write(`${incident.severity.toUpperCase()}: ${incident.title}\n\n${incident.meaning}\n`);
      if (incident.causes?.length) {
        process.stdout.write(`\nLikely causes:\n${incident.causes.map((c) => `  - ${c}`).join("\n")}\n`);
      }
      if (ctx.reclaimableText) process.stdout.write(`\n${ctx.reclaimableText}\n`);
      if (ctx.top?.length) process.stdout.write(`\nBusiest containers:\n${ctx.top.map((t) => `  ${t.name.padEnd(28)} ${t.text}`).join("\n")}\n`);
      if (incident.actions?.length) {
        process.stdout.write(`\nSuggested actions (run: server-tools fix ${name} <id>):\n`);
        for (const a of incident.actions) process.stdout.write(`  ${a.id.padEnd(22)} ${a.label} [${a.kind}]\n`);
      }
      if (incident.guidance) process.stdout.write(`\nNote: ${incident.guidance}\n`);
      if (ctx.logs) process.stdout.write(`\nRecent logs (${check.container}):\n${ctx.logs.split("\n").map((l) => `  ${l}`).join("\n")}\n`);
      break;
    }

    case "fix": {
      const name = positional[0] ?? fail("usage: fix <check> [actionId]");
      const check = findTarget({ checks: config.checks }, "checks", name);
      const state = store.readState("checks", {})[name];
      if (!state) fail(`check "${name}" has not run yet`);
      const { diagnose, runAction } = await import("./remediate.js");
      const incident = diagnose(check, state);
      const actions = incident?.actions ?? [];
      if (!actions.length) fail(`no one-click action available for "${name}"; run: server-tools diagnose ${name}`);
      const chosen = positional[1] ? actions.find((a) => a.id === positional[1]) : actions[0];
      if (!chosen) fail(`no action "${positional[1]}" for "${name}"; options: ${actions.map((a) => a.id).join(", ")}`);
      const result = await runAction(chosen.id, { container: chosen.container, target: chosen.target }, { docker, store, config });
      process.stdout.write(`${result.ok ? "OK" : "FAILED"}: ${result.message}\n`);
      process.exit(result.ok ? 0 : 1);
      break;
    }

    case "login-link": {
      const email = positional[0] ?? fail("usage: login-link <email>");
      const { createLoginToken } = await import("./web/auth.js");
      const url = createLoginToken({ config, store, email });
      process.stdout.write(`${url}\n(valid 15 minutes, single use)\n`);
      break;
    }

    default:
      fail(`unknown command "${command}" (run with --help)`);
  }
}

main().catch((e) => fail(e.message));
