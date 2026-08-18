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

/* -------------------------------------------------------------------------
 * PAX archives.
 *
 * The tests above shell out to GNU tar, which uses GNU 'L' records for long
 * names. The Docker Engine does not: it writes with Go's archive/tar, which
 * forces a PAX extended header for any non-ASCII name, any name over 100
 * bytes, and any large size. Building those headers by hand is the only way
 * to exercise the path the Engine actually takes.
 * ---------------------------------------------------------------------- */

function tarHeader({ name = "", size = 0, typeflag = "0", prefix = "" }) {
  const b = Buffer.alloc(512);
  b.write(name, 0, 100, "utf8");
  b.write("0000644\0", 100, 8, "latin1");
  b.write("0000000\0", 108, 8, "latin1");
  b.write("0000000\0", 116, 8, "latin1");
  b.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "latin1");
  b.write("00000000000\0", 136, 12, "latin1");
  b.write("        ", 148, 8, "latin1"); // checksum field reads as spaces
  b.write(typeflag, 156, 1, "latin1");
  b.write("ustar\0", 257, 6, "latin1");
  b.write("00", 263, 2, "latin1");
  b.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += b[i];
  b.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "latin1");
  return b;
}

/** A PAX record: "<byte-length> key=value\n", where the length counts itself. */
function paxRecord(kv) {
  const body = Buffer.from(`${kv}\n`, "utf8");
  for (let n = body.length + 2; n < body.length + 10; n++) {
    if (Buffer.byteLength(String(n)) + 1 + body.length === n) {
      return Buffer.concat([Buffer.from(`${n} `, "latin1"), body]);
    }
  }
  throw new Error("no fixed point");
}

const pad = (buf) => Buffer.concat([buf, Buffer.alloc((512 - (buf.length % 512)) % 512)]);

/** An entry the way Go writes it: a PAX header, then the ustar fallback. */
function paxEntry(realPath, body, { fallback = "unused", records = null } = {}) {
  const data = Buffer.from(body);
  const payload = Buffer.concat(records ?? [paxRecord(`path=${realPath}`)]);
  return Buffer.concat([
    tarHeader({ name: `PaxHeaders/0/${fallback}`, size: payload.length, typeflag: "x" }),
    pad(payload),
    tarHeader({ name: fallback, size: data.length }),
    pad(data),
  ]);
}

const endOfArchive = Buffer.alloc(1024);

test("a PAX header carries a non-ASCII name through intact", async () => {
  // Go writes a lossy ASCII fallback in the ustar name field, so losing the
  // PAX record does not fail loudly: it indexes the wrong path and the drill,
  // reading the same stream the same way, agrees with itself.
  const archive = Buffer.concat([
    paxEntry("storage/写真.jpg", "abcd", { fallback: "storage/.jpg" }),
    paxEntry("storage/画像.jpg", "efghi", { fallback: "storage/.jpg" }),
    endOfArchive,
  ]);
  const result = await scanTarStream(Readable.from([archive]), { strip: 1 });
  assert.equal(result.complete, true);
  assert.deepEqual(result.files.map((f) => f.path).sort(), ["画像.jpg", "写真.jpg"].sort());
  assert.equal(result.files.find((f) => f.path === "写真.jpg").sha256, sha("abcd"));
});

test("a PAX size record is honoured, so the stream does not desync", async () => {
  const body = "0123456789";
  const archive = Buffer.concat([
    paxEntry("storage/big.bin", body, {
      fallback: "storage/big.bin",
      // Go sorts its keys, so anything alphabetically before "path" arrives
      // first; the parser has to walk past it to reach the rest.
      records: [paxRecord("SCHILY.xattr.user.k=v"), paxRecord("path=storage/big.bin"), paxRecord(`size=${body.length}`)],
    }),
    paxEntry("storage/after.txt", "ok", { fallback: "storage/after.txt" }),
    endOfArchive,
  ]);
  const result = await scanTarStream(Readable.from([archive]), { strip: 1 });
  assert.equal(result.complete, true);
  assert.deepEqual(result.files.map((f) => f.path).sort(), ["after.txt", "big.bin"]);
  assert.equal(result.files.find((f) => f.path === "big.bin").size, 10);
});

test("a corrupt header is rejected rather than indexed as garbage", async () => {
  const bad = tarHeader({ name: "storage/a.txt", size: 4 });
  bad[10] = 0x41; // flip a byte the checksum covers
  await assert.rejects(
    () => scanTarStream(Readable.from([Buffer.concat([bad, pad(Buffer.from("data")), endOfArchive])])),
    /checksum mismatch/,
  );
});

test("an implausible metadata record is refused instead of buffered", async () => {
  const huge = tarHeader({ name: "PaxHeaders/0/x", size: 8 * 1024 * 1024, typeflag: "x" });
  await assert.rejects(() => scanTarStream(Readable.from([huge])), /implausible/);
});

test("bytes after the end-of-archive marker are dropped, not buffered", async () => {
  const scanner = new TarScanner({ strip: 1 });
  scanner.update(Buffer.concat([paxEntry("storage/a.txt", "x", { fallback: "storage/a.txt" }), endOfArchive]));
  scanner.update(Buffer.alloc(4 * 1024 * 1024)); // trailing padding from a blocking factor
  assert.equal(scanner.buf.length, 0);
  const result = scanner.finish();
  assert.equal(result.complete, true);
  assert.deepEqual(result.files.map((f) => f.path), ["a.txt"]);
});

test("a single stray zero block does not end the archive early", async () => {
  const archive = Buffer.concat([
    paxEntry("storage/a.txt", "x", { fallback: "storage/a.txt" }),
    Buffer.alloc(512), // one zero block: not a terminator
    paxEntry("storage/b.txt", "y", { fallback: "storage/b.txt" }),
    endOfArchive,
  ]);
  const result = await scanTarStream(Readable.from([archive]), { strip: 1 });
  assert.deepEqual(result.files.map((f) => f.path).sort(), ["a.txt", "b.txt"]);
});
