/**
 * Restore and restore-drill for postgres backup targets.
 *
 * restore: decrypt + gunzip an artifact and feed it to psql inside the
 * database container. Refuses to touch a non-empty database unless the caller
 * passes force (the runbook covers dropping/recreating first).
 *
 * drill: proves the whole chain (artifact -> decrypt -> psql) by restoring
 * into a throwaway database on the same container, counting tables and rows,
 * then dropping it. Records the result so the dashboard can show "last drill".
 */
import fsp from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { decryptBuffer, isEncryptedArtifact } from "./crypto.js";
import { S3 } from "./s3.js";
import { logger } from "../log.js";

const log = logger("restore");

/** Load an artifact (local first, offsite fallback) and return plain SQL. */
export async function loadArtifactSql(target, artifactName, { store }) {
  const localPath = path.join(store.backupDir(target.name), artifactName);
  let raw = null;
  try {
    raw = await fsp.readFile(localPath);
  } catch {
    if (target.s3) {
      const s3 = new S3(target.s3);
      raw = await s3.get(`${target.name}/${artifactName}`);
      if (raw) log.info(`fetched ${artifactName} from offsite storage`);
    }
  }
  if (!raw) throw new Error(`artifact ${artifactName} not found locally or offsite`);

  let compressed = raw;
  if (isEncryptedArtifact(raw)) {
    if (!target.passphrase) throw new Error("artifact is encrypted but no passphrase is configured");
    compressed = decryptBuffer(target.passphrase, raw);
  }
  return zlib.gunzipSync(compressed).toString("utf8");
}

/** Newest artifact name for a target, local first, offsite fallback. */
export async function latestArtifact(target, { store }) {
  const dir = store.backupDir(target.name);
  const local = (await fsp.readdir(dir).catch(() => []))
    .filter((f) => /\d{8}-\d{6}/.test(f) && !f.endsWith(".json"))
    .sort();
  if (local.length) return local[local.length - 1];
  if (target.s3) {
    const remote = (await new S3(target.s3).list(`${target.name}/`))
      .filter((f) => /\d{8}-\d{6}/.test(f) && !f.endsWith(".manifest.json"))
      .sort();
    if (remote.length) return remote[remote.length - 1].split("/").pop();
  }
  throw new Error(`no artifacts found for target "${target.name}"`);
}

/**
 * Feed SQL to psql inside the database container.
 *
 * The payload goes in over stdin. It must not go anywhere near a command
 * argument: the kernel caps a single argument at 128 KB (MAX_ARG_STRLEN), so
 * an argument-based restore works on a toy database and fails on a real one,
 * which is the worst possible time to find out. Nothing is written to disk in
 * the container either, so a dump of user data never lands on a filesystem it
 * did not already live on.
 */
async function psqlInput(docker, target, database, sql, extraArgs = []) {
  const run = await docker.exec(
    target.container,
    ["psql", "-U", target.user, "-d", database, "-v", "ON_ERROR_STOP=1", ...extraArgs, "-f", "-"],
    { stdin: Buffer.from(sql), timeoutMs: 60 * 60_000 },
  );
  if (run.exitCode !== 0) throw new Error(`psql exit ${run.exitCode}: ${run.stderr.trim().slice(0, 500)}`);
  return run;
}

async function scalar(docker, target, database, query) {
  const r = await docker.exec(target.container, ["psql", "-U", target.user, "-d", database, "-tAc", query]);
  if (r.exitCode !== 0) throw new Error(`psql query failed: ${r.stderr.trim().slice(0, 200)}`);
  return r.stdout.trim();
}

/** Restore an artifact into the target's database (or `intoDatabase`). */
export async function restore(target, { docker, store, artifact = null, intoDatabase = null, force = false }) {
  const name = artifact ?? (await latestArtifact(target, { store }));
  const database = intoDatabase ?? target.database;
  const sql = await loadArtifactSql(target, name, { store });

  if (!force) {
    const tables = Number(
      await scalar(docker, target, database, "SELECT count(*) FROM pg_tables WHERE schemaname='public'"),
    );
    if (tables > 0) {
      throw new Error(
        `database "${database}" already has ${tables} tables; pass --force to restore over it (see RUNBOOK.md)`,
      );
    }
  }

  await psqlInput(docker, target, database, sql);
  const tableCount = await scalar(
    docker,
    target,
    database,
    "SELECT count(*) FROM pg_tables WHERE schemaname='public'",
  );
  store.append("events", { topic: "restore", kind: "ok", name: target.name, detail: `${name} -> ${database} (${tableCount} tables)` });
  log.info(`restored ${name} into ${database}: ${tableCount} tables`);
  return { artifact: name, database, tables: Number(tableCount) };
}

/** Restore into a scratch database, validate, drop it, record the outcome. */
export async function drill(target, { docker, store, artifact = null }) {
  const scratch = `st_drill_${Date.now()}`;
  const startedAt = new Date();
  const name = artifact ?? (await latestArtifact(target, { store }));
  try {
    await scalar(docker, target, target.user, `CREATE DATABASE ${scratch}`).catch(async () => {
      // CREATE DATABASE cannot run via -tAc against itself on some images; use template1.
      const r = await docker.exec(target.container, ["psql", "-U", target.user, "-d", "template1", "-c", `CREATE DATABASE ${scratch}`]);
      if (r.exitCode !== 0) throw new Error(`create scratch db failed: ${r.stderr.trim().slice(0, 200)}`);
    });

    const result = await restore(target, { docker, store, artifact: name, intoDatabase: scratch, force: true });
    const rows = await scalar(
      docker,
      target,
      scratch,
      "SELECT coalesce(sum(n_live_tup),0) FROM pg_stat_user_tables",
    );

    const outcome = {
      lastDrill: startedAt.toISOString(),
      lastDrillResult: "ok",
      lastDrillDetail: `${name}: ${result.tables} tables, ~${rows} rows`,
    };
    const state = store.readState("backups", {});
    state[target.name] = { ...(state[target.name] ?? {}), ...outcome };
    store.writeState("backups", state);
    store.append("events", { topic: "drill", kind: "ok", name: target.name, detail: outcome.lastDrillDetail });
    log.info(`drill ok for ${target.name}: ${outcome.lastDrillDetail}`);
    return outcome;
  } catch (e) {
    const state = store.readState("backups", {});
    state[target.name] = {
      ...(state[target.name] ?? {}),
      lastDrill: startedAt.toISOString(),
      lastDrillResult: "fail",
      lastDrillDetail: e.message,
    };
    store.writeState("backups", state);
    store.append("events", { topic: "drill", kind: "fail", name: target.name, detail: e.message });
    throw e;
  } finally {
    await docker
      .exec(target.container, ["psql", "-U", target.user, "-d", "template1", "-c", `DROP DATABASE IF EXISTS ${scratch}`])
      .catch((e) => log.warn(`could not drop scratch db ${scratch}: ${e.message}`));
  }
}
