/**
 * Streaming authenticated encryption for backup artifacts.
 *
 * Format ("STBK1"): passphrase-derived AES-256-GCM.
 *   [ 5 bytes magic "STBK1" ][ 16 bytes scrypt salt ][ 12 bytes IV ]
 *   [ ciphertext ... ][ 16 bytes GCM auth tag ]
 *
 * The key is derived with scrypt (N=2^15, r=8, p=1). GCM authenticates the
 * whole stream; decryption fails loudly on any corruption or a wrong
 * passphrase. Artifacts are therefore safe to park on untrusted storage.
 */
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

const MAGIC = Buffer.from("STBK1");
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

function deriveKey(passphrase, salt) {
  return crypto.scryptSync(passphrase, salt, 32, SCRYPT);
}

/** Encrypt readable -> writable. Returns bytes written (ciphertext total). */
export async function encryptStream(passphrase, source, sink) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(passphrase, salt), iv);
  let total = 0;
  const count = new Transform({
    transform(chunk, _enc, cb) {
      total += chunk.length;
      cb(null, chunk);
    },
  });

  sink.write(MAGIC);
  sink.write(salt);
  sink.write(iv);
  total += MAGIC.length + salt.length + iv.length;
  await pipeline(source, cipher, count, sink, { end: false });
  const tag = cipher.getAuthTag();
  await new Promise((resolve, reject) => sink.end(tag, (e) => (e ? reject(e) : resolve())));
  return total + tag.length;
}

const HEADER_BYTES = MAGIC.length + 16 + 12;
const TAG_BYTES = 16;

/**
 * Decrypt a readable stream of ciphertext into `sink`.
 *
 * The GCM tag sits at the end of the file, so this holds back the last 16
 * bytes as it goes and feeds them to the cipher as the tag. Worth the
 * bookkeeping: media archives are the large artifacts by definition, and the
 * restore drill that reads them back runs inside the long-running agent,
 * where a multi-gigabyte readFile does not fail softly.
 *
 * Corruption or a wrong passphrase still fails loudly, at the end.
 */
export function decryptStream(passphrase, source, sink) {
  return new Promise((resolve, reject) => {
    let header = Buffer.alloc(0);
    let held = Buffer.alloc(0);
    let decipher = null;
    let failed = false;

    const fail = (e) => {
      if (failed) return;
      failed = true;
      source.destroy();
      reject(e);
    };

    const feed = new Transform({
      transform(chunk, _enc, cb) {
        try {
          if (!decipher) {
            header = Buffer.concat([header, chunk]);
            if (header.length < HEADER_BYTES) return cb();
            if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
              return cb(new Error("not a server-tools encrypted artifact (bad magic)"));
            }
            const salt = header.subarray(MAGIC.length, MAGIC.length + 16);
            const iv = header.subarray(MAGIC.length + 16, HEADER_BYTES);
            decipher = crypto.createDecipheriv("aes-256-gcm", deriveKey(passphrase, salt), iv);
            chunk = header.subarray(HEADER_BYTES);
            header = Buffer.alloc(0);
          }
          // Everything but the trailing tag-sized window is safe to decrypt;
          // what the window holds at end-of-stream is the tag itself.
          const buf = Buffer.concat([held, chunk]);
          if (buf.length <= TAG_BYTES) {
            held = buf;
            return cb();
          }
          held = buf.subarray(buf.length - TAG_BYTES);
          cb(null, decipher.update(buf.subarray(0, buf.length - TAG_BYTES)));
        } catch (e) {
          cb(e);
        }
      },
      flush(cb) {
        try {
          if (!decipher) return cb(new Error("artifact is too short to be an encrypted artifact"));
          if (held.length !== TAG_BYTES) return cb(new Error("artifact is truncated: no authentication tag"));
          decipher.setAuthTag(held);
          cb(null, decipher.final());
        } catch (e) {
          cb(e);
        }
      },
    });

    pipeline(source, feed, sink).then(resolve, fail);
  });
}

/**
 * Decrypt a whole encrypted file buffer. Used where the plaintext is wanted
 * as one value anyway (a SQL dump handed to psql); anything large enough to
 * matter should use decryptStream instead.
 */
export function decryptBuffer(passphrase, buf) {
  if (!buf.subarray(0, 5).equals(MAGIC)) throw new Error("not a server-tools encrypted artifact (bad magic)");
  const salt = buf.subarray(5, 21);
  const iv = buf.subarray(21, 33);
  const tag = buf.subarray(buf.length - 16);
  const ciphertext = buf.subarray(33, buf.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", deriveKey(passphrase, salt), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function isEncryptedArtifact(buf) {
  return buf.length > 49 && buf.subarray(0, 5).equals(MAGIC);
}
