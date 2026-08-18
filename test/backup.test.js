import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildManifest,
  describeSource,
  fileSource,
  planPrune,
  shouldArchive,
  verifyManifest,
} from "../src/backup/backup.js";
import { cleanDir } from "../src/housekeep.js";

function fixtureTree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "st-backup-"));
  fs.mkdirSync(path.join(dir, "sub"));
  fs.writeFileSync(path.join(dir, "a.txt"), "hello");
  fs.writeFileSync(path.join(dir, "sub", "b.bin"), Buffer.from([1, 2, 3, 4]));
  fs.mkdirSync(path.join(dir, "skipme"));
  fs.writeFileSync(path.join(dir, "skipme", "c.txt"), "excluded");
  return dir;
}

test("buildManifest hashes files and honours excludes", async () => {
  const dir = fixtureTree();
  try {
    const manifest = await buildManifest(dir, ["skipme"]);
    assert.equal(manifest.files.length, 2);
    assert.deepEqual(manifest.files.map((f) => f.path).sort(), ["a.txt", "sub/b.bin"]);
    assert.equal(manifest.totalBytes, 9);
    const a = manifest.files.find((f) => f.path === "a.txt");
    assert.equal(a.sha256, "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyManifest detects missing files, size drift, and corruption", async () => {
  const dir = fixtureTree();
  try {
    const manifest = await buildManifest(dir, ["skipme"]);
    let v = await verifyManifest(manifest);
    assert.equal(v.ok, true);

    fs.writeFileSync(path.join(dir, "a.txt"), "hellx"); // same size, new hash
    v = await verifyManifest(manifest, { sample: 10 });
    assert.equal(v.ok, false);
    assert.ok(v.problems.some((p) => p.includes("checksum mismatch")));

    fs.rmSync(path.join(dir, "sub", "b.bin"));
    v = await verifyManifest(manifest, { sample: 10 });
    assert.ok(v.problems.some((p) => p.includes("missing")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cleanDir removes only files older than maxAge and respects dryRun", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "st-hk-"));
  try {
    const oldFile = path.join(dir, "old.tmp");
    const newFile = path.join(dir, "new.tmp");
    fs.writeFileSync(oldFile, "x");
    fs.writeFileSync(newFile, "y");
    const past = new Date(Date.now() - 10 * 86_400_000);
    fs.utimesSync(oldFile, past, past);

    const dry = await cleanDir(dir, 86_400_000, { dryRun: true });
    assert.equal(dry.files, 1);
    assert.ok(fs.existsSync(oldFile));

    const wet = await cleanDir(dir, 86_400_000);
    assert.equal(wet.files, 1);
    assert.ok(!fs.existsSync(oldFile));
    assert.ok(fs.existsSync(newFile));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fileSource states where media lives and refuses to guess", () => {
  assert.deepEqual(fileSource({ name: "m", path: "/srv/media" }), { kind: "path", path: "/srv/media" });
  assert.deepEqual(fileSource({ name: "m", source: { path: "/srv/media" } }), { kind: "path", path: "/srv/media" });
  assert.deepEqual(fileSource({ name: "m", source: { volume: "app_media" } }), {
    kind: "volume",
    volume: "app_media",
    path: null,
  });
  assert.deepEqual(fileSource({ name: "m", source: { container: "app-1", path: "/app/storage" } }), {
    kind: "container",
    container: "app-1",
    path: "/app/storage",
  });
  assert.throws(() => fileSource({ name: "m" }), /no source configured/);
  assert.throws(() => fileSource({ name: "m", source: {} }), /must name a volume/);
  assert.throws(() => fileSource({ name: "m", source: { container: "app-1" } }), /needs source.path/);
});

test("shouldArchive keeps the old manifest-only default only for the old path form", () => {
  assert.equal(shouldArchive({ path: "/srv/media" }), false);
  assert.equal(shouldArchive({ source: { volume: "v" } }), true);
  assert.equal(shouldArchive({ source: { volume: "v" }, archive: false }), false);
  assert.equal(shouldArchive({ path: "/srv/media", archive: true }), true);
});

test("describeSource names a source the way an operator would", () => {
  assert.equal(describeSource({ kind: "volume", volume: "app_media" }), "volume app_media");
  assert.equal(describeSource({ kind: "volume", volume: "app_media", path: "/data/x" }), "volume app_media:/data/x");
  assert.equal(describeSource({ kind: "container", container: "app-1", path: "/app/storage" }), "container app-1:/app/storage");
  assert.equal(describeSource({ kind: "path", path: "/srv/media" }), "/srv/media");
});

const RETENTION = { daily: 1, weekly: 0, monthly: 0 };

test("planPrune keeps a run whole and never counts a partial write as one", () => {
  const names = [
    "m-20260101-030000.tar.gz.enc",
    "m-20260101-030000.manifest.json",
    "m-20260102-030000.tar.gz.enc",
    "m-20260102-030000.manifest.json",
    "m-20260103-030000.tar.gz.enc.part",
  ];
  const plan = planPrune(names, RETENTION);
  assert.deepEqual(plan.partials, ["m-20260103-030000.tar.gz.enc.part"]);
  assert.equal(plan.droppedRuns, 1);
  assert.deepEqual(plan.drop.sort(), ["m-20260101-030000.manifest.json", "m-20260101-030000.tar.gz.enc"]);
});

test("planPrune keeps manifest-only runs instead of deleting them all", () => {
  const names = ["m-20260101-030000.manifest.json", "m-20260102-030000.manifest.json"];
  const plan = planPrune(names, RETENTION);
  assert.deepEqual(plan.drop, ["m-20260101-030000.manifest.json"]);
  assert.equal(plan.keep.has("20260102-030000"), true);
});

test("planPrune keeps recent failure markers and drops ones older than everything retained", () => {
  const names = [
    "m-20250101-030000.failed.json", // older than anything kept
    "m-20260102-030000.tar.gz",
    "m-20260103-040000.failed.json", // newer than the kept run
  ];
  const plan = planPrune(names, RETENTION);
  assert.deepEqual(plan.drop, ["m-20250101-030000.failed.json"]);
});

test("planPrune leaves a directory of nothing but failures alone", () => {
  const names = ["m-20260101-030000.failed.json", "m-20260102-030000.failed.json"];
  assert.deepEqual(planPrune(names, RETENTION).drop, []);
});

test("verifyManifest refuses a manifest with no filesystem root", async () => {
  await assert.rejects(
    () => verifyManifest({ root: null, files: [], source: { kind: "volume", volume: "v" } }),
    /no filesystem root/,
  );
});
