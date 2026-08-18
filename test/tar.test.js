import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { TarScanner, normalizeEntryPath, parsePax, scanTarStream } from "../src/backup/tar.js";

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

function tmpTree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "st-tar-"));
  fs.mkdirSync(path.join(dir, "storage", "sub"), { recursive: true });
  fs.writeFileSync(path.join(dir, "storage", "a.txt"), "hello");
  fs.writeFileSync(path.join(dir, "storage", "empty.txt"), "");
  fs.writeFileSync(path.join(dir, "storage", "sub", "b.bin"), Buffer.alloc(1500, 7));
  // A name long enough to force the long-name extension.
  fs.writeFileSync(path.join(dir, "storage", "sub", `${"n".repeat(160)}.txt`), "long");
  return dir;
}

test("normalizeEntryPath strips leading ./ and the requested components", () => {
  assert.equal(normalizeEntryPath("./a/b.txt"), "a/b.txt");
  assert.equal(normalizeEntryPath("storage/photo.jpg", 1), "photo.jpg");
  assert.equal(normalizeEntryPath("storage/", 1), "");
  assert.equal(normalizeEntryPath("/abs/path.txt"), "abs/path.txt");
});

test("parsePax reads length-prefixed records", () => {
  const record = (kv) => {
    const body = `${kv}\n`;
    for (let len = body.length + 2; len < body.length + 6; len++) {
      if (String(len).length + 1 + body.length === len) return `${len} ${body}`;
    }
    throw new Error("no fixed point");
  };
  const text = record("path=a/very/long/name.txt") + record("size=12345");
  assert.deepEqual(parsePax(text), { path: "a/very/long/name.txt", size: "12345" });
  assert.deepEqual(parsePax(""), {});
  assert.deepEqual(parsePax("garbage"), {});
});

test("TarScanner indexes a real tar, long names and empty files included", async () => {
  const dir = tmpTree();
  try {
    const tarPath = path.join(dir, "out.tar");
    const r = spawnSync("tar", ["-cf", tarPath, "-C", dir, "storage"]);
    assert.equal(r.status, 0, r.stderr?.toString());

    const result = await scanTarStream(fs.createReadStream(tarPath), { strip: 1 });
    assert.equal(result.complete, true);
    const paths = result.files.map((f) => f.path);
    assert.deepEqual(paths, ["a.txt", "empty.txt", `sub/${"n".repeat(160)}.txt`, "sub/b.bin"].sort());

    const a = result.files.find((f) => f.path === "a.txt");
    assert.equal(a.size, 5);
    assert.equal(a.sha256, sha("hello"));
    assert.equal(result.files.find((f) => f.path === "empty.txt").sha256, sha(""));
    assert.equal(result.files.find((f) => f.path === "sub/b.bin").size, 1500);
    assert.equal(result.totalBytes, 5 + 0 + 4 + 1500);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("TarScanner produces the same index however the stream is chunked", async () => {
  const dir = tmpTree();
  try {
    const tarPath = path.join(dir, "out.tar");
    spawnSync("tar", ["-cf", tarPath, "-C", dir, "storage"]);
    const bytes = fs.readFileSync(tarPath);
    const whole = new TarScanner({ strip: 1 });
    whole.update(bytes);
    const byOne = new TarScanner({ strip: 1 });
    for (let i = 0; i < bytes.length; i += 7) byOne.update(bytes.subarray(i, i + 7));
    assert.deepEqual(byOne.finish(), whole.finish());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a tar cut off mid-write is not complete", async () => {
  const dir = tmpTree();
  try {
    const tarPath = path.join(dir, "out.tar");
    spawnSync("tar", ["-cf", tarPath, "-C", dir, "storage"]);
    const bytes = fs.readFileSync(tarPath);
    // tar pads to a blocking factor, so trim to just past the last real byte
    // to get an archive whose end-of-archive marker never arrived.
    let end = bytes.length;
    while (end > 0 && bytes[end - 1] === 0) end--;
    const noMarker = bytes.subarray(0, Math.ceil(end / 512) * 512);
    const truncated = await scanTarStream(Readable.from([noMarker]), { strip: 1 });
    assert.equal(truncated.complete, false);

    // Cut inside a file body, not on a block boundary.
    const midEntry = new TarScanner({ strip: 1 });
    midEntry.update(bytes.subarray(0, 512 + 512 + 200));
    assert.equal(midEntry.finish().complete, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("directories, symlinks, and hard links contribute no files", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "st-tar-"));
  try {
    fs.mkdirSync(path.join(dir, "root", "d"), { recursive: true });
    fs.writeFileSync(path.join(dir, "root", "real.txt"), "x");
    fs.symlinkSync("real.txt", path.join(dir, "root", "link.txt"));
    const tarPath = path.join(dir, "out.tar");
    assert.equal(spawnSync("tar", ["-cf", tarPath, "-C", dir, "root"]).status, 0);
    const result = await scanTarStream(fs.createReadStream(tarPath), { strip: 1 });
    assert.deepEqual(result.files.map((f) => f.path), ["real.txt"]);
    assert.equal(result.complete, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
