import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateConfig, withDefaults, loadConfig } from "../src/config.js";

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
