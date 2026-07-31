import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { PassThrough } from "node:stream";
import { restore, drill, loadArtifactSql, latestArtifact } from "../src/backup/restore.js";
import { encryptStream } from "../src/backup/crypto.js";
import { Store } from "../src/store.js";

/**
 * The kernel's per-argument limit. A restore that passes the dump through
 * argv works on a tiny database and fails on a real one, so the size of the
 * payload here matters: it is deliberately far bigger than this.
 */
const MAX_ARG_STRLEN = 128 * 1024;

const PASSPHRASE = "test-passphrase-that-is-long-enough";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "st-restore-"));
  const store = new Store(dir);
  store.ensureDirs();
  const target = {
    name: "app-db",
    type: "postgres",
    container: "app-db-1",
    user: "appuser",
    database: "appdb",
    passphrase: PASSPHRASE,
  };
  return { dir, store, target };
}

/** Write an encrypted, gzipped artifact holding `sql`. */
async function writeArtifact(store, target, stamp, sql) {
  const file = path.join(store.backupDir(target.name), `${target.name}-${stamp}.sql.gz.enc`);
  const source = new PassThrough();
  const out = fs.createWriteStream(file);
  const done = encryptStream(PASSPHRASE, source.pipe(zlib.createGzip()), out);
  source.end(sql);
  await done;
  return path.basename(file);
}

/** Records every exec so the test can inspect how the payload was delivered. */
function recordingDocker({ tables = "28", rows = "884" } = {}) {
  const calls = [];
  return {
    calls,
    exec: async (container, cmd, opts = {}) => {
      calls.push({ container, cmd, stdin: opts.stdin ?? null });
      const joined = cmd.join(" ");
      if (joined.includes("pg_tables")) return { exitCode: 0, stdout: `${tables}\n`, stderr: "" };
      if (joined.includes("n_live_tup")) return { exitCode: 0, stdout: `${rows}\n`, stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
}

test("a restore never puts the dump in a command argument", async () => {
  const { dir, store, target } = fixture();
  try {
    // ~3 MB of SQL: comfortably past both the per-argument limit and the
    // 512 KB chunking that used to sit in front of it.
    const sql = `-- dump\n${"INSERT INTO t VALUES ('x');\n".repeat(110_000)}`;
    assert.ok(sql.length > 3_000_000, "the fixture must be large enough to matter");
    const artifact = await writeArtifact(store, target, "20260731-081303", sql);

    const docker = recordingDocker();
    const result = await restore(target, { docker, store, artifact, force: true });
    assert.equal(result.tables, 28);

    for (const call of docker.calls) {
      for (const arg of call.cmd) {
        assert.ok(
          arg.length < MAX_ARG_STRLEN,
          `exec argument of ${arg.length} bytes exceeds the ${MAX_ARG_STRLEN} byte kernel limit`,
        );
      }
      assert.ok(!call.cmd.some((a) => a.includes("INSERT INTO t")), "dump contents must not appear in argv");
    }

    // It arrived over stdin instead, intact.
    const fed = docker.calls.filter((c) => c.stdin);
    assert.equal(fed.length, 1, "exactly one exec carries the payload");
    assert.equal(fed[0].stdin.length, Buffer.byteLength(sql));
    assert.equal(fed[0].stdin.toString("utf8"), sql);
    assert.ok(fed[0].cmd.includes("psql") && fed[0].cmd.includes("-f") && fed[0].cmd.includes("-"), "psql reads stdin");
    assert.ok(fed[0].cmd.includes("ON_ERROR_STOP=1"), "a failed statement must abort the restore");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("nothing is written to a file inside the container", async () => {
  const { dir, store, target } = fixture();
  try {
    const artifact = await writeArtifact(store, target, "20260731-081303", "-- dump\nSELECT 1;\n");
    const docker = recordingDocker();
    await restore(target, { docker, store, artifact, force: true });
    for (const call of docker.calls) {
      const joined = call.cmd.join(" ");
      assert.ok(!/>\s*\/tmp|base64 -d|rm -f? \/tmp/.test(joined), `restore must not stage files in the container: ${joined}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("restore refuses a populated database unless forced", async () => {
  const { dir, store, target } = fixture();
  try {
    const artifact = await writeArtifact(store, target, "20260731-081303", "-- dump\nSELECT 1;\n");
    const docker = recordingDocker({ tables: "12" });
    await assert.rejects(
      () => restore(target, { docker, store, artifact }),
      /already has 12 tables/,
    );
    assert.ok(!docker.calls.some((c) => c.stdin), "no payload is sent when the guard trips");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a drill restores into a scratch database and always drops it", async () => {
  const { dir, store, target } = fixture();
  try {
    await writeArtifact(store, target, "20260731-081303", "-- dump\nSELECT 1;\n");
    const docker = recordingDocker();
    const outcome = await drill(target, { docker, store });

    assert.equal(outcome.lastDrillResult, "ok");
    assert.match(outcome.lastDrillDetail, /28 tables, ~884 rows/);

    const joined = docker.calls.map((c) => c.cmd.join(" "));
    const scratch = joined.find((c) => c.includes("CREATE DATABASE")).match(/st_drill_\d+/)[0];
    assert.ok(joined.some((c) => c.includes(`DROP DATABASE IF EXISTS ${scratch}`)), "the scratch database is dropped");
    assert.ok(!joined.some((c) => c.includes(`-d ${target.database}`)), "a drill never touches the live database");

    assert.equal(store.readState("backups", {})["app-db"].lastDrillResult, "ok");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed drill is recorded and the scratch database still gets dropped", async () => {
  const { dir, store, target } = fixture();
  try {
    await writeArtifact(store, target, "20260731-081303", "-- dump\nSELECT 1;\n");
    const docker = recordingDocker();
    const inner = docker.exec;
    docker.exec = async (container, cmd, opts) => {
      if (opts?.stdin) return { exitCode: 3, stdout: "", stderr: "syntax error at or near garbage" };
      return inner(container, cmd, opts);
    };

    await assert.rejects(() => drill(target, { docker, store }), /psql exit 3/);

    const state = store.readState("backups", {})["app-db"];
    assert.equal(state.lastDrillResult, "fail");
    assert.match(state.lastDrillDetail, /syntax error/);
    assert.ok(
      docker.calls.map((c) => c.cmd.join(" ")).some((c) => c.includes("DROP DATABASE IF EXISTS st_drill_")),
      "cleanup runs even when the restore fails",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("artifacts round-trip through encryption and gzip, newest first", async () => {
  const { dir, store, target } = fixture();
  try {
    const sql = `-- dump\n${"SELECT 1;\n".repeat(50_000)}`;
    await writeArtifact(store, target, "20260730-030000", "-- older\n");
    const newest = await writeArtifact(store, target, "20260731-081303", sql);

    assert.equal(await latestArtifact(target, { store }), newest);
    assert.equal(await loadArtifactSql(target, newest, { store }), sql);
    await assert.rejects(
      () => loadArtifactSql({ ...target, passphrase: "" }, newest, { store }),
      /no passphrase is configured/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
