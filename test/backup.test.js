import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildManifest, verifyManifest } from "../src/backup/backup.js";
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
