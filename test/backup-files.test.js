/**
 * End to end for media backups that come out of Docker rather than off the
 * local filesystem: run the target, then prove the archive it wrote matches
 * the manifest it wrote. The Docker layer is stubbed with a real tar stream,
 * which is exactly what the Engine's archive endpoint hands back.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Store } from "../src/store.js";
import { runBackup } from "../src/backup/backup.js";
import { drillFiles, verifyArchive } from "../src/backup/restore.js";

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

test("excludes still apply to media read through docker", async () => {
  const { root, tarPath, store } = fixture();
  try {
    const patch = await runBackup(target({ exclude: ["photos"] }), { docker: stubDocker(tarPath), store });
    assert.match(patch.lastDetail, /^1 files/);
    const dir = store.backupDir("media");
    const manifest = JSON.parse(
      fs.readFileSync(path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith(".manifest.json"))), "utf8"),
    );
    assert.deepEqual(manifest.files.map((f) => f.path), ["notes.txt"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
