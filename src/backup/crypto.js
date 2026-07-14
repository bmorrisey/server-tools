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

/**
 * Decrypt a whole encrypted file buffer. For restore-sized artifacts we read
 * the file fully; the GCM tag sits at the end so true streaming decryption
 * would need to hold back 16 bytes - buffer simplicity wins here.
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
