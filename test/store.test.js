import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "st-store-"));
  const store = new Store(dir);
  store.ensureDirs();
  return { store, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("state write/read roundtrip with atomic replace", () => {
  const { store, cleanup } = tmpStore();
  try {
    assert.equal(store.readState("nope"), null);
    assert.deepEqual(store.readState("nope", {}), {});
    store.writeState("checks", { a: 1 });
    assert.deepEqual(store.readState("checks"), { a: 1 });
    store.writeState("checks", { a: 2 });
    assert.deepEqual(store.readState("checks"), { a: 2 });
  } finally {
    cleanup();
  }
});

test("append + recent returns records in order and tolerates torn lines", () => {
  const { store, dir, cleanup } = tmpStore();
  try {
    store.append("events", { n: 1 });
    store.append("events", { n: 2 });
    const day = new Date().toISOString().slice(0, 10);
    fs.appendFileSync(path.join(dir, "history", `events-${day}.jsonl`), "{ torn line\n");
    store.append("events", { n: 3 });
    const recs = store.recent("events");
    assert.deepEqual(recs.map((r) => r.n), [1, 2, 3]);
    assert.ok(recs.every((r) => typeof r.ts === "string"));
    assert.deepEqual(store.recent("events", { limit: 2 }).map((r) => r.n), [2, 3]);
  } finally {
    cleanup();
  }
});

test("pruneHistory removes only old day files", () => {
  const { store, dir, cleanup } = tmpStore();
  try {
    const old = path.join(dir, "history", "checks-2020-01-01.jsonl");
    fs.writeFileSync(old, "{}\n");
    store.append("checks", { n: 1 });
    const removed = store.pruneHistory(30);
    assert.equal(removed, 1);
    assert.ok(!fs.existsSync(old));
    assert.equal(store.recent("checks").length, 1);
  } finally {
    cleanup();
  }
});
