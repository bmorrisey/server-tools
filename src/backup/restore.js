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
 *
 * files targets get the equivalent: the archive is read back byte for byte
 * and checked against the manifest its run wrote. A database restored without
 * its media is not a restore, so both halves have to be provable.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { Readable } from "node:stream";
import { decryptBuffer, isEncryptedArtifact } from "./crypto.js";
import { shouldArchive, verifyManifest } from "./backup.js";
import { scanTarStream } from "./tar.js";
import { S3 } from "./s3.js";
import { formatBytes } from "../util.js";
import { logger } from "../log.js";

const log = logger("restore");

/** Fetch an artifact's raw bytes: local first, offsite fallback. */
export async function loadArtifactBytes(target, artifactName, { store }) {
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
  if (!isEncryptedArtifact(raw)) return raw;
  if (!target.passphrase) throw new Error("artifact is encrypted but no passphrase is configured");
  return decryptBuffer(target.passphrase, raw);
}

/** Load an artifact (local first, offsite fallback) and return plain SQL. */
export async function loadArtifactSql(target, artifactName, { store }) {
  return zlib.gunzipSync(await loadArtifactBytes(target, artifactName, { store })).toString("utf8");
}

/**
 * An artifact is a file this toolkit can restore from. Manifests and failure
 * markers describe a run; a ".part" file is a run that never finished. None
 * of the three is something to restore, so none of them counts as "latest".
 */
const isRestorable = (f) => /\d{8}-\d{6}/.test(f) && !f.endsWith(".json") && !f.endsWith(".part");

/** Newest artifact name for a target, local first, offsite fallback. */
export async function latestArtifact(target, { store }) {
  const dir = store.backupDir(target.name);
  const local = (await fsp.readdir(dir).catch(() => [])).filter(isRestorable).sort();
  if (local.length) return local[local.length - 1];
  if (target.s3) {
    const remote = (await new S3(target.s3).list(`${target.name}/`))
      .map((f) => f.split("/").pop())
      .filter(isRestorable)
      .sort();
    if (remote.length) return remote[remote.length - 1];
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

/* -------------------------------------------------------------------------
 * files targets
 *
 * A database restore is proved by restoring it. A media archive is proved by
 * reading every byte back out of it and checking it against the manifest the
 * run wrote when it finished. That catches the two failures that matter: an
 * archive truncated mid-write, and an archive that no longer holds what the
 * manifest says it holds.
 * ---------------------------------------------------------------------- */

/** The manifest written by the same run as `artifactName`. */
async function loadRunManifest(target, artifactName, { store }) {
  const stamp = String(artifactName).match(/\d{8}-\d{6}/)?.[0];
  if (!stamp) throw new Error(`cannot tell which run "${artifactName}" belongs to`);
  const name = `${target.name}-${stamp}.manifest.json`;
  const localPath = path.join(store.backupDir(target.name), name);
  let raw = await fsp.readFile(localPath).catch(() => null);
  if (!raw && target.s3) raw = await new S3(target.s3).get(`${target.name}/${name}`);
  if (!raw) {
    throw new Error(`no manifest for ${artifactName}; the run that wrote it never finished, so it is not a backup`);
  }
  return JSON.parse(raw.toString("utf8"));
}

/** Compare a scanned archive against the manifest of the same run. */
export function compareToManifest(scan, manifest) {
  const problems = [];
  if (!scan.complete) problems.push("archive ends mid-entry (truncated)");
  const inArchive = new Map(scan.files.map((f) => [f.path, f]));
  for (const want of manifest.files ?? []) {
    const got = inArchive.get(want.path);
    if (!got) {
      problems.push(`${want.path}: missing from archive`);
      continue;
    }
    inArchive.delete(want.path);
    if (got.size !== want.size) problems.push(`${want.path}: size ${got.size} != ${want.size}`);
    else if (got.sha256 !== want.sha256) problems.push(`${want.path}: checksum mismatch`);
  }
  for (const extra of inArchive.keys()) problems.push(`${extra}: in archive but not in the manifest`);
  return {
    ok: problems.length === 0,
    checked: manifest.files?.length ?? 0,
    bytes: scan.totalBytes,
    problems: problems.slice(0, 50),
  };
}

/**
 * Read an archive back and check it against its manifest. Decryption needs
 * the whole ciphertext in memory (the GCM tag is at the end), but the
 * decompressed tar is streamed through the scanner, so a large media archive
 * never lands in memory expanded.
 */
export async function verifyArchive(target, { store, artifact = null }) {
  const name = artifact ?? (await latestArtifact(target, { store }));
  const manifest = await loadRunManifest(target, name, { store });
  const compressed = await loadArtifactBytes(target, name, { store });
  // A manifest with a filesystem root came from `tar -C dir .`, so its paths
  // are already relative; one taken through the Docker socket is rooted at
  // the basename of the copied path and drops that component.
  const strip = manifest.root ? 0 : 1;
  const scan = await scanTarStream(Readable.from(compressed).pipe(zlib.createGunzip()), { strip });
  return { artifact: name, ...compareToManifest(scan, manifest) };
}

/**
 * Prove a files target restores: verify its newest archive against the
 * manifest, or, for a manifest-only target, re-check the live tree it
 * describes. Records the outcome the same way a database drill does.
 */
export async function drillFiles(target, { store, artifact = null }) {
  const startedAt = new Date();
  const finish = (result, detail) => {
    const state = store.readState("backups", {});
    state[target.name] = {
      ...(state[target.name] ?? {}),
      lastDrill: startedAt.toISOString(),
      lastDrillResult: result,
      lastDrillDetail: detail,
    };
    store.writeState("backups", state);
    store.append("events", { topic: "drill", kind: result === "ok" ? "ok" : "fail", name: target.name, detail });
  };

  try {
    let detail;
    if (shouldArchive(target)) {
      const v = await verifyArchive(target, { store, artifact });
      if (!v.ok) throw new Error(`${v.artifact}: ${v.problems.slice(0, 5).join("; ")}`);
      detail = `${v.artifact}: ${v.checked} files, ${formatBytes(v.bytes)} read back and matched`;
    } else {
      const manifest = await loadLatestManifest(target, { store });
      const v = await verifyManifest(manifest);
      if (!v.ok) throw new Error(v.problems.slice(0, 5).join("; "));
      detail = `manifest only: ${v.checked} files present, ${v.hashed} re-hashed and matched`;
    }
    finish("ok", detail);
    log.info(`drill ok for ${target.name}: ${detail}`);
    return { lastDrill: startedAt.toISOString(), lastDrillResult: "ok", lastDrillDetail: detail };
  } catch (e) {
    finish("fail", e.message);
    throw e;
  }
}

/** Newest manifest for a target, for manifest-only files targets. */
async function loadLatestManifest(target, { store }) {
  const dir = store.backupDir(target.name);
  const names = (await fsp.readdir(dir).catch(() => [])).filter((f) => f.endsWith(".manifest.json")).sort();
  if (!names.length) throw new Error(`no manifest recorded for target "${target.name}"`);
  return JSON.parse(await fsp.readFile(path.join(dir, names[names.length - 1]), "utf8"));
}
