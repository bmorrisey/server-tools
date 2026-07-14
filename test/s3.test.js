import { test } from "node:test";
import assert from "node:assert/strict";
import { S3, deriveSigningKey } from "../src/backup/s3.js";

test("signing key derivation matches the AWS documentation vector", () => {
  // Published example: secret AKIDEXAMPLE..., 20120215, us-east-1, iam.
  const key = deriveSigningKey("wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "20120215", "us-east-1", "iam");
  assert.equal(
    key.toString("hex"),
    "f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d",
  );
});

test("virtual-hosted vs path-style addressing", () => {
  const aws = new S3({ bucket: "b", region: "us-east-1", accessKeyId: "k", secretAccessKey: "s" });
  assert.equal(aws.host, "b.s3.us-east-1.amazonaws.com");
  assert.equal(aws.objectPath("dir/file.txt"), "/dir/file.txt");

  const r2 = new S3({
    bucket: "b",
    region: "auto",
    accessKeyId: "k",
    secretAccessKey: "s",
    endpoint: "https://accountid.example-storage.com",
  });
  assert.equal(r2.host, "accountid.example-storage.com");
  assert.equal(r2.objectPath("dir/file.txt"), "/b/dir/file.txt");
});

test("object keys are canonically encoded per segment", () => {
  const s3 = new S3({ bucket: "b", region: "r", accessKeyId: "k", secretAccessKey: "s" });
  assert.equal(s3.objectPath("a b/c(d)/e's!.txt"), "/a%20b/c%28d%29/e%27s%21.txt");
});

test("prefix is applied to object paths", () => {
  const s3 = new S3({ bucket: "b", region: "r", accessKeyId: "k", secretAccessKey: "s", prefix: "backups/" });
  assert.equal(s3.objectPath("t/x.enc"), "/backups/t/x.enc");
});

test("sign produces stable authorization structure", () => {
  const s3 = new S3({ bucket: "b", region: "eu-west-1", accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" });
  const date = new Date(Date.UTC(2026, 0, 15, 3, 30, 0));
  const headers = s3.sign({ method: "PUT", path: "/k.txt", payloadHash: "e".repeat(64), date });
  assert.equal(headers["x-amz-date"], "20260115T033000Z");
  assert.match(
    headers.authorization,
    /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260115\/eu-west-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
  );
  // Same inputs, same signature (determinism).
  const again = s3.sign({ method: "PUT", path: "/k.txt", payloadHash: "e".repeat(64), date });
  assert.equal(headers.authorization, again.authorization);
});
