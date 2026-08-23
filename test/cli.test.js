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

test("export prints the strip flag that matches the archive's shape", () => {
  // The two source kinds root their archives differently. Printing the wrong
  // flag puts every restored file one directory too deep, which looks like it
  // worked and 404s every image.
  const { dir, file, dataDir } = withConfig([{ name: "media", type: "files", path: path.join(os.tmpdir(), "unused"), encrypt: false }]);
  try {
    const backups = path.join(dataDir, "backups", "media");
    fs.mkdirSync(backups, { recursive: true });
    const stamp = "20260101-030000";
    fs.writeFileSync(path.join(backups, `media-${stamp}.tar.gz`), "not really gzip");

    // A manifest with a filesystem root came from `tar -C dir .`: already relative.
    fs.writeFileSync(path.join(backups, `media-${stamp}.manifest.json`), JSON.stringify({ root: "/srv/media", files: [] }));
    let out = run(file, ["export", "media", `media-${stamp}.tar.gz`, "--to", path.join(dir, "a.tar.gz")]).out;
    assert.match(out, /unpack with: tar -xz -C/);
    assert.doesNotMatch(out, /strip-components/);

    // One taken through the Docker socket is rooted at the copied directory.
    fs.writeFileSync(path.join(backups, `media-${stamp}.manifest.json`), JSON.stringify({ root: null, files: [] }));
    out = run(file, ["export", "media", `media-${stamp}.tar.gz`, "--to", path.join(dir, "b.tar.gz")]).out;
    assert.match(out, /unpack with: tar -xz --strip-components=1 -C/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("metrics and collect report clearly when nothing is configured", () => {
  const { dir, file } = withConfig([]);
  try {
    for (const args of [["metrics"], ["collect"]]) {
      const r = run(file, args);
      assert.equal(r.code, 1, args[0]);
      assert.match(r.out, /no application metrics are configured/);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("collect reads a published file and metrics prints it back", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "st-cli-"));
  try {
    const published = path.join(dir, "published.json");
    fs.writeFileSync(
      published,
      JSON.stringify({
        schema: 1,
        metrics: {
          records_total: { value: 128394, label: "Records", kind: "count" },
          storage_used: { value: 8.42e9, label: "Storage used", kind: "bytes" },
        },
      }),
    );
    const config = {
      dataDir: path.join(dir, "data"),
      web: { enabled: false },
      appMetrics: [{ name: "example", label: "Example application", source: { file: published } }],
    };
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, JSON.stringify(config));

    const collected = run(file, ["collect"]);
    assert.equal(collected.code, 0, collected.out);
    assert.match(collected.out, /OK {3}example: 2 metrics/);

    const shown = run(file, ["metrics"]);
    assert.equal(shown.code, 0);
    assert.match(shown.out, /Example application \(example\)/);
    assert.match(shown.out, /Records {2,}128,394/);
    assert.match(shown.out, /Storage used {2,}7\.8 GiB/);

    // An unknown application names the ones that exist rather than guessing.
    const missing = run(file, ["metrics", "nope"]);
    assert.equal(missing.code, 1);
    assert.match(missing.out, /application metrics target "nope" not found; configured: example/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed collection exits non-zero and says why", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "st-cli-"));
  try {
    const config = {
      dataDir: path.join(dir, "data"),
      web: { enabled: false },
      appMetrics: [{ name: "example", source: { file: path.join(dir, "missing.json") } }],
    };
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, JSON.stringify(config));
    const r = run(file, ["collect"]);
    assert.equal(r.code, 1);
    assert.match(r.out, /FAIL example:/);
    // A gap nobody noticed is what makes a long series worthless.
    const shown = run(file, ["metrics"]);
    assert.match(shown.out, /never collected/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
