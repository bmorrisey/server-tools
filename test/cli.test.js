/**
 * CLI-level behaviour that unit tests cannot reach: the guards that decide
 * whether a command runs at all. An external target stores nothing here, and
 * every command has to say so rather than printing an empty result (or, worse,
 * creating a directory for it).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const CLI = new URL("../src/cli.js", import.meta.url).pathname;

function withConfig(backups) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "st-cli-"));
  const config = { dataDir: path.join(dir, "data"), web: { enabled: false }, backups };
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, JSON.stringify(config));
  return { dir, file, dataDir: config.dataDir };
}

function run(configFile, args) {
  try {
    return { code: 0, out: execFileSync("node", [CLI, ...args], { env: { ...process.env, SERVER_TOOLS_CONFIG: configFile }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

test("every command refuses an external target instead of pretending it has data", () => {
  const { dir, file, dataDir } = withConfig([
    { name: "media", type: "external", note: "Object storage bucket, replicated by the provider" },
  ]);
  try {
    for (const args of [["artifacts", "media"], ["backup", "media"], ["restore", "media"], ["drill", "media"], ["export", "media"]]) {
      const r = run(file, args);
      assert.equal(r.code, 1, args.join(" "));
      assert.match(r.out, /external/, args.join(" "));
    }
    // And none of them created a backup directory for a target that will
    // never hold an artifact.
    assert.equal(fs.existsSync(path.join(dataDir, "backups", "media")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validate reports a coverage gap without failing the config", () => {
  const { dir, file } = withConfig([
    { name: "db", type: "postgres", container: "c", user: "u", database: "d", encrypt: false },
  ]);
  try {
    const r = run(file, ["validate"]);
    assert.equal(r.code, 0, "a half-covered deployment is a question, not an error");
    assert.match(r.out, /is valid/);
    assert.match(r.out, /media is not declared/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an option that needs a value says so instead of swallowing the next flag", () => {
  const { dir, file } = withConfig([{ name: "m", type: "files", path: "/tmp", encrypt: false }]);
  try {
    const r = run(file, ["export", "m", "--to", "--dry-run"]);
    assert.equal(r.code, 1);
    assert.match(r.out, /--to needs a value/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
