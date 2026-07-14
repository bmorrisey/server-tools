import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { CheckEngine, runCheck } from "../src/checks.js";
import { Store } from "../src/store.js";

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "st-checks-"));
  const store = new Store(dir);
  store.ensureDirs();
  return { store, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("alert state machine: alerts only after threshold, recovers once", () => {
  const engine = new CheckEngine({ config: { checkDefaults: {} }, store: null, docker: null });
  const fail = { status: "fail", detail: "x" };
  const ok = { status: "ok", detail: "y" };

  assert.equal(engine.evaluateTransition("c", fail, 3), null);
  assert.equal(engine.evaluateTransition("c", fail, 3), null);
  const alert = engine.evaluateTransition("c", fail, 3);
  assert.equal(alert.kind, "fail");
  // Still failing: no duplicate alert.
  assert.equal(engine.evaluateTransition("c", fail, 3), null);
  const recover = engine.evaluateTransition("c", ok, 3);
  assert.equal(recover.kind, "recover");
  // Already recovered: no duplicate recovery.
  assert.equal(engine.evaluateTransition("c", ok, 3), null);
});

test("a blip shorter than the threshold never alerts", () => {
  const engine = new CheckEngine({ config: { checkDefaults: {} }, store: null, docker: null });
  const fail = { status: "fail", detail: "x" };
  const ok = { status: "ok", detail: "y" };
  assert.equal(engine.evaluateTransition("c", fail, 2), null);
  assert.equal(engine.evaluateTransition("c", ok, 2), null); // recovered before alerting
  assert.equal(engine.evaluateTransition("c", fail, 2), null); // counter restarted
});

test("http check: ok, expected status, json assertion, and failure", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/ok") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "healthy", db: { ok: true } }));
    } else if (req.url === "/teapot") {
      res.writeHead(418);
      res.end();
    } else {
      res.writeHead(500);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const ok = await runCheck({ name: "t", type: "http", url: `${base}/ok` }, {});
  assert.equal(ok.status, "ok");

  const json = await runCheck(
    { name: "t", type: "http", url: `${base}/ok`, expectJson: { status: "healthy", "db.ok": true } },
    {},
  );
  assert.equal(json.status, "ok");

  const jsonBad = await runCheck({ name: "t", type: "http", url: `${base}/ok`, expectJson: { status: "down" } }, {});
  assert.equal(jsonBad.status, "fail");

  const teapot = await runCheck({ name: "t", type: "http", url: `${base}/teapot`, expectStatus: 418 }, {});
  assert.equal(teapot.status, "ok");

  const fail = await runCheck({ name: "t", type: "http", url: `${base}/broken` }, {});
  assert.equal(fail.status, "fail");

  const refused = await runCheck({ name: "t", type: "http", url: "http://127.0.0.1:1/x", timeout: "2s" }, {});
  assert.equal(refused.status, "fail");

  server.close();
});

test("tcp check connects and fails cleanly", async () => {
  const server = http.createServer(() => {});
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const ok = await runCheck({ name: "t", type: "tcp", host: "127.0.0.1", port }, {});
  assert.equal(ok.status, "ok");
  server.close();

  const fail = await runCheck({ name: "t", type: "tcp", host: "127.0.0.1", port: 1, timeout: "2s" }, {});
  assert.equal(fail.status, "fail");
});

test("backup-freshness reads the store and applies thresholds", async () => {
  const { store, cleanup } = tmpStore();
  try {
    let r = await runCheck({ name: "f", type: "backup-freshness", target: "db" }, { store });
    assert.equal(r.status, "fail"); // never backed up

    store.writeState("backups", { db: { lastSuccess: new Date(Date.now() - 3_600_000).toISOString() } });
    r = await runCheck({ name: "f", type: "backup-freshness", target: "db" }, { store });
    assert.equal(r.status, "ok");

    store.writeState("backups", { db: { lastSuccess: new Date(Date.now() - 30 * 3_600_000).toISOString() } });
    r = await runCheck({ name: "f", type: "backup-freshness", target: "db", warnAfter: "26h", failAfter: "50h" }, { store });
    assert.equal(r.status, "warn");

    store.writeState("backups", { db: { lastSuccess: new Date(Date.now() - 60 * 3_600_000).toISOString() } });
    r = await runCheck({ name: "f", type: "backup-freshness", target: "db" }, { store });
    assert.equal(r.status, "fail");
  } finally {
    cleanup();
  }
});

test("disk check evaluates thresholds against a real path", async () => {
  const r = await runCheck({ name: "d", type: "disk", path: os.tmpdir(), warnPct: 99.99, failPct: 100 }, {});
  assert.equal(r.status, "ok");
  const forced = await runCheck({ name: "d", type: "disk", path: os.tmpdir(), warnPct: 0, failPct: 0 }, {});
  assert.equal(forced.status, "fail");
});

test("runOne persists state, history, and fires onTransition", async () => {
  const { store, cleanup } = tmpStore();
  try {
    const transitions = [];
    const engine = new CheckEngine({
      config: { checkDefaults: { failuresBeforeAlert: 1, timeout: "2s" } },
      store,
      docker: null,
      onTransition: (t) => transitions.push(t),
    });
    const check = { name: "down", type: "tcp", host: "127.0.0.1", port: 1 };
    await engine.runOne(check);
    assert.equal(transitions.length, 1);
    assert.equal(transitions[0].kind, "fail");
    const state = store.readState("checks");
    assert.equal(state.down.status, "fail");
    assert.equal(store.recent("checks").length, 1);
    assert.equal(store.recent("events").length, 1);
  } finally {
    cleanup();
  }
});
