import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { diagnose, runAction, gatherContext, ACTION_IDS } from "../src/remediate.js";
import { Store } from "../src/store.js";

test("healthy checks produce no incident", () => {
  assert.equal(diagnose({ type: "disk", path: "/" }, { status: "ok" }), null);
  assert.equal(diagnose(null, null), null);
});

test("container failure explains and offers a restart", () => {
  const inc = diagnose({ type: "container", container: "app-1", name: "app" }, { status: "fail", detail: "not running" });
  assert.equal(inc.severity, "fail");
  assert.match(inc.title, /app-1/);
  assert.match(inc.meaning, /down or unhealthy/);
  assert.ok(inc.causes.length >= 2);
  assert.equal(inc.actions.length, 1);
  assert.equal(inc.actions[0].id, "restart-container");
  assert.equal(inc.actions[0].container, "app-1");
  assert.equal(inc.actions[0].kind, "caution");
});

test("disk failure offers reclaim; http without container gives config guidance", () => {
  const disk = diagnose({ type: "disk", path: "/host" }, { status: "fail", value: 95, detail: "95% used" });
  assert.equal(disk.actions[0].id, "reclaim-docker-space");
  assert.equal(disk.actions[0].kind, "safe");

  const http = diagnose({ type: "http", name: "site", url: "https://x.example/health" }, { status: "fail", detail: "HTTP 502" });
  assert.equal(http.actions.length, 0);
  assert.match(http.guidance, /"container"/);

  const httpWithContainer = diagnose(
    { type: "http", name: "site", url: "https://x.example/health", container: "web-1" },
    { status: "fail" },
  );
  assert.equal(httpWithContainer.actions[0].id, "restart-container");
  assert.equal(httpWithContainer.actions[0].container, "web-1");
});

test("backup-freshness offers run-backup for its target", () => {
  const inc = diagnose({ type: "backup-freshness", target: "app-db" }, { status: "fail", detail: "no backup" });
  assert.equal(inc.actions[0].id, "run-backup");
  assert.equal(inc.actions[0].target, "app-db");
  assert.equal(inc.actions[0].kind, "safe");
});

test("tls-cert warning is guidance-only (no host-level auto-fix)", () => {
  const inc = diagnose({ type: "tls-cert", host: "x.example" }, { status: "warn", detail: "expires in 10d" });
  assert.equal(inc.actions.length, 0);
  assert.match(inc.guidance, /renew automatically/);
});

test("every emitted action id is a known, runnable action", () => {
  const types = [
    { type: "container", container: "c" },
    { type: "http", container: "c", url: "http://x/y" },
    { type: "postgres", container: "c" },
    { type: "disk", path: "/" },
    { type: "backup-freshness", target: "t" },
  ];
  for (const c of types) {
    const inc = diagnose({ ...c, name: "n" }, { status: "fail" });
    for (const a of inc.actions ?? []) assert.ok(ACTION_IDS.has(a.id), `${a.id} in ACTION_IDS`);
  }
});

test("runAction validates targets against config", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "st-rem-"));
  const store = new Store(dir);
  store.ensureDirs();
  const config = { checks: [{ type: "container", container: "known-1" }], backups: [{ name: "db", type: "postgres", container: "known-1" }] };

  try {
    // Unknown container is refused before any docker call.
    let r = await runAction("restart-container", { container: "evil-1" }, { docker: null, store, config });
    assert.equal(r.ok, false);
    assert.match(r.message, /not a container this instance manages/);

    // Known container reaches the docker layer (which we stub).
    const docker = { restart: async (name) => assert.equal(name, "known-1") };
    r = await runAction("restart-container", { container: "known-1" }, { docker, store, config });
    assert.equal(r.ok, true);
    assert.match(r.message, /Restarted known-1/);

    // Unknown backup target refused.
    r = await runAction("run-backup", { target: "nope" }, { docker: null, store, config });
    assert.equal(r.ok, false);

    // Reclaim aggregates reclaimed bytes from both prunes.
    const docker2 = { pruneImages: async () => 1_000_000, pruneBuildCache: async () => 500_000 };
    r = await runAction("reclaim-docker-space", {}, { docker: docker2, store, config });
    assert.equal(r.ok, true);
    assert.match(r.message, /Reclaimed/);

    // run-drill validates target existence and type before touching docker.
    r = await runAction("run-drill", { target: "nope" }, { docker: null, store, config });
    assert.equal(r.ok, false);
    assert.match(r.message, /not a configured backup target/);

    const filesConfig = { checks: [], backups: [{ name: "media", type: "files", path: "/x" }] };
    r = await runAction("run-drill", { target: "media" }, { docker: null, store, config: filesConfig });
    assert.equal(r.ok, false);
    assert.match(r.message, /apply to database targets/);

    // Unknown action id.
    r = await runAction("format-c-drive", {}, { docker: null, store, config });
    assert.equal(r.ok, false);
    assert.match(r.message, /Unknown action/);

    // Every action is recorded to the events history.
    const events = store.recent("events");
    assert.ok(events.some((e) => e.topic === "action" && e.kind === "ok"));
    assert.ok(events.some((e) => e.topic === "action" && e.kind === "fail"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("gatherContext is best-effort and never throws without docker", async () => {
  assert.deepEqual(await gatherContext({ type: "disk", path: "/" }, { docker: null }), {});
  // A docker whose calls reject must not blow up context.
  const docker = { logs: async () => { throw new Error("x"); }, systemDf: async () => { throw new Error("x"); } };
  assert.deepEqual(await gatherContext({ type: "container", container: "c" }, { docker }), {});
});
