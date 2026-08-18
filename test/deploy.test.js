import { test } from "node:test";
import assert from "node:assert/strict";
import { composeArgs, imageRef, parseInspectLines, readEnvVar, upsertEnvVar, verifyContainers } from "../src/deploy.js";

test("composeArgs names the project when the target does", () => {
  assert.deepEqual(composeArgs({ dir: "/apps/x" }, ["up", "-d"]), [
    "compose",
    "--project-directory",
    "/apps/x",
    "up",
    "-d",
  ]);
  assert.deepEqual(composeArgs({ dir: "/apps/x", project: "gs-alpha" }, ["ps", "-a", "-q", "app"]), [
    "compose",
    "--project-directory",
    "/apps/x",
    "-p",
    "gs-alpha",
    "ps",
    "-a",
    "-q",
    "app",
  ]);
});

test("readEnvVar finds the effective value and ignores lookalikes", () => {
  const env = [
    "# comment",
    "APP_IMAGE_OLD=ghcr.io/owner/app:v0",
    "OTHER=1",
    "export APP_IMAGE=ghcr.io/owner/app:v1",
    'QUOTED="hello world"',
  ].join("\n");
  assert.equal(readEnvVar(env, "APP_IMAGE"), "ghcr.io/owner/app:v1");
  assert.equal(readEnvVar(env, "QUOTED"), "hello world");
  assert.equal(readEnvVar(env, "MISSING"), null);
  assert.equal(readEnvVar("", "APP_IMAGE"), null);
});

test("readEnvVar takes the last assignment when a key repeats", () => {
  assert.equal(readEnvVar("APP_IMAGE=a:1\nAPP_IMAGE=a:2\n", "APP_IMAGE"), "a:2");
});

test("upsertEnvVar rewrites in place and leaves every other line alone", () => {
  const before = "# app secrets\nDB_PASSWORD=hunter2\nAPP_IMAGE=ghcr.io/owner/app:v1\nPORT=3000\n";
  const after = upsertEnvVar(before, "APP_IMAGE", "ghcr.io/owner/app:v2");
  assert.equal(after, "# app secrets\nDB_PASSWORD=hunter2\nAPP_IMAGE=ghcr.io/owner/app:v2\nPORT=3000\n");
  assert.equal(readEnvVar(after, "DB_PASSWORD"), "hunter2");
});

test("upsertEnvVar appends a missing key with exactly one trailing newline", () => {
  assert.equal(upsertEnvVar("PORT=3000\n", "APP_IMAGE", "a:1"), "PORT=3000\nAPP_IMAGE=a:1\n");
  assert.equal(upsertEnvVar("PORT=3000", "APP_IMAGE", "a:1"), "PORT=3000\nAPP_IMAGE=a:1\n");
  assert.equal(upsertEnvVar("", "APP_IMAGE", "a:1"), "APP_IMAGE=a:1\n");
});

test("upsertEnvVar collapses duplicate assignments so the reader cannot pick the wrong one", () => {
  const after = upsertEnvVar("APP_IMAGE=a:1\nPORT=3000\nAPP_IMAGE=a:2\n", "APP_IMAGE", "a:3");
  assert.equal(after, "PORT=3000\nAPP_IMAGE=a:3\n");
  assert.equal(after.match(/APP_IMAGE=/g).length, 1);
});

test("upsertEnvVar refuses names and values that would corrupt the file", () => {
  assert.throws(() => upsertEnvVar("", "not a name", "x"), /invalid environment variable name/);
  assert.throws(() => upsertEnvVar("", "APP_IMAGE", "a:1\nEVIL=1"), /multi-line/);
});

test("imageRef builds tag and digest references and rejects unsafe ones", () => {
  assert.equal(imageRef("ghcr.io/owner/app", "v1.2.3"), "ghcr.io/owner/app:v1.2.3");
  assert.equal(
    imageRef("ghcr.io/owner/app", "sha256:abc123"),
    "ghcr.io/owner/app@sha256:abc123",
  );
  assert.throws(() => imageRef("ghcr.io/owner/app", ""), /tag is required/);
  assert.throws(() => imageRef("ghcr.io/owner/app", "v1 --privileged"), /unsafe docker reference/);
  assert.throws(() => imageRef("ghcr.io/owner/app", "v1;rm -rf /"), /unsafe docker reference/);
});

test("parseInspectLines reads the docker inspect format and strips name slashes", () => {
  const out = "sha256:cid1\tsha256:img1\trunning\t/gs-alpha-app-1\nsha256:cid2\tsha256:img1\texited\t/gs-alpha-worker-1\n";
  assert.deepEqual(parseInspectLines(out), [
    { id: "sha256:cid1", image: "sha256:img1", status: "running", name: "gs-alpha-app-1" },
    { id: "sha256:cid2", image: "sha256:img1", status: "exited", name: "gs-alpha-worker-1" },
  ]);
  assert.deepEqual(parseInspectLines(""), []);
  assert.deepEqual(parseInspectLines("garbage\n"), []);
});

test("verifyContainers passes only when every container runs the pulled image", () => {
  const entries = [
    { service: "app", containers: [{ id: "c1", image: "sha256:new", status: "running", name: "app-1" }] },
    { service: "worker", containers: [{ id: "c2", image: "sha256:new", status: "running", name: "worker-1" }] },
  ];
  assert.deepEqual(verifyContainers(entries, { imageId: "sha256:new" }), { ok: true, problems: [] });
});

test("verifyContainers catches a service still on the old image", () => {
  const entries = [
    { service: "app", containers: [{ id: "c1", image: "sha256:old", status: "running", name: "app-1" }] },
  ];
  const v = verifyContainers(entries, { imageId: "sha256:newimageid00" });
  assert.equal(v.ok, false);
  assert.match(v.problems[0], /app\/app-1 runs image old/);
});

test("verifyContainers treats a crash-looped service as failure, not absence", () => {
  // `compose ps -q` would return nothing here, which reads like "no such
  // service"; listing with -a is what makes this visible.
  const v = verifyContainers([{ service: "worker", containers: [] }], { imageId: "sha256:new" });
  assert.equal(v.ok, false);
  assert.match(v.problems[0], /service "worker" has no container/);

  const dead = verifyContainers(
    [{ service: "worker", containers: [{ id: "c9", image: "sha256:new", status: "exited", name: "w-1" }] }],
    { imageId: "sha256:new" },
  );
  assert.equal(dead.ok, false);
  assert.match(dead.problems[0], /worker\/w-1 is exited/);
});

test("verifyContainers without an image ID only requires containers to be running", () => {
  const entries = [{ service: "app", containers: [{ id: "c1", image: "sha256:whatever", status: "running", name: "a" }] }];
  assert.equal(verifyContainers(entries).ok, true);
});
