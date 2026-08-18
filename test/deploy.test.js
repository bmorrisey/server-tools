import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  composeArgs,
  deploy,
  imageRef,
  parseInspectLines,
  readEnvVar,
  upsertEnvVar,
  verifyContainers,
} from "../src/deploy.js";

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

/* -------------------------------------------------------------------------
 * Sequencing.
 *
 * The pure helpers above are the easy half. What actually goes wrong in a
 * deploy is the order of operations and what each failure path leaves behind,
 * so these drive the real thing against a scripted docker and a temp .env.
 * ---------------------------------------------------------------------- */

function scratch(envBody = "DB_PASSWORD=hunter2\nAPP_IMAGE=ghcr.io/o/app:v1\n", mode = 0o600) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "st-deploy-"));
  fs.writeFileSync(path.join(dir, ".env"), envBody, { mode });
  fs.chmodSync(path.join(dir, ".env"), mode);
  return dir;
}

const registryTarget = (dir, extra = {}) => ({
  name: "app",
  dir,
  project: "app",
  source: "registry",
  image: "ghcr.io/o/app",
  services: ["web"],
  healthUrl: "http://127.0.0.1:1/health",
  ...extra,
});

/**
 * A scripted docker. `fail` names the first argv word that should fail; every
 * other call succeeds with a plausible answer.
 */
function fakeDocker({ fail = null, imageId = "sha256:newimage", runningImage = null, dir = null, psStderr = null } = {}) {
  const calls = [];
  // What .env said at the moment compose was asked to recreate the stack.
  // Asserting on the file afterwards cannot tell the write from happening
  // before or after the thing it is supposed to control.
  const envAtUp = [];
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    const bad = fail && calls[calls.length - 1].includes(fail);
    if (bad) return { code: 1, stdout: "", stderr: `simulated failure: ${fail}` };
    if (args[0] === "pull") return { code: 0, stdout: "", stderr: "" };
    if (args[0] === "image" && args[1] === "inspect") return { code: 0, stdout: imageId, stderr: "" };
    if (args.includes("up") && dir) {
      envAtUp.push(fs.readFileSync(path.join(dir, ".env"), "utf8"));
    }
    if (args.includes("ps")) {
      if (psStderr) return { code: 1, stdout: "", stderr: psStderr };
      return { code: 0, stdout: "cid1", stderr: "" };
    }
    if (args[0] === "inspect") {
      return { code: 0, stdout: `cid1\t${runningImage ?? imageId}\trunning\t/app-web-1`, stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { exec, calls, envAtUp };
}

const healthy = async () => ({ healthy: true, tries: 1 });
const unhealthy = async () => ({ healthy: false, tries: 3, lastError: "HTTP 502" });

test("a registry deploy writes the image before bringing the stack up", async () => {
  const dir = scratch();
  try {
    const docker = fakeDocker({ dir });
    const result = await deploy(registryTarget(dir), "v2", { store: null, exec: docker.exec, health: healthy });
    assert.equal(result.ok, true);
    assert.equal(result.rolledBack, false);
    assert.equal(readEnvVar(fs.readFileSync(path.join(dir, ".env"), "utf8"), "APP_IMAGE"), "ghcr.io/o/app:v2");

    // The load-bearing detail: compose must already be reading the new tag
    // when it runs, not be told about it afterwards.
    assert.equal(docker.envAtUp.length, 1);
    assert.equal(readEnvVar(docker.envAtUp[0], "APP_IMAGE"), "ghcr.io/o/app:v2");

    const upIndex = docker.calls.findIndex((c) => c.includes("up -d --no-build"));
    const pullIndex = docker.calls.findIndex((c) => c.includes("pull"));
    assert.ok(pullIndex >= 0 && upIndex > pullIndex, "pull must happen before up");
    assert.ok(docker.calls.some((c) => c.includes("-p app")), "every compose call names the project");
    assert.ok(docker.calls.some((c) => c.includes("ps -a -q web")), "services are listed with -a");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a rollback brings the stack up on the restored file, not a rewritten one", async () => {
  const dir = scratch();
  try {
    const docker = fakeDocker({ dir });
    await deploy(registryTarget(dir), "v2", { store: null, exec: docker.exec, health: unhealthy });
    assert.equal(docker.envAtUp.length, 2);
    assert.equal(readEnvVar(docker.envAtUp[1], "APP_IMAGE"), "ghcr.io/o/app:v1");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rewriting .env keeps its mode, so app secrets do not become world-readable", async () => {
  const dir = scratch();
  try {
    const docker = fakeDocker();
    await deploy(registryTarget(dir), "v2", { store: null, exec: docker.exec, health: healthy });
    assert.equal(fs.statSync(path.join(dir, ".env")).mode & 0o777, 0o600);
    // And nothing is left lying around with the same contents.
    assert.deepEqual(fs.readdirSync(dir), [".env"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed pull changes nothing and does not recreate a healthy stack", async () => {
  const dir = scratch();
  const before = fs.readFileSync(path.join(dir, ".env"), "utf8");
  try {
    const docker = fakeDocker({ fail: "pull" });
    const result = await deploy(registryTarget(dir), "v2", { store: null, exec: docker.exec, health: healthy });
    assert.equal(result.ok, false);
    assert.equal(result.rolledBack, false);
    assert.match(result.detail, /nothing on this box was changed/);
    assert.equal(fs.readFileSync(path.join(dir, ".env"), "utf8"), before);
    assert.equal(docker.calls.some((c) => c.includes("up -d")), false, "the stack must not be touched");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed health check puts .env back exactly as it was", async () => {
  const dir = scratch('# pinned during the incident\nAPP_IMAGE="ghcr.io/o/app:v1" # do not touch\nDB_PASSWORD=hunter2\n');
  const before = fs.readFileSync(path.join(dir, ".env"), "utf8");
  try {
    const docker = fakeDocker();
    const result = await deploy(registryTarget(dir), "v2", { store: null, exec: docker.exec, health: unhealthy });
    assert.equal(result.ok, false);
    assert.equal(result.rolledBack, true);
    // Byte-for-byte, comment and quoting included: a rollback that rewrites
    // the file its own way is a second change to explain at 3am.
    assert.equal(fs.readFileSync(path.join(dir, ".env"), "utf8"), before);
    assert.ok(docker.calls.some((c) => c.includes("pull ghcr.io/o/app:v1")), "the previous image is pulled back");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("with no previous image the broken tag is not left in .env", async () => {
  const dir = scratch("DB_PASSWORD=hunter2\n");
  try {
    const docker = fakeDocker();
    const result = await deploy(registryTarget(dir), "v2", { store: null, exec: docker.exec, health: unhealthy });
    assert.equal(result.ok, false);
    assert.equal(result.rolledBack, false);
    assert.match(result.detail, /nothing to roll back to/);
    // Otherwise the next routine "docker compose up -d" redeploys the failure.
    assert.equal(readEnvVar(fs.readFileSync(path.join(dir, ".env"), "utf8"), "APP_IMAGE"), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a service left on the old image fails the deploy and rolls back", async () => {
  const dir = scratch();
  try {
    const docker = fakeDocker({ runningImage: "sha256:oldimage" });
    const result = await deploy(registryTarget(dir), "v2", { store: null, exec: docker.exec, health: healthy });
    assert.equal(result.ok, false);
    assert.equal(result.rolledBack, true);
    assert.match(result.detail, /runs image oldimage/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("docker failing to answer is not read as a broken deploy", async () => {
  const dir = scratch();
  try {
    // A daemon hiccup during verification must not recreate production; the
    // health gate still decides, and the caveat is reported honestly.
    const docker = fakeDocker({ fail: "inspect --format {{.Id}}\t" });
    const result = await deploy(registryTarget(dir), "v2", { store: null, exec: docker.exec, health: healthy });
    assert.equal(result.ok, true);
    assert.equal(result.rolledBack, false);
    assert.match(result.detail, /could not verify services/);
    assert.equal(readEnvVar(fs.readFileSync(path.join(dir, ".env"), "utf8"), "APP_IMAGE"), "ghcr.io/o/app:v2");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a deploy directory the agent cannot see says so", async () => {
  const docker = fakeDocker();
  await assert.rejects(
    () => deploy(registryTarget("/nope/not/here"), "v2", { store: null, exec: docker.exec, health: healthy }),
    /not visible here/,
  );
});

test("compose never inherits the agent's own secrets", async () => {
  const dir = scratch();
  process.env.ST_TEST_BACKUP_PASSPHRASE = "a secret the app must not receive";
  try {
    const seen = [];
    const exec = async (cmd, args, opts = {}) => {
      if (args.includes("compose")) seen.push(opts.env);
      if (args[0] === "image" && args[1] === "inspect") return { code: 0, stdout: "sha256:newimage", stderr: "" };
      if (args.includes("ps")) return { code: 0, stdout: "cid1", stderr: "" };
      if (args[0] === "inspect") return { code: 0, stdout: "cid1\tsha256:newimage\trunning\t/app-web-1", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    await deploy(registryTarget(dir), "v2", { store: null, exec, health: healthy });
    assert.ok(seen.length > 0);
    for (const env of seen) {
      assert.equal(env.ST_TEST_BACKUP_PASSPHRASE, undefined);
      assert.ok("PATH" in env, "but compose still needs to find docker");
    }
  } finally {
    delete process.env.ST_TEST_BACKUP_PASSPHRASE;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a dry run reports what it would do and touches nothing", async () => {
  const dir = scratch();
  const before = fs.readFileSync(path.join(dir, ".env"), "utf8");
  try {
    const docker = fakeDocker();
    const result = await deploy(registryTarget(dir), "v2", { store: null, dryRun: true, exec: docker.exec, health: healthy });
    assert.equal(result.ok, true);
    assert.match(result.detail, /dry run/);
    assert.equal(docker.calls.length, 0);
    assert.equal(fs.readFileSync(path.join(dir, ".env"), "utf8"), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A store that records what the dashboard will later render. */
function fakeStore() {
  const events = [];
  let state = {};
  return {
    events,
    append: (topic, record) => events.push({ topic, ...record }),
    readState: () => state,
    writeState: (_name, value) => (state = value),
    get deploys() {
      return state;
    },
  };
}

test("the recorded kind matches what actually happened", async () => {
  const cases = [
    { name: "success", docker: {}, health: healthy, kind: "ok" },
    { name: "pull failed", docker: { fail: "pull" }, health: healthy, kind: "fail" },
    { name: "health failed", docker: {}, health: unhealthy, kind: "rollback" },
    { name: "unverifiable", docker: { fail: "inspect --format {{.Id}}\t" }, health: healthy, kind: "warn" },
  ];
  for (const c of cases) {
    const dir = scratch();
    try {
      const store = fakeStore();
      const docker = fakeDocker(c.docker);
      await deploy(registryTarget(dir), "v2", { store, exec: docker.exec, health: c.health });
      assert.equal(store.deploys.app.kind, c.kind, c.name);
      assert.equal(store.events.at(-1).kind, c.kind, `${c.name} event`);
      assert.equal(store.deploys.app.source, "registry", c.name);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("a .env that cannot be written leaves the stack alone", async () => {
  const dir = scratch();
  try {
    // Something already occupies the temp path, so the rewrite fails. Nothing
    // has changed at that point, so nothing should be recreated to "fix" it.
    fs.mkdirSync(path.join(dir, `.env.server-tools.${process.pid}.tmp`));
    const docker = fakeDocker();
    const result = await deploy(registryTarget(dir), "v2", { store: null, exec: docker.exec, health: healthy });
    assert.equal(result.ok, false);
    assert.equal(result.rolledBack, false);
    assert.match(result.detail, /nothing on this box was changed/);
    assert.equal(docker.calls.some((c) => c.includes("up -d")), false);
    assert.equal(readEnvVar(fs.readFileSync(path.join(dir, ".env"), "utf8"), "APP_IMAGE"), "ghcr.io/o/app:v1");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a symlinked .env is followed rather than replaced", async () => {
  const dir = scratch();
  try {
    // A shared secrets file behind a symlink is a real arrangement; replacing
    // the link would leave the canonical copy silently stale.
    const shared = path.join(dir, "shared.env");
    fs.renameSync(path.join(dir, ".env"), shared);
    fs.symlinkSync("shared.env", path.join(dir, ".env"));
    const docker = fakeDocker();
    await deploy(registryTarget(dir), "v2", { store: null, exec: docker.exec, health: healthy });
    assert.ok(fs.lstatSync(path.join(dir, ".env")).isSymbolicLink(), "still a symlink");
    assert.equal(readEnvVar(fs.readFileSync(shared, "utf8"), "APP_IMAGE"), "ghcr.io/o/app:v2");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a service missing from the compose file is an error, not a shrug", async () => {
  const dir = scratch();
  try {
    // Classifying this as "could not verify" would leave the whole
    // image-ID guarantee switched off for every deploy of that target.
    const docker = fakeDocker({ psStderr: "no such service: web" });
    const result = await deploy(registryTarget(dir), "v2", { store: null, exec: docker.exec, health: healthy });
    assert.equal(result.ok, false);
    assert.equal(result.rolledBack, true);
    assert.match(result.detail, /not in the compose file/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a git deploy still checks out, builds, and rolls back by checkout", async () => {
  const dir = scratch();
  try {
    const calls = [];
    const exec = async (cmd, args) => {
      calls.push([cmd, ...args].join(" "));
      if (cmd === "git" && args.includes("rev-parse")) return { code: 0, stdout: "abc1234", stderr: "" };
      if (cmd === "git" && args.includes("describe")) return { code: 0, stdout: "v1.0.0", stderr: "" };
      if (cmd === "git" && args.includes("status")) return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const target = { name: "legacy", dir, healthUrl: "http://127.0.0.1:1/health" };

    const ok = await deploy(target, "v2.0.0", { store: null, exec, health: healthy });
    assert.equal(ok.ok, true);
    assert.equal(ok.from, "v1.0.0");
    assert.ok(calls.some((c) => c.includes("checkout v2.0.0")));
    assert.ok(calls.some((c) => c.includes("up -d --build")));
    // No project flag when the target names none: unchanged from before.
    assert.equal(calls.some((c) => c.includes("-p ")), false);
    // And a git deploy never touches .env.
    assert.equal(readEnvVar(fs.readFileSync(path.join(dir, ".env"), "utf8"), "APP_IMAGE"), "ghcr.io/o/app:v1");

    calls.length = 0;
    const bad = await deploy(target, "v3.0.0", { store: null, exec, health: unhealthy });
    assert.equal(bad.rolledBack, true);
    assert.ok(calls.some((c) => c.includes("checkout abc1234")), "rolls back by checking the old commit out");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a dirty working tree is refused before anything is built", async () => {
  const dir = scratch();
  try {
    const calls = [];
    const exec = async (cmd, args) => {
      calls.push([cmd, ...args].join(" "));
      if (cmd === "git" && args.includes("rev-parse")) return { code: 0, stdout: "abc1234", stderr: "" };
      if (cmd === "git" && args.includes("describe")) return { code: 0, stdout: "v1.0.0", stderr: "" };
      if (cmd === "git" && args.includes("status")) return { code: 0, stdout: " M src/app.js", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    await assert.rejects(
      () => deploy({ name: "legacy", dir, healthUrl: "http://127.0.0.1:1/health" }, "v2", { store: null, exec, health: healthy }),
      /local changes/,
    );
    assert.equal(calls.some((c) => c.includes("up -d")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a build keeps the proxy and buildkit settings it needs", async () => {
  const dir = scratch();
  process.env.ST_TEST_HTTPS_PROXY_MARKER = "x";
  const saved = { HTTPS_PROXY: process.env.HTTPS_PROXY, DOCKER_BUILDKIT: process.env.DOCKER_BUILDKIT };
  process.env.HTTPS_PROXY = "http://proxy.internal:3128";
  process.env.DOCKER_BUILDKIT = "0";
  try {
    const seen = [];
    const exec = async (cmd, args, opts = {}) => {
      if (args.includes("compose")) seen.push(opts.env);
      if (cmd === "git" && args.includes("rev-parse")) return { code: 0, stdout: "abc1234", stderr: "" };
      if (cmd === "git" && args.includes("describe")) return { code: 0, stdout: "v1", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    await deploy(
      { name: "legacy", dir, healthUrl: "http://127.0.0.1:1/health", composeEnv: ["ST_TEST_HTTPS_PROXY_MARKER"] },
      "v2",
      { store: null, exec, health: healthy },
    );
    assert.ok(seen.length > 0);
    assert.equal(seen[0].HTTPS_PROXY, "http://proxy.internal:3128");
    assert.equal(seen[0].DOCKER_BUILDKIT, "0");
    // And a target can name anything else its build needs.
    assert.equal(seen[0].ST_TEST_HTTPS_PROXY_MARKER, "x");
  } finally {
    delete process.env.ST_TEST_HTTPS_PROXY_MARKER;
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a .env that cannot be put back is reported, not just logged", async () => {
  const dir = scratch();
  try {
    // The restore is what stops a rolled-back release from redeploying itself
    // on the next routine "compose up -d", so its failure has to reach the
    // operator rather than only the log.
    const docker = fakeDocker();
    let sabotaged = false;
    const guarded = async (cmd, args, opts) => {
      const result = await docker.exec(cmd, args, opts);
      // Once the rollout is under way, put something in .env's place that
      // cannot be written over, so the rollback's restore fails.
      if (args.includes("up") && !sabotaged) {
        sabotaged = true;
        fs.rmSync(path.join(dir, ".env"));
        fs.mkdirSync(path.join(dir, ".env"));
      }
      return result;
    };
    const store = fakeStore();
    const result = await deploy(registryTarget(dir), "v2", { store, exec: guarded, health: unhealthy });
    assert.equal(result.ok, false);
    assert.match(result.detail, /could NOT be restored/);
    assert.match(result.detail, /intervene/);
    assert.equal(store.deploys.app.kind, "fail", "an unrestored .env is not a clean rollback");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
