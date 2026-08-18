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

/** Long-name and PAX records are held in memory; this caps how much. */
const MAX_META_BYTES = 1024 * 1024;

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
  // A size that is negative or not a number is a corrupt header, not a hint;
  // letting it through produces a manifest with negative totals.
  return Number.isFinite(n) && n >= 0 ? n : -1;
}

/**
 * The ustar header checksum: the sum of every header byte with the checksum
 * field itself read as spaces. Checking it is the standard defence against a
 * desynced stream, where a data block happens to look like a plausible
 * header and the rest of the archive is silently indexed as garbage.
 */
function headerChecksumOk(header) {
  const stored = readNumber(header.subarray(148, 156));
  if (stored < 0) return false;
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < BLOCK; i++) {
    const b = i >= 148 && i < 156 ? 0x20 : header[i];
    unsigned += b;
    signed += b > 127 ? b - 256 : b;
  }
  return stored === unsigned || stored === signed;
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

/**
 * Parse the PAX extended-header payload into { key: value }.
 *
 * Records are `<byte-length> <key>=<value>\n`, and that length is in BYTES.
 * Measuring it in JavaScript string units would come up short for any
 * non-ASCII name and silently discard the whole record set - which is not a
 * corner case here: the Docker Engine writes with Go's archive/tar, and Go
 * forces PAX for exactly those names. The fallback would then be the lossy
 * ASCII name in the ustar header, so a photo called "写真.jpg" would be
 * indexed as ".jpg". Hence the buffer arithmetic.
 */
export function parsePax(payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload ?? ""), "utf8");
  const out = {};
  let i = 0;
  while (i < buf.length) {
    const sp = buf.indexOf(0x20, i);
    if (sp < 0) break;
    const len = Number(buf.toString("latin1", i, sp));
    if (!Number.isInteger(len) || len <= 0 || i + len > buf.length) break;
    let end = i + len;
    if (buf[end - 1] === 0x0a) end--;
    const record = buf.subarray(sp + 1, end);
    const eq = record.indexOf(0x3d);
    if (eq > 0) out[record.toString("utf8", 0, eq)] = record.toString("utf8", eq + 1);
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
    this.byPath = new Map(); // path -> entry, for resolving hardlinks
    this.unresolvedLinks = 0; // links whose target never appeared
    this.dropped = 0; // entries removed by `strip`, tracked so an archive
    this.zeroBlocks = 0; // that yields nothing can be told from an empty one
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
    // Past the end-of-archive marker there is only padding. Dropping it
    // rather than buffering it keeps memory flat on a stream whose tail we
    // do not control.
    if (this.finished || this.sawEnd) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
    for (;;) {
      if (this.phase === "header") {
        if (this.buf.length < BLOCK) return;
        const header = this.buf.subarray(0, BLOCK);
        this.buf = this.buf.subarray(BLOCK);
        if (header.every((b) => b === 0)) {
          // The format ends an archive with two zero blocks. Treating one as
          // the end would let a stray zero block truncate the index while
          // still reporting the scan as complete.
          if (++this.zeroBlocks >= 2) {
            this.sawEnd = true;
            this.buf = Buffer.alloc(0);
            return;
          }
          continue;
        }
        this.zeroBlocks = 0;
        if (!headerChecksumOk(header)) {
          throw new Error("tar header checksum mismatch; the archive is corrupt or the stream desynced");
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
    if (size < 0) throw new Error("tar entry declares an invalid size; refusing to index a corrupt archive");
    const typeflag = String.fromCharCode(header[156] || 0x30);
    const prefix = readString(header.subarray(345, 500));
    const rawName = readString(header.subarray(0, 100));
    const name = this.override.path ?? (prefix ? `${prefix}/${rawName}` : rawName);

    this.entry = null;
    this.collect = null;
    this.dataLeft = size;
    this.padLeft = (BLOCK - (size % BLOCK)) % BLOCK;

    if (typeflag === "L" || typeflag === "K" || typeflag === "x" || typeflag === "g") {
      // These records are metadata about the next entry, so they are held in
      // memory. A header claiming a gigabyte of "metadata" is not one.
      if (size > MAX_META_BYTES) {
        throw new Error(`tar metadata record of ${size} bytes is implausible; refusing to buffer it`);
      }
      this.collect = [];
      this.collectKind = typeflag;
    } else if (typeflag === "0" || typeflag === "\0" || typeflag === "7") {
      const path = normalizeEntryPath(name, this.strip);
      if (path) this.entry = { path, size, hash: crypto.createHash("sha256") };
      else this.dropped++;
      this.override = {};
    } else if (typeflag === "1") {
      // A hardlink: tar writes the second and later names as a link with no
      // body. A directory walk sees them as ordinary files, so ignoring them
      // here would leave the manifest listing a file the archive appears not
      // to contain, and every restore drill failing on a backup that is fine.
      // The bytes are the target's, so the entry is too.
      //
      // The link target can outgrow the 100-byte header field just as a name
      // can, and then it arrives the same two ways: a GNU 'K' record, or a
      // PAX "linkpath". Reading only the header field would truncate it, miss
      // the lookup, and drop the entry - the same bug one route over.
      const path = normalizeEntryPath(name, this.strip);
      const rawLink = this.override.linkpath ?? readString(header.subarray(157, 257));
      const target = this.byPath.get(normalizeEntryPath(rawLink, this.strip));
      if (path && target) {
        this.#record({ path, size: target.size, sha256: target.sha256 });
      } else if (path) {
        this.unresolvedLinks++;
      }
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

  #record(entry) {
    this.files.push(entry);
    this.byPath.set(entry.path, entry);
    this.totalBytes += entry.size;
  }

  #endEntry() {
    if (this.entry) {
      this.#record({ path: this.entry.path, size: this.entry.size, sha256: this.entry.hash.digest("hex") });
      this.entry = null;
    } else if (this.collect) {
      const raw = Buffer.concat(this.collect);
      if (this.collectKind === "L") {
        const text = raw.toString("utf8").replace(/\0.*$/s, "");
        this.override = { ...this.override, path: normalizeEntryPath(text, 0) };
      } else if (this.collectKind === "K") {
        // GNU's long-link record: the target of the hardlink that follows.
        const text = raw.toString("utf8").replace(/\0.*$/s, "");
        this.override = { ...this.override, linkpath: text };
      } else if (this.collectKind === "x") {
        // Byte offsets, so the payload stays a Buffer all the way in.
        const pax = parsePax(raw);
        const next = { ...this.override };
        if (pax.path) next.path = pax.path;
        if (pax.linkpath) next.linkpath = pax.linkpath;
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
    return {
      files,
      totalBytes: this.totalBytes,
      dropped: this.dropped,
      unresolvedLinks: this.unresolvedLinks,
      complete: this.sawEnd && clean,
    };
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
