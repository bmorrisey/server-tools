import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { encryptStream, decryptBuffer, isEncryptedArtifact } from "../src/backup/crypto.js";

function collectSink() {
  const chunks = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk);
      cb();
    },
  });
  return { sink, buffer: () => Buffer.concat(chunks) };
}

test("encrypt/decrypt roundtrip preserves content", async () => {
  const plaintext = Buffer.from("backup payload ".repeat(10_000));
  const { sink, buffer } = collectSink();
  const written = await encryptStream("a strong passphrase 123", Readable.from(plaintext), sink);
  const artifact = buffer();
  assert.equal(written, artifact.length);
  assert.ok(isEncryptedArtifact(artifact));
  const out = decryptBuffer("a strong passphrase 123", artifact);
  assert.ok(out.equals(plaintext));
});

test("wrong passphrase fails loudly", async () => {
  const { sink, buffer } = collectSink();
  await encryptStream("correct horse battery staple", Readable.from(Buffer.from("secret")), sink);
  assert.throws(() => decryptBuffer("wrong passphrase entirely", buffer()));
});

test("corrupted ciphertext fails authentication", async () => {
  const { sink, buffer } = collectSink();
  await encryptStream("correct horse battery staple", Readable.from(Buffer.from("secret data here")), sink);
  const tampered = buffer();
  tampered[40] ^= 0xff;
  assert.throws(() => decryptBuffer("correct horse battery staple", tampered));
});

test("non-artifact input is rejected by magic check", () => {
  assert.equal(isEncryptedArtifact(Buffer.from("just a text file that is long enough to pass the length check")), false);
  assert.throws(() => decryptBuffer("pass", Buffer.alloc(64)), /bad magic/);
});
