/**
 * Backup engine.
 *
 * postgres targets: pg_dump runs inside the database container (docker exec),
 * streams through gzip and authenticated encryption straight to a local
 * artifact file, then optionally uploads to S3-compatible storage. Nothing is
 * ever decrypted on the way out; content that is ciphertext in the database
 * stays ciphertext in the artifact.
 *
 * files targets: a manifest (path, size, sha256 per file) is always produced;
 * with { archive: true } a .tar.gz of the directory is built, encrypted, and
 * treated like a dump artifact. Verification re-hashes a sample.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { PassThrough, pipeline } from "node:stream";
import { encryptStream } from "./crypto.js";
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

/** Run one backup target end to end. Returns the state patch it recorded. */
export async function runBackup(target, { docker, store }) {
  return withLock(`backup:${target.name}`, async () => {
    const startedAt = new Date();
    try {
      const result =
        target.type === "postgres"
          ? await backupPostgres(target, { docker, store })
          : await backupFiles(target, { store });
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
      const patch = { lastResult: "fail", lastDetail: e.message, lastAttempt: startedAt.toISOString() };
      recordResult(store, target, patch);
      store.append("events", { topic: "backup", kind: "fail", name: target.name, detail: e.message });
      log.error(`backup ${target.name} failed: ${e.message}`);
      throw e;
    }
  });
}

async function backupPostgres(target, { docker, store }) {
  const stamp = fileStamp();
  const encrypted = target.encrypt !== false;
  const ext = encrypted ? "sql.gz.enc" : "sql.gz";
  const artifact = `${target.name}-${stamp}.${ext}`;
  const localPath = path.join(store.backupDir(target.name), artifact);

  const gzip = zlib.createGzip({ level: 6 });
  const file = fs.createWriteStream(localPath);
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
    await fsp.rm(localPath, { force: true });
    throw new Error(`pg_dump exit ${exec.exitCode}: ${exec.stderr.trim().slice(0, 300)}`);
  }
  await finished;

  const { size } = await fsp.stat(localPath);
  if (size < 512) throw new Error(`dump suspiciously small (${size} bytes); refusing to record success`);

  let offsite = false;
  const s3 = s3For(target);
  if (s3) {
    await s3.put(`${target.name}/${artifact}`, await fsp.readFile(localPath));
    offsite = true;
  }
  return {
    artifact,
    sizeBytes: size,
    offsite,
    detail: `${formatBytes(size)}${encrypted ? ", encrypted" : ""}${offsite ? ", uploaded offsite" : ", local only"}`,
  };
}

async function backupFiles(target, { store }) {
  const manifest = await buildManifest(target.path, target.exclude ?? []);
  const stamp = fileStamp();
  const manifestName = `${target.name}-${stamp}.manifest.json`;
  const dir = store.backupDir(target.name);
  await fsp.writeFile(path.join(dir, manifestName), JSON.stringify(manifest, null, 2));

  let artifact = manifestName;
  let sizeBytes = manifest.totalBytes;
  let offsite = false;
  const s3 = s3For(target);

  if (target.archive) {
    const encrypted = target.encrypt !== false;
    const tarName = `${target.name}-${stamp}.tar.gz${encrypted ? ".enc" : ""}`;
    const tarPath = path.join(dir, tarName);
    await tarGz(target.path, tarPath, encrypted ? target.passphrase : null, target.exclude ?? []);
    artifact = tarName;
    sizeBytes = (await fsp.stat(tarPath)).size;
    if (s3) {
      await s3.put(`${target.name}/${tarName}`, await fsp.readFile(tarPath));
      offsite = true;
    }
  }
  if (s3) {
    await s3.put(`${target.name}/${manifestName}`, Buffer.from(JSON.stringify(manifest)));
    offsite = true;
  }
  return {
    artifact,
    sizeBytes,
    offsite,
    detail: `${manifest.files.length} files, ${formatBytes(manifest.totalBytes)}${target.archive ? ", archived" : ""}${offsite ? ", uploaded offsite" : ""}`,
  };
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
 */
export async function verifyManifest(manifest, { sample = 25 } = {}) {
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

/** Apply GFS retention to local artifacts and (when configured) offsite. */
export async function prune(target, { store }) {
  const dir = store.backupDir(target.name);
  const isArtifact = (f) => !f.endsWith(".json") && dateFromArtifactName(f);
  const local = (await fsp.readdir(dir)).filter(isArtifact).map((f) => ({ key: f, date: dateFromArtifactName(f) }));
  const plan = planRetention(local, target.retention);
  for (const key of plan.drop) {
    await fsp.rm(path.join(dir, key), { force: true });
  }
  // Manifests ride along with their artifact stamp; prune the orphans too.
  const keptStamps = new Set([...plan.keep].map((k) => k.match(/\d{8}-\d{6}/)?.[0]).filter(Boolean));
  for (const f of await fsp.readdir(dir)) {
    const stamp = f.match(/\d{8}-\d{6}/)?.[0];
    if (f.endsWith(".manifest.json") && stamp && !keptStamps.has(stamp)) {
      await fsp.rm(path.join(dir, f), { force: true });
    }
  }

  const s3 = s3For(target);
  if (s3) {
    const remote = (await s3.list(`${target.name}/`))
      .map((k) => ({ key: k, date: dateFromArtifactName(k) }))
      .filter((a) => a.date && !a.key.endsWith(".manifest.json"));
    const remotePlan = planRetention(remote, target.retention);
    for (const key of remotePlan.drop) await s3.delete(key);
    if (remotePlan.drop.length) log.info(`pruned ${remotePlan.drop.length} offsite artifacts for ${target.name}`);
  }
  if (plan.drop.length) log.info(`pruned ${plan.drop.length} local artifacts for ${target.name}`);
  return plan;
}
