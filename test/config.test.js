import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { coverageNotes, validateConfig, withDefaults, loadConfig } from "../src/config.js";

const minimal = {
  dataDir: "./data",
  web: { enabled: false },
};

test("minimal config with web disabled validates", () => {
  assert.deepEqual(validateConfig(withDefaults(minimal)), []);
});

test("web enabled requires baseUrl and allowedEmails", () => {
  const problems = validateConfig(withDefaults({ dataDir: "./data" }));
  assert.ok(problems.some((p) => p.includes("web.baseUrl")));
  assert.ok(problems.some((p) => p.includes("web.allowedEmails")));
});

test("check validation catches bad types and missing fields", () => {
  const cfg = withDefaults({
    ...minimal,
    checks: [
      { name: "a", type: "bogus" },
      { type: "http" },
      { name: "c", type: "http", url: "ftp://x" },
      { name: "d", type: "disk" },
      { name: "e", type: "http", url: "https://x", interval: "nope" },
    ],
  });
  const problems = validateConfig(cfg);
  assert.ok(problems.some((p) => p.includes('checks[0].type "bogus"')));
  assert.ok(problems.some((p) => p.includes("checks[1].name")));
  assert.ok(problems.some((p) => p.includes("checks[2].url")));
  assert.ok(problems.some((p) => p.includes("checks[3].path")));
  assert.ok(problems.some((p) => p.includes('checks[4].interval "nope"')));
});

test("postgres backup target requires container/database/user and a passphrase", () => {
  const cfg = withDefaults({
    ...minimal,
    backups: [{ name: "db", type: "postgres" }],
  });
  const problems = validateConfig(cfg);
  assert.ok(problems.some((p) => p.includes("backups[0].container")));
  assert.ok(problems.some((p) => p.includes("backups[0].database")));
  assert.ok(problems.some((p) => p.includes("backups[0].user")));
  assert.ok(problems.some((p) => p.includes("backups[0].passphrase")));
});

test("encrypt false waives the passphrase; s3 requires its four keys", () => {
  const cfg = withDefaults({
    ...minimal,
    backups: [
      { name: "db", type: "postgres", container: "c", database: "d", user: "u", encrypt: false, s3: { bucket: "b" } },
    ],
  });
  const problems = validateConfig(cfg);
  assert.ok(!problems.some((p) => p.includes("passphrase")));
  assert.ok(problems.some((p) => p.includes("s3.region")));
  assert.ok(problems.some((p) => p.includes("s3.accessKeyId")));
  assert.ok(problems.some((p) => p.includes("s3.secretAccessKey")));
});

test("env interpolation resolves ${VAR} strings", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "st-config-"));
  const file = path.join(dir, "config.json");
  process.env.ST_TEST_SECRET = "a very long passphrase from env";
  fs.writeFileSync(
    file,
    JSON.stringify({
      dataDir: "./data",
      web: { enabled: false },
      backups: [
        {
          name: "db",
          type: "postgres",
          container: "c",
          database: "d",
          user: "u",
          passphrase: "${ST_TEST_SECRET}",
        },
      ],
    }),
  );
  const cfg = loadConfig(file);
  assert.equal(cfg.backups[0].passphrase, "a very long passphrase from env");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadConfig reports invalid JSON and missing files clearly", () => {
  assert.throws(() => loadConfig("/nonexistent/config.json"), /cannot read config file/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "st-config-"));
  const file = path.join(dir, "bad.json");
  fs.writeFileSync(file, "{ not json");
  assert.throws(() => loadConfig(file), /not valid JSON/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("registry deploys must state project, image, and services", () => {
  const cfg = withDefaults({
    ...minimal,
    deploys: [{ name: "app", dir: "/apps/app", healthUrl: "https://a/health", source: "registry" }],
  });
  const problems = validateConfig(cfg);
  assert.ok(problems.some((p) => p.includes("deploys[0].project is required")));
  assert.ok(problems.some((p) => p.includes("deploys[0].image is required")));
  assert.ok(problems.some((p) => p.includes("deploys[0].services is required")));
});

test("a registry image carries no tag; the tag is the deploy argument", () => {
  const base = { name: "app", dir: "/apps/app", healthUrl: "https://a/health", source: "registry", project: "app", services: ["app"] };
  assert.ok(
    validateConfig(withDefaults({ ...minimal, deploys: [{ ...base, image: "ghcr.io/o/app:latest" }] })).some((p) =>
      p.includes("must not include a tag"),
    ),
  );
  assert.deepEqual(validateConfig(withDefaults({ ...minimal, deploys: [{ ...base, image: "ghcr.io/o/app" }] })), []);
});

test("git deploys stay valid without the registry fields and reject them when set", () => {
  assert.deepEqual(
    validateConfig(withDefaults({ ...minimal, deploys: [{ name: "app", dir: "/apps/app", healthUrl: "https://a/health" }] })),
    [],
  );
  const problems = validateConfig(
    withDefaults({
      ...minimal,
      deploys: [{ name: "app", dir: "/apps/app", healthUrl: "https://a/health", image: "ghcr.io/o/app", source: "git" }],
    }),
  );
  assert.ok(problems.some((p) => p.includes("only applies to registry deploys")));
});

test("deploy source, project name, and services shape are validated", () => {
  const problems = validateConfig(
    withDefaults({
      ...minimal,
      deploys: [
        { name: "a", dir: "/a", healthUrl: "https://a/h", source: "svn" },
        { name: "b", dir: "/b", healthUrl: "https://b/h", project: "Not Valid" },
        { name: "c", dir: "/c", healthUrl: "https://c/h", services: [] },
        { name: "d", dir: "/d", healthUrl: "https://d/h", healthDelay: "soon", healthAttempts: 0 },
      ],
    }),
  );
  assert.ok(problems.some((p) => p.includes('deploys[0].source must be "git" or "registry"')));
  assert.ok(problems.some((p) => p.includes("deploys[1].project must be a compose project name")));
  assert.ok(problems.some((p) => p.includes("deploys[2].services must be a non-empty array")));
  assert.ok(problems.some((p) => p.includes("deploys[3].healthDelay")));
  assert.ok(problems.some((p) => p.includes("deploys[3].healthAttempts")));
});

test("a files target must say where the media lives", () => {
  const problems = validateConfig(
    withDefaults({
      ...minimal,
      backups: [
        { name: "a", type: "files", encrypt: false },
        { name: "b", type: "files", encrypt: false, source: {} },
        { name: "c", type: "files", encrypt: false, source: { container: "app-1" } },
        { name: "d", type: "files", encrypt: false, source: { volume: "v", container: "app-1", path: "/x" } },
      ],
    }),
  );
  assert.ok(problems.some((p) => p.includes("backups[0].path is required")));
  assert.ok(problems.some((p) => p.includes('backups[1].source must name one of "volume"')));
  assert.ok(problems.some((p) => p.includes("backups[2].source.container needs source.path")));
  assert.ok(problems.some((p) => p.includes("backups[3].source names both a volume and a container")));
});

test("volume and container file sources validate", () => {
  assert.deepEqual(
    validateConfig(
      withDefaults({
        ...minimal,
        backups: [
          { name: "a", type: "files", encrypt: false, source: { volume: "app_media" } },
          { name: "b", type: "files", encrypt: false, source: { container: "app-1", path: "/app/storage" } },
          { name: "c", type: "files", encrypt: false, path: "/srv/media" },
        ],
      }),
    ),
    [],
  );
});

test("an external target needs a note and copies nothing", () => {
  const problems = validateConfig(
    withDefaults({
      ...minimal,
      backups: [{ name: "media", type: "external", schedule: "03:30", retention: { daily: 1 }, s3: { bucket: "b" } }],
    }),
  );
  assert.ok(problems.some((p) => p.includes("backups[0].note is required")));
  assert.ok(problems.some((p) => p.includes("backups[0].schedule does not apply")));
  assert.ok(problems.some((p) => p.includes("backups[0].retention does not apply")));
  assert.ok(problems.some((p) => p.includes("backups[0].s3 does not apply")));
  // No passphrase is demanded of a target that never writes an artifact.
  assert.ok(!problems.some((p) => p.includes("passphrase")));

  assert.deepEqual(
    validateConfig(withDefaults({ ...minimal, backups: [{ name: "media", type: "external", note: "R2 bucket" }] })),
    [],
  );
});

test("a freshness check cannot watch a target that is never backed up here", () => {
  const problems = validateConfig(
    withDefaults({
      ...minimal,
      backups: [{ name: "media", type: "external", note: "R2 bucket" }],
      checks: [
        { name: "media-fresh", type: "backup-freshness", target: "media" },
        { name: "ghost-fresh", type: "backup-freshness", target: "typo" },
      ],
    }),
  );
  assert.ok(problems.some((p) => p.includes("is an external target")));
  assert.ok(problems.some((p) => p.includes('checks[1].target "typo" is not a configured backup target')));
});

test("coverageNotes asks once when every target is a database", () => {
  const dbOnly = coverageNotes({ backups: [{ name: "db", type: "postgres" }] });
  assert.equal(dbOnly.length, 1);
  assert.equal(dbOnly[0].id, "media-not-declared");

  // A target that actually copies media answers the question, as does one
  // that says the media lives somewhere else.
  assert.deepEqual(coverageNotes({ backups: [{ type: "postgres" }, { type: "files", source: { volume: "v" } }] }), []);
  assert.deepEqual(coverageNotes({ backups: [{ type: "postgres" }, { type: "files", path: "/m", archive: true }] }), []);
  assert.deepEqual(coverageNotes({ backups: [{ type: "postgres" }, { type: "external" }] }), []);
  // Nothing to say about a deployment with no database at all.
  assert.deepEqual(coverageNotes({ backups: [] }), []);
  assert.deepEqual(coverageNotes({}), []);
});

test("a manifest-only media target is not mistaken for a copy of the media", () => {
  // It indexes a tree that still exists and restores none of it, so counting
  // it as coverage would just make the gap harder to see.
  const notes = coverageNotes({
    backups: [
      { name: "db", type: "postgres" },
      { name: "media", type: "files", path: "/srv/media" },
    ],
  });
  assert.equal(notes.length, 1);
  assert.equal(notes[0].id, "media-indexed-only");
  assert.match(notes[0].detail, /manifest and no archive/);
});

test("coverage is judged per application when targets name one", () => {
  const notes = coverageNotes({
    backups: [
      { name: "a-db", type: "postgres", app: "alpha" },
      { name: "a-media", type: "files", app: "alpha", source: { volume: "v" } },
      { name: "b-db", type: "postgres", app: "beta" },
    ],
  });
  assert.equal(notes.length, 1);
  assert.equal(notes[0].app, "beta");
});

test("a retention policy that keeps nothing is refused", () => {
  // The Storage page offers pruning as a safe action on the promise that
  // recent backups survive it; all-zero would delete the newest artifact.
  const problems = validateConfig(
    withDefaults({
      ...minimal,
      backups: [
        { name: "db", type: "postgres", container: "c", database: "d", user: "u", encrypt: false, retention: { daily: 0, weekly: 0, monthly: 0 } },
      ],
    }),
  );
  assert.ok(problems.some((p) => p.includes("must keep at least one backup")));
  assert.deepEqual(
    validateConfig(
      withDefaults({
        ...minimal,
        backups: [
          { name: "db", type: "postgres", container: "c", database: "d", user: "u", encrypt: false, retention: { daily: 0, weekly: 0, monthly: 1 } },
        ],
      }),
    ),
    [],
  );
});

test("a docker-sourced target cannot be manifest-only, because nothing could verify it", () => {
  const problems = validateConfig(
    withDefaults({
      ...minimal,
      backups: [{ name: "media", type: "files", encrypt: false, source: { volume: "v" }, archive: false }],
    }),
  );
  assert.ok(problems.some((p) => p.includes("archive")));
});
