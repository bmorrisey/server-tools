/**
 * Backup engine.
 *
 * postgres targets: pg_dump runs inside the database container (docker exec),
 * streams through gzip and authenticated encryption straight to a local
 * artifact file, then optionally uploads to S3-compatible storage. Nothing is
 * ever decrypted on the way out; content that is ciphertext in the database
 * stays ciphertext in the artifact.
 *
 * files targets: media, wherever it lives. The source is declared, never
 * guessed - a host directory, a Docker volume, or a path inside a container.
 * Volume and container sources are read through the Engine's own copy
 * endpoint, which works on stopped containers, so a stack being down (exactly
 * when someone reaches for a backup) still produces a complete artifact
 * rather than a quietly partial one. Every run writes a manifest (relative
 * path, size, sha256) and, unless told otherwise, an encrypted archive.
 *
 * external targets: nothing is copied. They exist so a deployment whose media
 * lives in an S3-compatible bucket can say so, instead of the dashboard
 * showing all green for a deployment whose media has never been backed up.
 *
 * Two rules the artifact directory relies on:
 *   - Everything is written to "<name>.part" and renamed on success, so a
 *     process that dies mid-write leaves nothing that looks like a backup.
 *   - The manifest is written last. Its presence is what makes a run
 *     complete; a run that failed leaves a "<stamp>.failed.json" saying so.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { posix } from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { PassThrough, Transform, Writable, pipeline } from "node:stream";
import { pipeline as pipelineAsync } from "node:stream/promises";
import { encryptStream } from "./crypto.js";
import { TarScanner } from "./tar.js";
import { S3 } from "./s3.js";
import { planRetention, dateFromArtifactName } from "./retention.js";
import { fileStamp, formatBytes, withLock } from "../util.js";
import { logger } from "../log.js";

const log = logger("backup");

function s3For(target) {
  return target.s3 ? new S3(target.s3) : null;
}

function recordResult(store, target, patch) {
  const state = store.readState("backups", {});
  state[target.name] = { ...(state[target.name] ?? {}), ...patch };
  store.writeState("backups", state);
}

/* -------------------------------------------------------------------------
 * Where a files target's data lives
 * ---------------------------------------------------------------------- */

/**
 * Resolve a files target to exactly one source. This is deliberately strict:
 * the failure mode worth designing against is a target that silently falls
 * back to "a directory, probably" and produces a database-only backup of a
 * deployment whose media is somewhere else entirely.
 */
export function fileSource(target) {
  const s = target.source;
  if (s && typeof s === "object") {
    if (s.volume) return { kind: "volume", volume: s.volume, path: s.path ?? null };
    if (s.container) {
      if (!s.path) throw new Error(`files target "${target.name}": source.container needs source.path`);
      return { kind: "container", container: s.container, path: s.path };
    }
    if (s.path) return { kind: "path", path: s.path };
    throw new Error(`files target "${target.name}": source must name a volume, a container + path, or a path`);
  }
  if (typeof target.path === "string" && target.path) return { kind: "path", path: target.path };
  throw new Error(`files target "${target.name}": no source configured (set "source" or "path")`);
}

/**
 * Whether a run should write an archive as well as a manifest.
 *
 * A manifest alone verifies a tree that still exists; it restores nothing.
 * Targets that declare a `source` therefore archive by default. The older
 * top-level `path` form keeps its manifest-only default so existing configs
 * do not suddenly start filling the disk with tarballs.
 */
export function shouldArchive(target) {
  if (target.archive !== undefined) return Boolean(target.archive);
  return Boolean(target.source);
}

/** Human description of a source, for logs, manifests, and the dashboard. */
export function describeSource(src) {
  switch (src.kind) {
    case "volume":
      return `volume ${src.volume}${src.path ? `:${src.path}` : ""}`;
    case "container":
      return `container ${src.container}:${src.path}`;
    default:
      return src.path;
  }
}

/* -------------------------------------------------------------------------
 * Artifact plumbing
 * ---------------------------------------------------------------------- */

const PART_SUFFIX = ".part";

/**
 * Remove leftovers from a run that died mid-write. Never touches artifacts.
 *
 * The in-process lock does not span processes: a manual `server-tools backup`
 * can run while the agent is midway through a scheduled one. So this removes
 * only this run's own partials (by stamp), or ones old enough that nothing
 * can still be writing them. A live write keeps touching its file.
 */
async function clearPartials(dir, { stamp = null, staleMs = 60 * 60_000 } = {}) {
  for (const f of await fsp.readdir(dir).catch(() => [])) {
    if (!f.endsWith(PART_SUFFIX)) continue;
    if (stamp && f.includes(stamp)) {
      await fsp.rm(path.join(dir, f), { force: true });
      continue;
    }
    if (stamp) continue;
    const st = await fsp.stat(path.join(dir, f)).catch(() => null);
    if (st && Date.now() - st.mtimeMs > staleMs) await fsp.rm(path.join(dir, f), { force: true });
  }
}

/** Write bytes to "<file>.part" and rename on success. */
async function writeAtomic(fullPath, data) {
  const part = `${fullPath}${PART_SUFFIX}`;
  await fsp.writeFile(part, data);
  await fsp.rename(part, fullPath);
}

/** Record that a run did not finish, in the artifact directory itself. */
async function markFailed(dir, target, stamp, message) {
  const marker = path.join(dir, `${target.name}-${stamp}.failed.json`);
  const body = JSON.stringify({ target: target.name, at: new Date().toISOString(), error: String(message) }, null, 2);
  await fsp.writeFile(marker, body).catch((e) => log.warn(`could not write failure marker: ${e.message}`));
}

/* -------------------------------------------------------------------------
 * Runner
 * ---------------------------------------------------------------------- */

/** Run one backup target end to end. Returns the state patch it recorded. */
export async function runBackup(target, { docker, store }) {
  if (target.type === "external") {
    throw new Error(
      `"${target.name}" is an external target (${target.note ?? "outside this toolkit"}); it is declared, not backed up`,
    );
  }
  return withLock(`backup:${target.name}`, async () => {
    const startedAt = new Date();
    const stamp = fileStamp(startedAt);
    const dir = store.backupDir(target.name);
    await clearPartials(dir);
    try {
      const result =
        target.type === "postgres"
          ? await backupPostgres(target, stamp, { docker, store })
          : await backupFiles(target, stamp, { docker, store });
      const patch = {
        lastSuccess: startedAt.toISOString(),
        lastResult: "ok",
        lastDetail: result.detail,
        lastArtifact: result.artifact ?? null,
        lastSizeBytes: result.sizeBytes ?? null,
        lastDurationMs: Date.now() - startedAt.getTime(),
        offsite: result.offsite ?? false,
      };
      recordResult(store, target, patch);
      store.append("events", { topic: "backup", kind: "ok", name: target.name, detail: result.detail });
      log.info(`backup ${target.name}: ${result.detail}`);
      await prune(target, { store });
      return patch;
    } catch (e) {
      // Cleanup must never replace the error that caused it: the recorded
      // reason is the only thing an operator has to go on.
      await clearPartials(dir, { stamp }).catch(() => {});
      await markFailed(dir, target, stamp, e.message);
      const patch = { lastResult: "fail", lastDetail: e.message, lastAttempt: startedAt.toISOString() };
      recordResult(store, target, patch);
      store.append("events", { topic: "backup", kind: "fail", name: target.name, detail: e.message });
      log.error(`backup ${target.name} failed: ${e.message}`);
      throw e;
    }
  });
}

async function backupPostgres(target, stamp, { docker, store }) {
  const encrypted = target.encrypt !== false;
  const ext = encrypted ? "sql.gz.enc" : "sql.gz";
  const artifact = `${target.name}-${stamp}.${ext}`;
  const localPath = path.join(store.backupDir(target.name), artifact);
  const partPath = `${localPath}${PART_SUFFIX}`;

  const gzip = zlib.createGzip({ level: 6 });
  const file = fs.createWriteStream(partPath);
  const dumpStream = new PassThrough();

  let finished;
  if (encrypted) {
    finished = encryptStream(target.passphrase, dumpStream.pipe(gzip), file);
  } else {
    finished = new Promise((resolve, reject) =>
      pipeline(dumpStream, gzip, file, (e) => (e ? reject(e) : resolve())),
    );
  }

  const exec = await docker.exec(
    target.container,
    ["pg_dump", "-U", target.user, "-d", target.database, "--no-owner", "--no-privileges"],
    { stdoutStream: dumpStream, timeoutMs: 30 * 60_000 },
  );
  if (exec.exitCode !== 0) {
    file.destroy();
    await fsp.rm(partPath, { force: true });
    throw new Error(`pg_dump exit ${exec.exitCode}: ${exec.stderr.trim().slice(0, 300)}`);
  }
  await finished;

  const { size } = await fsp.stat(partPath);
  if (size < 512) throw new Error(`dump suspiciously small (${size} bytes); refusing to record success`);
  await fsp.rename(partPath, localPath);

  let offsite = false;
  const s3 = s3For(target);
  if (s3) {
    await s3.putFile(`${target.name}/${artifact}`, localPath);
    offsite = true;
  }
  return {
    artifact,
    sizeBytes: size,
    offsite,
    detail: `${formatBytes(size)}${encrypted ? ", encrypted" : ""}${offsite ? ", uploaded offsite" : ", local only"}`,
  };
}

/* -------------------------------------------------------------------------
 * files targets
 * ---------------------------------------------------------------------- */

/**
 * A run that copied nothing is a failure, not a small backup.
 *
 * The whole point of a media target is that "the app came up and every image
 * 404s" must not be discoverable only at restore time. An unmounted bind
 * mount, an empty volume destination, or a source path that is not a
 * directory all produce an archive with nothing in it - and the drill would
 * happily certify that archive against its equally empty manifest. Say no
 * here, or allow it explicitly with "allowEmpty".
 */
function assertNotEmpty(target, manifest, src, { dropped = 0 } = {}) {
  if (manifest.files.length > 0 || target.allowEmpty === true) return;
  const where = describeSource(src);
  if (dropped > 0) {
    throw new Error(
      `${where} is a file, not a directory; point "source.path" at the directory that holds the media`,
    );
  }
  throw new Error(
    `${where} holds no files; refusing to record an empty backup (set "allowEmpty": true if it really is empty)`,
  );
}

async function backupFiles(target, stamp, { docker, store }) {
  const src = fileSource(target);
  const dir = store.backupDir(target.name);
  const archiving = shouldArchive(target);
  const encrypted = target.encrypt !== false;
  const manifestName = `${target.name}-${stamp}.manifest.json`;
  const tarName = `${target.name}-${stamp}.tar.gz${encrypted ? ".enc" : ""}`;

  let manifest;
  let artifact = manifestName;
  let sizeBytes;

  if (src.kind === "path") {
    manifest = await buildManifest(src.path, target.exclude ?? []);
    assertNotEmpty(target, manifest, src);
    sizeBytes = manifest.totalBytes;
    if (archiving) {
      const tarPath = path.join(dir, tarName);
      await tarGz(src.path, `${tarPath}${PART_SUFFIX}`, encrypted ? target.passphrase : null, target.exclude ?? []);
      await fsp.rename(`${tarPath}${PART_SUFFIX}`, tarPath);
      artifact = tarName;
      sizeBytes = (await fsp.stat(tarPath)).size;
    }
  } else {
    const read = await readThroughDocker(target, src, {
      docker,
      outPath: archiving ? path.join(dir, tarName) : null,
      passphrase: encrypted ? target.passphrase : null,
    });
    manifest = read.manifest;
    sizeBytes = archiving ? read.archiveBytes : manifest.totalBytes;
    if (archiving) artifact = tarName;
  }

  let offsite = false;
  const s3 = s3For(target);
  if (s3) {
    if (archiving) await s3.putFile(`${target.name}/${artifact}`, path.join(dir, artifact));
    offsite = true;
  }

  // Manifest last, locally and offsite: its presence is what says the run
  // finished. A directory holding an archive and no manifest is a failed run.
  await writeAtomic(path.join(dir, manifestName), JSON.stringify(manifest, null, 2));
  if (s3) await s3.put(`${target.name}/${manifestName}`, Buffer.from(JSON.stringify(manifest)));

  const where = describeSource(src);
  return {
    artifact,
    sizeBytes,
    offsite,
    detail:
      `${manifest.files.length} files, ${formatBytes(manifest.totalBytes)} from ${where}` +
      `${archiving ? `, archived ${formatBytes(sizeBytes)}${encrypted ? " encrypted" : ""}` : ", manifest only"}` +
      `${offsite ? ", uploaded offsite" : ""}`,
  };
}

/** A Transform that indexes the tar flowing through it and passes bytes on. */
class ScanThrough extends Transform {
  constructor(scanner) {
    super();
    this.scanner = scanner;
  }

  _transform(chunk, _enc, cb) {
    try {
      this.scanner.update(chunk);
      cb(null, chunk);
    } catch (e) {
      cb(e);
    }
  }
}

/**
 * Read a volume or in-container path as a tar stream from the Engine,
 * indexing it and (when archiving) compressing and encrypting it in the same
 * pass. Returns { manifest, archiveBytes }.
 */
async function readThroughDocker(target, src, { docker, outPath, passphrase }) {
  const { containerId, containerName, containerPath } = await locateSource(docker, src, target.name);
  const stream = await docker.archive(containerId, containerPath);
  // The Engine roots the archive at the basename of the requested path, so a
  // manifest relative to that root drops exactly one leading component.
  const scanner = new TarScanner({ strip: 1 });
  const scan = new ScanThrough(scanner);

  let archiveBytes = 0;
  const partPath = outPath ? `${outPath}${PART_SUFFIX}` : null;
  if (partPath) {
    const gzip = zlib.createGzip({ level: 6 });
    const file = fs.createWriteStream(partPath);
    if (passphrase) {
      const compressed = new PassThrough();
      const gzipDone = pipelineAsync(stream, scan, gzip, compressed);
      const encryptDone = encryptStream(passphrase, compressed, file);
      await Promise.all([gzipDone, encryptDone]);
    } else {
      await pipelineAsync(stream, scan, gzip, file);
    }
    archiveBytes = (await fsp.stat(partPath)).size;
  } else {
    await pipelineAsync(stream, scan, new Writable({ write: (_c, _e, cb) => cb() }));
  }

  // Everything that can disqualify this run is decided while the archive is
  // still a .part file. Renaming first and checking after is how a truncated
  // tarball ends up wearing a real artifact name.
  const result = scanner.finish();
  if (!result.complete) {
    throw new Error(`archive stream from ${describeSource(src)} ended mid-entry; refusing to record a partial backup`);
  }
  const manifest = {
    root: null,
    source: { ...src, container: containerName, containerPath },
    generatedAt: new Date().toISOString(),
    files: result.files,
    totalBytes: result.files.reduce((sum, f) => sum + f.size, 0),
  };
  assertNotEmpty(target, manifest, src, { dropped: result.dropped });

  if (partPath) await fsp.rename(partPath, outPath);
  return { manifest, archiveBytes };
}

/**
 * Turn a declared source into the container and path to read it from.
 *
 * Failure here is reported, never defaulted. Treating "cannot tell" as "a
 * local directory, probably" is how a deployment whose media lives in a
 * bucket ends up with a database-only backup that looks complete.
 */
async function locateSource(docker, src, targetName) {
  if (src.kind === "container") {
    const container = await docker.findContainer(src.container);
    if (!container) {
      throw new Error(`files target "${targetName}": container "${src.container}" not found on this box`);
    }
    return { containerId: container.Id, containerName: src.container, containerPath: src.path };
  }
  const mount = await docker.findVolumeMount(src.volume);
  if (!mount) {
    const exists = await docker.inspectVolume(src.volume).catch(() => null);
    throw new Error(
      exists
        ? `files target "${targetName}": volume "${src.volume}" exists but no container mounts it, so its contents cannot be read`
        : `files target "${targetName}": no volume named "${src.volume}" on this box`,
    );
  }
  // A volume's `path` names a subdirectory of the volume, so it resolves
  // against where the volume is mounted. Sent to the Engine as-is it would
  // resolve against the container's working directory instead, and archive
  // something else entirely.
  const containerPath = src.path ? posix.join(mount.destination, src.path) : mount.destination;
  return { containerId: mount.id, containerName: mount.name, containerPath };
}

/** Walk a directory into { files: [{ path, size, sha256 }], totalBytes }. */
export async function buildManifest(root, exclude = []) {
  const files = [];
  let totalBytes = 0;
  async function walk(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (exclude.some((p) => rel === p || rel.startsWith(`${p}/`))) continue;
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const hash = crypto.createHash("sha256");
        await new Promise((resolve, reject) => {
          fs.createReadStream(full)
            .on("data", (c) => hash.update(c))
            .on("end", resolve)
            .on("error", reject);
        });
        const { size } = await fsp.stat(full);
        files.push({ path: rel, size, sha256: hash.digest("hex") });
        totalBytes += size;
      }
    }
  }
  await walk(root);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { root: path.resolve(root), generatedAt: new Date().toISOString(), files, totalBytes };
}

/**
 * Verify a previously written manifest against the live tree. Re-hashes up to
 * `sample` files (newest manifest entries first are not tracked, so a random
 * sample is used) and confirms existence + size for all.
 *
 * Only meaningful for manifests with a filesystem root; a manifest taken
 * through the Docker socket is verified against its archive instead (see
 * verifyArchive in restore.js).
 */
export async function verifyManifest(manifest, { sample = 25 } = {}) {
  if (!manifest.root) throw new Error("this manifest has no filesystem root; verify it against its archive instead");
  const problems = [];
  for (const f of manifest.files) {
    const full = path.join(manifest.root, f.path);
    try {
      const st = await fsp.stat(full);
      if (st.size !== f.size) problems.push(`${f.path}: size ${st.size} != ${f.size}`);
    } catch {
      problems.push(`${f.path}: missing`);
    }
  }
  const shuffled = [...manifest.files].sort(() => Math.random() - 0.5).slice(0, sample);
  for (const f of shuffled) {
    const full = path.join(manifest.root, f.path);
    try {
      const hash = crypto.createHash("sha256");
      await new Promise((resolve, reject) => {
        fs.createReadStream(full)
          .on("data", (c) => hash.update(c))
          .on("end", resolve)
          .on("error", reject);
      });
      if (hash.digest("hex") !== f.sha256) problems.push(`${f.path}: checksum mismatch`);
    } catch {
      // Missing already reported above.
    }
  }
  return { ok: problems.length === 0, checked: manifest.files.length, hashed: shuffled.length, problems: problems.slice(0, 50) };
}

/** tar+gzip a directory using the system tar binary, optionally encrypting. */
function tarGz(dir, outPath, passphrase, exclude = []) {
  return new Promise((resolve, reject) => {
    const args = ["-cz", ...exclude.flatMap((e) => ["--exclude", e]), "-C", dir, "."];
    const tar = spawn("tar", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    tar.stderr.on("data", (c) => (stderr += c));
    const file = fs.createWriteStream(outPath);
    const done = passphrase
      ? encryptStream(passphrase, tar.stdout, file)
      : new Promise((res, rej) => pipeline(tar.stdout, file, (e) => (e ? rej(e) : res())));
    tar.on("close", (code) => {
      if (code !== 0) reject(new Error(`tar exit ${code}: ${stderr.slice(0, 200)}`));
      else done.then(resolve, reject);
    });
    tar.on("error", reject);
  });
}

/* -------------------------------------------------------------------------
 * Retention
 * ---------------------------------------------------------------------- */

const isPartial = (f) => f.endsWith(PART_SUFFIX);
const isManifest = (f) => f.endsWith(".manifest.json");
const isFailureMarker = (f) => f.endsWith(".failed.json");
const stampOf = (f) => f.match(/\d{8}-\d{6}/)?.[0] ?? null;

/**
 * Whether the files left by one run add up to something restorable.
 *
 * This has to agree with the rule the writer follows, or retention will hand
 * a slot to a run that cannot be restored and evict one that can. A files
 * target writes its manifest last precisely so that its presence means "this
 * finished": an archive without one is the wreckage of a run that died after
 * renaming the tar into place. A postgres run has no manifest, so its dump is
 * the whole artifact.
 */
export function runIsRestorable(files, type) {
  if (type === "files") return files.some(isManifest);
  return files.some((f) => !f.endsWith(".json") && !isFailureMarker(f));
}

/**
 * What a prune would remove from a target directory, as a pure function over
 * the file names.
 *
 * Retention applies per run, not per file: a run leaves an archive and a
 * manifest, or just a manifest, or (when it failed) just a marker, and
 * dropping one of those without the others leaves the directory lying about
 * what is in it.
 *
 * Only restorable runs get a retention slot. Anything else - a failure
 * marker, an archive whose manifest never arrived - is kept while it is still
 * recent enough to be telling you something, and dropped once everything
 * retained is newer than it. Counting those as backups is how two bad nights
 * in a row would delete the last good one.
 */
const MAX_FAILURE_MARKERS = 10;

export function planPrune(names, retention, { type = "postgres" } = {}) {
  const partials = [];
  const runs = new Map();
  for (const name of names) {
    if (isPartial(name)) {
      partials.push(name);
      continue;
    }
    const stamp = stampOf(name);
    if (!stamp) continue;
    const run = runs.get(stamp) ?? { stamp, files: [] };
    run.files.push(name);
    runs.set(stamp, run);
  }
  for (const run of runs.values()) run.backup = runIsRestorable(run.files, type);

  const backups = [...runs.values()].filter((r) => r.backup);
  const plan = planRetention(
    backups.map((r) => ({ key: r.stamp, date: dateFromArtifactName(r.stamp) })),
    retention,
  );
  const oldestKept = [...plan.keep].sort()[0] ?? null;

  // A target that has never succeeded has no retained run to measure its
  // markers against, so cap them by count as well: an hourly schedule against
  // a misconfigured source would otherwise write thousands of them a year.
  const failedStamps = [...runs.values()]
    .filter((r) => !r.backup)
    .map((r) => r.stamp)
    .sort();
  const excessFailures = new Set(failedStamps.slice(0, Math.max(0, failedStamps.length - MAX_FAILURE_MARKERS)));

  const drop = [];
  let droppedRuns = 0;
  for (const run of [...runs.values()].sort((a, b) => a.stamp.localeCompare(b.stamp))) {
    const stale = run.backup
      ? !plan.keep.has(run.stamp)
      : (oldestKept !== null && run.stamp < oldestKept) || excessFailures.has(run.stamp);
    if (!stale) continue;
    drop.push(...run.files);
    droppedRuns++;
  }
  return { drop, partials, droppedRuns, keep: plan.keep };
}

/** Apply GFS retention to local artifacts and (when configured) offsite. */
export async function prune(target, { store }) {
  const dir = store.backupDir(target.name);
  const plan = planPrune(await fsp.readdir(dir), target.retention, { type: target.type });
  for (const key of plan.drop) {
    await fsp.rm(path.join(dir, key), { force: true });
  }

  const s3 = s3For(target);
  if (s3) {
    const remotePlan = planPrune(await s3.list(`${target.name}/`), target.retention, { type: target.type });
    for (const key of remotePlan.drop) await s3.delete(key);
    if (remotePlan.drop.length) log.info(`pruned ${remotePlan.droppedRuns} offsite runs for ${target.name}`);
  }
  if (plan.drop.length) log.info(`pruned ${plan.droppedRuns} local runs for ${target.name}`);
  return plan;
}
