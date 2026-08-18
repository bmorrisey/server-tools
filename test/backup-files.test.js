/**
 * End to end for media backups that come out of Docker rather than off the
 * local filesystem: run the target, then prove the archive it wrote matches
 * the manifest it wrote. The Docker layer is stubbed with a real tar stream,
 * which is exactly what the Engine's archive endpoint hands back.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { Store } from "../src/store.js";
import { runBackup } from "../src/backup/backup.js";
import { Readable } from "node:stream";
import { compareToManifest, drillFiles, exportArtifact, latestArtifact, verifyArchive } from "../src/backup/restore.js";
import { scanTarStream } from "../src/backup/tar.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "st-media-"));
  const src = path.join(root, "src");
  fs.mkdirSync(path.join(src, "storage", "photos"), { recursive: true });
  fs.writeFileSync(path.join(src, "storage", "photos", "one.jpg"), Buffer.alloc(2048, 1));
  fs.writeFileSync(path.join(src, "storage", "notes.txt"), "keep me");
  const tarPath = path.join(root, "media.tar");
  assert.equal(spawnSync("tar", ["-cf", tarPath, "-C", src, "storage"]).status, 0);
  const store = new Store(path.join(root, "data"));
  store.ensureDirs();
  return { root, tarPath, store };
}

/** A Docker stub that answers exactly the calls a volume source makes. */
function stubDocker(tarPath, { archive } = {}) {
  return {
    findVolumeMount: async (name) =>
      name === "app_media" ? { id: "cid", name: "app-1", destination: "/app/storage" } : null,
    inspectVolume: async (name) => {
      if (name !== "app_media") throw new Error("no such volume");
      return { Name: "app_media" };
    },
    findContainer: async () => ({ Id: "cid" }),
    archive: archive ?? (async () => fs.createReadStream(tarPath)),
  };
}

const target = (extra = {}) => ({
  name: "media",
  type: "files",
  source: { volume: "app_media" },
  encrypt: false,
  ...extra,
});

test("a volume-sourced files backup writes an archive plus a manifest, and nothing partial", async () => {
  const { root, tarPath, store } = fixture();
  try {
    const patch = await runBackup(target(), { docker: stubDocker(tarPath), store });
    assert.equal(patch.lastResult, "ok");
    assert.match(patch.lastDetail, /2 files/);
    assert.match(patch.lastDetail, /volume app_media/);

    const files = fs.readdirSync(store.backupDir("media"));
    assert.equal(files.filter((f) => f.endsWith(".tar.gz")).length, 1);
    assert.equal(files.filter((f) => f.endsWith(".manifest.json")).length, 1);
    assert.equal(files.filter((f) => f.endsWith(".part")).length, 0);
    assert.equal(files.filter((f) => f.endsWith(".failed.json")).length, 0);

    const manifest = JSON.parse(
      fs.readFileSync(path.join(store.backupDir("media"), files.find((f) => f.endsWith(".manifest.json"))), "utf8"),
    );
    // Paths are relative to the copied directory, not rooted at its basename.
    assert.deepEqual(manifest.files.map((f) => f.path).sort(), ["notes.txt", "photos/one.jpg"]);
    assert.equal(manifest.root, null);
    assert.equal(manifest.source.kind, "volume");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a drill reads the archive back and matches it against the manifest", async () => {
  const { root, tarPath, store } = fixture();
  try {
    await runBackup(target(), { docker: stubDocker(tarPath), store });
    const result = await drillFiles(target(), { store });
    assert.equal(result.lastDrillResult, "ok");
    assert.match(result.lastDrillDetail, /2 files/);
    assert.match(result.lastDrillDetail, /read back and matched/);

    const verified = await verifyArchive(target(), { store });
    assert.equal(verified.ok, true);
    assert.equal(verified.checked, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a drill fails when the archive no longer holds what the manifest says", async () => {
  const { root, tarPath, store } = fixture();
  try {
    await runBackup(target(), { docker: stubDocker(tarPath), store });
    const dir = store.backupDir("media");
    const archive = fs.readdirSync(dir).find((f) => f.endsWith(".tar.gz"));
    const bytes = fs.readFileSync(path.join(dir, archive));
    fs.writeFileSync(path.join(dir, archive), bytes.subarray(0, Math.floor(bytes.length / 2)));

    await assert.rejects(() => drillFiles(target(), { store }));
    const state = store.readState("backups", {});
    assert.equal(state.media.lastDrillResult, "fail");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a drill fails when the run that wrote the archive never finished", async () => {
  const { root, tarPath, store } = fixture();
  try {
    await runBackup(target(), { docker: stubDocker(tarPath), store });
    const dir = store.backupDir("media");
    fs.rmSync(path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith(".manifest.json"))));
    await assert.rejects(() => drillFiles(target(), { store }), /never finished/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a failed run leaves a marker and no artifact", async () => {
  const { root, tarPath, store } = fixture();
  try {
    const docker = stubDocker(tarPath, {
      archive: async () => {
        throw new Error("container is gone");
      },
    });
    await assert.rejects(() => runBackup(target(), { docker, store }), /container is gone/);
    const files = fs.readdirSync(store.backupDir("media"));
    assert.equal(files.filter((f) => f.endsWith(".failed.json")).length, 1);
    assert.equal(files.filter((f) => f.endsWith(".tar.gz")).length, 0);
    assert.equal(files.filter((f) => f.endsWith(".part")).length, 0);
    const marker = JSON.parse(fs.readFileSync(path.join(store.backupDir("media"), files[0]), "utf8"));
    assert.equal(marker.target, "media");
    assert.match(marker.error, /container is gone/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a stream that stops mid-archive is refused rather than recorded as a backup", async () => {
  const { root, tarPath, store } = fixture();
  try {
    const bytes = fs.readFileSync(tarPath);
    let end = bytes.length;
    while (end > 0 && bytes[end - 1] === 0) end--;
    const docker = stubDocker(tarPath, {
      archive: async () => {
        const { Readable } = await import("node:stream");
        return Readable.from([bytes.subarray(0, Math.ceil(end / 512) * 512)]);
      },
    });
    await assert.rejects(() => runBackup(target(), { docker, store }), /ended mid-entry/);
    const files = fs.readdirSync(store.backupDir("media"));
    assert.equal(files.filter((f) => f.endsWith(".manifest.json")).length, 0);
    assert.equal(files.filter((f) => f.endsWith(".failed.json")).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an encrypted media archive round-trips through the drill", async () => {
  const { root, tarPath, store } = fixture();
  try {
    const t = target({ encrypt: true, passphrase: "a passphrase long enough" });
    await runBackup(t, { docker: stubDocker(tarPath), store });
    const files = fs.readdirSync(store.backupDir("media"));
    assert.equal(files.filter((f) => f.endsWith(".tar.gz.enc")).length, 1);
    const result = await drillFiles(t, { store });
    assert.equal(result.lastDrillResult, "ok");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a source naming a volume that is not there fails instead of backing up nothing", async () => {
  const { root, tarPath, store } = fixture();
  try {
    const docker = stubDocker(tarPath);
    await assert.rejects(
      () => runBackup(target({ source: { volume: "not_here" } }), { docker, store }),
      /no volume named "not_here"/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a volume that exists but nothing mounts says so rather than producing an empty backup", async () => {
  const { root, tarPath, store } = fixture();
  try {
    const docker = { ...stubDocker(tarPath), findVolumeMount: async () => null };
    await assert.rejects(
      () => runBackup(target(), { docker, store }),
      /no container mounts it/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a source that holds nothing is a failure, not a small backup", async () => {
  const { root, store } = fixture();
  try {
    const empty = path.join(root, "empty");
    fs.mkdirSync(path.join(empty, "storage"), { recursive: true });
    const emptyTar = path.join(root, "empty.tar");
    assert.equal(spawnSync("tar", ["-cf", emptyTar, "-C", empty, "storage"]).status, 0);
    await assert.rejects(
      () => runBackup(target(), { docker: stubDocker(emptyTar), store }),
      /holds no files/,
    );
    const files = fs.readdirSync(store.backupDir("media"));
    assert.equal(files.filter((f) => f.endsWith(".tar.gz")).length, 0);
    assert.equal(files.filter((f) => f.endsWith(".failed.json")).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an empty source can be accepted deliberately", async () => {
  const { root, store } = fixture();
  try {
    const empty = path.join(root, "empty");
    fs.mkdirSync(path.join(empty, "storage"), { recursive: true });
    const emptyTar = path.join(root, "empty.tar");
    spawnSync("tar", ["-cf", emptyTar, "-C", empty, "storage"]);
    const patch = await runBackup(target({ allowEmpty: true }), { docker: stubDocker(emptyTar), store });
    assert.equal(patch.lastResult, "ok");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a source pointing at a file rather than a directory says so", async () => {
  const { root, store } = fixture();
  try {
    // The Engine roots a single-file archive at the file name, which the
    // one-component strip removes; that must not read as "no files".
    const single = path.join(root, "single");
    fs.mkdirSync(single, { recursive: true });
    fs.writeFileSync(path.join(single, "app.db"), "not a directory");
    const singleTar = path.join(root, "single.tar");
    assert.equal(spawnSync("tar", ["-cf", singleTar, "-C", single, "app.db"]).status, 0);
    await assert.rejects(
      () => runBackup(target(), { docker: stubDocker(singleTar), store }),
      /is a file, not a directory/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("excludes drop the same files from the archive and the manifest", async () => {
  // The trap: tar's default matching is an unanchored glob, so "cache" would
  // also drop "sub/cache" while buildManifest kept it. The backup reports
  // success and every drill from then on fails with a nonsense message.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "st-excl-"));
  try {
    const media = path.join(root, "media");
    fs.mkdirSync(path.join(media, "cache"), { recursive: true });
    fs.mkdirSync(path.join(media, "sub", "cache"), { recursive: true });
    fs.writeFileSync(path.join(media, "cache", "a"), "a");
    fs.writeFileSync(path.join(media, "sub", "cache", "b"), "b");
    fs.writeFileSync(path.join(media, "keep.txt"), "keep");
    const store = new Store(path.join(root, "data"));
    store.ensureDirs();

    const t = { name: "media", type: "files", path: media, archive: true, encrypt: false, exclude: ["cache"] };
    const patch = await runBackup(t, { docker: null, store });
    assert.match(patch.lastDetail, /^2 files/);

    const result = await drillFiles(t, { store });
    assert.equal(result.lastDrillResult, "ok");

    const verified = await verifyArchive(t, { store });
    assert.equal(verified.ok, true, JSON.stringify(verified.problems));
    assert.equal(verified.checked, 2); // keep.txt and sub/cache/b
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an offsite failure cannot turn a complete local backup into wreckage", async () => {
  const { root, tarPath, store } = fixture();
  try {
    // The manifest is the completeness marker, so it has to be on disk before
    // anything is uploaded; otherwise a 503 leaves an archive nothing will
    // restore from and retention eventually evicts.
    const failing = {
      ...target(),
      s3: { bucket: "b", region: "auto", accessKeyId: "k", secretAccessKey: "s" },
    };
    const { S3 } = await import("../src/backup/s3.js");
    const originalPutFile = S3.prototype.putFile;
    S3.prototype.putFile = async () => {
      throw new Error("S3 PUT -> 503: SlowDown");
    };
    try {
      await assert.rejects(() => runBackup(failing, { docker: stubDocker(tarPath), store }), /503/);
    } finally {
      S3.prototype.putFile = originalPutFile;
    }
    const files = fs.readdirSync(store.backupDir("media"));
    assert.equal(files.filter((f) => f.endsWith(".manifest.json")).length, 1, "the local run is still complete");
    const { planPrune } = await import("../src/backup/backup.js");
    assert.equal(planPrune(files, { daily: 7 }, { type: "files" }).keep.size, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a large encrypted archive is drilled without being held in memory", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "st-big-"));
  try {
    const src = path.join(root, "src");
    fs.mkdirSync(path.join(src, "storage"), { recursive: true });
    // Incompressible, so the artifact is genuinely this size on disk.
    fs.writeFileSync(path.join(src, "storage", "blob.bin"), crypto.randomBytes(24 * 1024 * 1024));
    const tarPath = path.join(root, "big.tar");
    assert.equal(spawnSync("tar", ["-cf", tarPath, "-C", src, "storage"]).status, 0);
    const store = new Store(path.join(root, "data"));
    store.ensureDirs();

    const t = target({ encrypt: true, passphrase: "a passphrase long enough" });
    await runBackup(t, { docker: stubDocker(tarPath), store });
    const before = process.memoryUsage().heapUsed;
    const result = await drillFiles(t, { store });
    const grew = process.memoryUsage().heapUsed - before;
    assert.equal(result.lastDrillResult, "ok");
    // Streaming, not buffering: the whole artifact would be several times this.
    assert.ok(grew < 16 * 1024 * 1024, `drill grew the heap by ${Math.round(grew / 1024 / 1024)} MiB`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("hardlinked media does not break the drill", async () => {
  // A directory walk sees both names as ordinary files; tar writes the second
  // as a link with no body. Ignoring the link would leave the manifest
  // listing a file the archive appears not to contain, and the drill failing
  // forever on a backup that is perfectly good.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "st-link-"));
  try {
    const media = path.join(root, "media");
    fs.mkdirSync(media, { recursive: true });
    fs.writeFileSync(path.join(media, "a.jpg"), "the same bytes");
    fs.linkSync(path.join(media, "a.jpg"), path.join(media, "b.jpg"));
    const store = new Store(path.join(root, "data"));
    store.ensureDirs();

    const t = { name: "media", type: "files", path: media, archive: true, encrypt: false };
    const patch = await runBackup(t, { docker: null, store });
    assert.match(patch.lastDetail, /^2 files/);

    const verified = await verifyArchive(t, { store });
    assert.equal(verified.ok, true, JSON.stringify(verified.problems));
    assert.equal((await drillFiles(t, { store })).lastDrillResult, "ok");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a drill on a corrupt encrypted archive fails instead of hanging", async () => {
  const { root, tarPath, store } = fixture();
  try {
    const t = target({ encrypt: true, passphrase: "a passphrase long enough" });
    await runBackup(t, { docker: stubDocker(tarPath), store });
    const dir = store.backupDir("media");
    const name = fs.readdirSync(dir).find((f) => f.endsWith(".tar.gz.enc"));
    const bytes = fs.readFileSync(path.join(dir, name));
    bytes[bytes.length - 1] ^= 0xff; // flip a bit in the authentication tag
    fs.writeFileSync(path.join(dir, name), bytes);

    // The failure has to arrive as a rejection: a drill that never returns
    // records nothing, alerts nobody, and hangs the dashboard request that
    // started it. Bit rot is exactly what this is for.
    await assert.rejects(
      () => Promise.race([
        drillFiles(t, { store }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("drill hung")), 5000)),
      ]),
      (e) => !/drill hung/.test(e.message),
    );
    assert.equal(store.readState("backups", {}).media.lastDrillResult, "fail");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a truncated encrypted archive fails the drill too", async () => {
  const { root, tarPath, store } = fixture();
  try {
    const t = target({ encrypt: true, passphrase: "a passphrase long enough" });
    await runBackup(t, { docker: stubDocker(tarPath), store });
    const dir = store.backupDir("media");
    const name = fs.readdirSync(dir).find((f) => f.endsWith(".tar.gz.enc"));
    const bytes = fs.readFileSync(path.join(dir, name));
    fs.writeFileSync(path.join(dir, name), bytes.subarray(0, bytes.length - 8));
    await assert.rejects(
      () => Promise.race([
        drillFiles(t, { store }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("drill hung")), 5000)),
      ]),
      (e) => !/drill hung/.test(e.message),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a hardlink whose target has a long path is still resolved", async () => {
  // Over 100 bytes the target does not fit the ustar header field, so it
  // arrives as a GNU 'K' record or a PAX linkpath. Reading only the header
  // would truncate it, miss the lookup, and drop the entry - the same
  // manifest-versus-archive disagreement one route over. Which of the two
  // names tar archives first is readdir order, so this is intermittent per
  // directory and permanent once it happens.
  for (const format of ["gnu", "pax"]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "st-link2-"));
    try {
      const media = path.join(root, "media");
      const deep = path.join(media, "a".repeat(60), "b".repeat(60));
      fs.mkdirSync(deep, { recursive: true });
      const original = path.join(deep, "photo-original.jpg");
      fs.writeFileSync(original, "the same bytes");
      fs.linkSync(original, path.join(media, "thumb.jpg"));
      const store = new Store(path.join(root, "data"));
      store.ensureDirs();

      const tarPath = path.join(root, "media.tar");
      assert.equal(spawnSync("tar", [`--format=${format}`, "-cf", tarPath, "-C", root, "media"]).status, 0);
      const scan = await scanTarStream(fs.createReadStream(tarPath), { strip: 1 });
      assert.equal(scan.unresolvedLinks, 0, `${format}: link target not resolved`);
      assert.equal(scan.files.length, 2, format);
      const [one, two] = scan.files;
      assert.equal(one.sha256, two.sha256, `${format}: a link must carry the target's bytes`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("a link the scanner cannot resolve fails the run rather than under-reporting", async () => {
  const { root, store } = fixture();
  try {
    // A link entry whose target never appears in the stream. On a docker
    // source the manifest IS the scan, so dropping it would leave archive and
    // manifest agreeing that the file was never there.
    const orphan = path.join(root, "orphan.tar");
    const header = Buffer.alloc(512);
    header.write("storage/thumb.jpg", 0, 100, "utf8");
    header.write("0000644\0", 100, 8, "latin1");
    header.write("0000000\0", 108, 8, "latin1");
    header.write("0000000\0", 116, 8, "latin1");
    header.write(`${(0).toString(8).padStart(11, "0")}\0`, 124, 12, "latin1");
    header.write("00000000000\0", 136, 12, "latin1");
    header.write("        ", 148, 8, "latin1");
    header.write("1", 156, 1, "latin1");
    header.write("storage/gone.jpg", 157, 100, "utf8");
    header.write("ustar\0", 257, 6, "latin1");
    header.write("00", 263, 2, "latin1");
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += header[i];
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "latin1");
    fs.writeFileSync(orphan, Buffer.concat([header, Buffer.alloc(1024)]));

    await assert.rejects(
      () => runBackup(target(), { docker: stubDocker(orphan), store }),
      /could not be resolved/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a failed export leaves nothing behind, so the retry is not blocked", async () => {
  const { root, tarPath, store } = fixture();
  try {
    const t = target({ encrypt: true, passphrase: "a passphrase long enough" });
    await runBackup(t, { docker: stubDocker(tarPath), store });
    const dir = store.backupDir("media");
    const name = fs.readdirSync(dir).find((f) => f.endsWith(".tar.gz.enc"));
    const bytes = fs.readFileSync(path.join(dir, name));
    bytes[bytes.length - 1] ^= 0xff;
    fs.writeFileSync(path.join(dir, name), bytes);

    const dest = path.join(root, "out.tar.gz");
    await assert.rejects(() => exportArtifact(t, name, dest, { store }));
    // Half a decrypted artifact left at dest would then trip the exclusive
    // create and tell the operator to pick a different path.
    assert.equal(fs.existsSync(dest), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a manifest-only docker-sourced target says why it cannot be drilled", async () => {
  const { root, tarPath, store } = fixture();
  try {
    // Config validation refuses this combination, but a target that predates
    // the rule, or one hand-edited, must still get a sentence it can act on
    // rather than an internal message about filesystem roots.
    const t = target({ archive: false });
    await runBackup(t, { docker: stubDocker(tarPath), store });
    await assert.rejects(() => drillFiles(t, { store }), /set "archive": true to make it provable/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a failed drill does not leak the file descriptor it was reading", async () => {
  const { root, tarPath, store } = fixture();
  try {
    const t = target({ encrypt: true, passphrase: "a passphrase long enough" });
    await runBackup(t, { docker: stubDocker(tarPath), store });
    const dir = store.backupDir("media");
    const name = fs.readdirSync(dir).find((f) => f.endsWith(".tar.gz.enc"));

    // Decrypts cleanly, then fails in gunzip: the error travels the opposite
    // way from a corrupt tag, so it is the direction that strands the source.
    const { encryptStream } = await import("../src/backup/crypto.js");
    const sink = fs.createWriteStream(path.join(dir, name));
    await encryptStream("a passphrase long enough", Readable.from([Buffer.alloc(200_000, 0x41)]), sink);

    const openArtifacts = () =>
      fs
        .readdirSync("/proc/self/fd")
        .map((fd) => {
          try {
            return fs.readlinkSync(`/proc/self/fd/${fd}`);
          } catch {
            return "";
          }
        })
        .filter((target) => target.includes(dir)).length;

    const baseline = openArtifacts();
    for (let i = 0; i < 6; i++) await verifyArchive(t, { store }).catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    // One descriptor per attempt, held for the life of the agent, on exactly
    // the corrupt archive an operator retries.
    assert.equal(openArtifacts(), baseline);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("export refuses to overwrite, leaving the existing file untouched", async () => {
  const { root, tarPath, store } = fixture();
  try {
    const t = target();
    await runBackup(t, { docker: stubDocker(tarPath), store });
    const name = fs.readdirSync(store.backupDir("media")).find((f) => f.endsWith(".tar.gz"));
    const dest = path.join(root, "taken.tar.gz");
    fs.writeFileSync(dest, "something the operator cares about");
    await assert.rejects(() => exportArtifact(t, name, dest, { store }), (e) => e.code === "EEXIST");
    assert.equal(fs.readFileSync(dest, "utf8"), "something the operator cares about");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an archive holding more than its manifest claims is a failed drill", async () => {
  // The safety net under both the anchored excludes and the docker-source
  // exclude refusal: if those ever diverge again, this is what notices.
  const scan = { complete: true, totalBytes: 3, files: [{ path: "a", size: 1, sha256: "x" }, { path: "extra", size: 2, sha256: "y" }] };
  const result = compareToManifest(scan, { files: [{ path: "a", size: 1, sha256: "x" }] });
  assert.equal(result.ok, false);
  assert.match(result.problems[0], /extra: in archive but not in the manifest/);
});

test("a concurrent partial write never shadows the finished artifact", async () => {
  const { root, tarPath, store } = fixture();
  try {
    const t = target();
    await runBackup(t, { docker: stubDocker(tarPath), store });
    const dir = store.backupDir("media");
    const name = fs.readdirSync(dir).find((f) => f.endsWith(".tar.gz"));
    // ".part" sorts after the finished artifact of the same stamp, so picking
    // it would fail the drill on a perfectly healthy target.
    fs.writeFileSync(path.join(dir, `${name}.part`), "half a run");
    assert.equal(await latestArtifact(t, { store }), name);
    assert.equal((await drillFiles(t, { store })).lastDrillResult, "ok");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a volume subpath resolves against the mount, not the container's cwd", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "st-sub-"));
  try {
    const src = path.join(root, "src");
    fs.mkdirSync(path.join(src, "photos"), { recursive: true });
    fs.writeFileSync(path.join(src, "photos", "one.jpg"), "x");
    const tarPath = path.join(root, "sub.tar");
    assert.equal(spawnSync("tar", ["-cf", tarPath, "-C", src, "photos"]).status, 0);
    const store = new Store(path.join(root, "data"));
    store.ensureDirs();

    let asked = null;
    const docker = {
      findVolumeMount: async () => ({ id: "cid", name: "app-1", destination: "/data" }),
      inspectVolume: async () => ({}),
      findContainer: async () => ({ Id: "cid" }),
      archive: async (_id, p) => {
        asked = p;
        return fs.createReadStream(tarPath);
      },
    };
    await runBackup(
      { name: "media", type: "files", source: { volume: "app_media", path: "photos" }, encrypt: false },
      { docker, store },
    );
    // Sent to the Engine as "photos" it would resolve against the container's
    // working directory and archive something else entirely.
    assert.equal(asked, "/data/photos");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("nothing is written under its final name until it is complete", async () => {
  const { root, tarPath, store } = fixture();
  try {
    // Both writers, checked by watching the directory while the run is in
    // flight: a file that dies mid-write must not be left wearing a name that
    // reads as a backup.
    const dir = store.backupDir("media");
    const seen = new Set();
    const docker = stubDocker(tarPath, {
      archive: async () => {
        for (const f of fs.readdirSync(dir)) seen.add(f);
        return fs.createReadStream(tarPath);
      },
    });
    await runBackup(target(), { docker, store });
    for (const f of seen) {
      assert.ok(f.endsWith(".part"), `${f} was visible under its final name mid-run`);
    }

    // And the manifest, whose presence is what marks a run complete.
    const manifestWrites = [];
    const originalWriteFile = fsp.writeFile;
    fsp.writeFile = async (p, ...rest) => {
      if (String(p).includes("manifest")) manifestWrites.push(String(p));
      return originalWriteFile(p, ...rest);
    };
    try {
      await runBackup(target(), { docker: stubDocker(tarPath), store });
    } finally {
      fsp.writeFile = originalWriteFile;
    }
    assert.ok(manifestWrites.length > 0);
    for (const p of manifestWrites) {
      assert.ok(p.endsWith(".part"), `manifest written directly to ${p}`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a host-path archive is also written under .part first", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "st-part-"));
  try {
    const media = path.join(root, "media");
    fs.mkdirSync(media, { recursive: true });
    fs.writeFileSync(path.join(media, "a.txt"), "hello");
    const store = new Store(path.join(root, "data"));
    store.ensureDirs();
    const dir = store.backupDir("media");

    // The system tar writes this one, so watch which names it opens: a tar
    // that dies partway must not leave a file whose size prints happily.
    const opened = [];
    const original = fs.createWriteStream;
    fs.createWriteStream = (p, ...rest) => {
      if (String(p).startsWith(dir)) opened.push(String(p));
      return original(p, ...rest);
    };
    try {
      await runBackup({ name: "media", type: "files", path: media, archive: true, encrypt: false }, { docker: null, store });
    } finally {
      fs.createWriteStream = original;
    }
    assert.ok(opened.length > 0);
    for (const p of opened) assert.ok(p.endsWith(".part"), `${p} was opened under its final name`);
    assert.equal(fs.readdirSync(dir).some((f) => f.endsWith(".part")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
