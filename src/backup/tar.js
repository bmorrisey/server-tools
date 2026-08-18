/**
 * Just enough tar to read one.
 *
 * Media that lives in a Docker volume or inside a container arrives as a tar
 * stream from the Engine API, and an archive being restored arrives as a tar
 * stream too. In both cases we want the same thing out of it: the list of
 * files with their sizes and sha256 digests, computed in one pass over bytes
 * that are also on their way to disk. That is all this does. It never writes
 * a file and never expands anything, so a hostile archive cannot escape a
 * directory it is not being written to in the first place.
 *
 * Format handled: ustar plus the two extensions GNU tar and Go's archive/tar
 * (which is what the Docker Engine uses) actually emit - the 'L' long-name
 * record and PAX 'x' headers carrying `path` and `size`.
 */
import crypto from "node:crypto";

const BLOCK = 512;

/** Read a tar numeric field: octal, or GNU base-256 for large values. */
function readNumber(buf) {
  if (buf.length && buf[0] & 0x80) {
    let v = 0n;
    for (let i = 1; i < buf.length; i++) v = (v << 8n) | BigInt(buf[i]);
    return Number(v);
  }
  const s = buf.toString("latin1").replace(/\0.*$/s, "").trim();
  if (!s) return 0;
  const n = parseInt(s, 8);
  return Number.isFinite(n) ? n : 0;
}

function readString(buf) {
  return buf.toString("utf8").replace(/\0.*$/s, "");
}

/** Drop `strip` leading path components and any "./" prefix. */
export function normalizeEntryPath(name, strip = 0) {
  let p = String(name).replace(/\\/g, "/");
  while (p.startsWith("./")) p = p.slice(2);
  p = p.replace(/^\/+/, "");
  if (strip > 0) p = p.split("/").slice(strip).join("/");
  return p.replace(/\/+$/, "");
}

/** Parse the PAX extended-header payload into { key: value }. */
export function parsePax(text) {
  const out = {};
  let i = 0;
  while (i < text.length) {
    const sp = text.indexOf(" ", i);
    if (sp < 0) break;
    const len = Number(text.slice(i, sp));
    if (!Number.isInteger(len) || len <= 0 || i + len > text.length) break;
    const record = text.slice(sp + 1, i + len).replace(/\n$/, "");
    const eq = record.indexOf("=");
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    i += len;
  }
  return out;
}

/**
 * Incremental tar scanner. Feed it chunks, call finish() at the end.
 *
 * `strip` removes leading path components, because the Engine roots its
 * archive at the basename of the path it was asked for ("storage/photo.jpg"
 * for /app/storage) while a manifest wants paths relative to that root.
 */
export class TarScanner {
  constructor({ strip = 0 } = {}) {
    this.strip = strip;
    this.buf = Buffer.alloc(0);
    this.files = [];
    this.totalBytes = 0;
    this.sawEnd = false;
    this.finished = false;

    this.phase = "header"; // "header" | "body" | "padding"
    this.dataLeft = 0;
    this.padLeft = 0;
    this.entry = null; // { path, size, hash } while streaming a regular file
    this.collect = null; // Buffer[] while capturing an L or x record
    this.collectKind = null;
    this.override = {}; // path/size carried by the previous L or x record
  }

  update(chunk) {
    if (this.finished) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
    for (;;) {
      if (this.phase === "header") {
        if (this.sawEnd || this.buf.length < BLOCK) return;
        const header = this.buf.subarray(0, BLOCK);
        this.buf = this.buf.subarray(BLOCK);
        if (header.every((b) => b === 0)) {
          this.sawEnd = true;
          return;
        }
        this.#startEntry(header);
        continue;
      }
      if (this.phase === "body") {
        if (!this.buf.length) return;
        const take = Math.min(this.dataLeft, this.buf.length);
        const slice = this.buf.subarray(0, take);
        this.buf = this.buf.subarray(take);
        this.dataLeft -= take;
        if (this.entry) this.entry.hash.update(slice);
        else if (this.collect) this.collect.push(Buffer.from(slice));
        if (this.dataLeft === 0) this.#endEntry();
        continue;
      }
      // padding
      const take = Math.min(this.padLeft, this.buf.length);
      this.buf = this.buf.subarray(take);
      this.padLeft -= take;
      if (this.padLeft > 0) return;
      this.phase = "header";
    }
  }

  #startEntry(header) {
    const size = this.override.size ?? readNumber(header.subarray(124, 136));
    const typeflag = String.fromCharCode(header[156] || 0x30);
    const prefix = readString(header.subarray(345, 500));
    const rawName = readString(header.subarray(0, 100));
    const name = this.override.path ?? (prefix ? `${prefix}/${rawName}` : rawName);

    this.entry = null;
    this.collect = null;
    this.dataLeft = size;
    this.padLeft = (BLOCK - (size % BLOCK)) % BLOCK;

    if (typeflag === "L" || typeflag === "K" || typeflag === "x" || typeflag === "g") {
      this.collect = [];
      this.collectKind = typeflag;
    } else if (typeflag === "0" || typeflag === "\0" || typeflag === "7") {
      const path = normalizeEntryPath(name, this.strip);
      if (path) this.entry = { path, size, hash: crypto.createHash("sha256") };
      this.override = {};
    } else {
      // Directories, links, devices: recorded by tar, nothing to hash.
      this.override = {};
    }
    // A zero-length entry has no body to stream, so finish it here rather
    // than leaving it half-open waiting for bytes that never come.
    if (this.dataLeft > 0) this.phase = "body";
    else this.#endEntry();
  }

  #endEntry() {
    if (this.entry) {
      this.files.push({ path: this.entry.path, size: this.entry.size, sha256: this.entry.hash.digest("hex") });
      this.totalBytes += this.entry.size;
      this.entry = null;
    } else if (this.collect) {
      const text = Buffer.concat(this.collect).toString("utf8");
      if (this.collectKind === "L") {
        this.override = { ...this.override, path: normalizeEntryPath(text.replace(/\0.*$/s, ""), 0) };
      } else if (this.collectKind === "x") {
        const pax = parsePax(text);
        const next = { ...this.override };
        if (pax.path) next.path = pax.path;
        if (pax.size !== undefined && Number.isFinite(Number(pax.size))) next.size = Number(pax.size);
        this.override = next;
      }
      this.collect = null;
    }
    this.phase = this.padLeft > 0 ? "padding" : "header";
  }

  /**
   * Result of the scan. `complete` is false when the stream stopped mid-entry
   * or never reached the end-of-archive marker, which is what a tar that died
   * partway through writing looks like.
   */
  finish() {
    this.finished = true;
    const clean = this.phase === "header" && !this.entry;
    const files = [...this.files].sort((a, b) => a.path.localeCompare(b.path));
    return { files, totalBytes: this.totalBytes, complete: this.sawEnd && clean };
  }
}

/** Scan a readable tar stream to completion. */
export function scanTarStream(stream, { strip = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const scanner = new TarScanner({ strip });
    stream.on("data", (c) => {
      try {
        scanner.update(c);
      } catch (e) {
        stream.destroy();
        reject(e);
      }
    });
    stream.on("end", () => resolve(scanner.finish()));
    stream.on("error", reject);
  });
}
