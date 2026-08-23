/**
 * The application metrics contract and the pure functions over it. The
 * document arrives from a separate application, so most of what matters here
 * is what happens when that application is wrong.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import {
  LIMITS,
  SCHEMA_VERSION,
  breakdownTotal,
  formatDelta,
  formatValue,
  groupDigits,
  numericValue,
  parseSnapshot,
} from "../src/appmetrics/snapshot.js";
import { buildSeries, computeDeltas, downsample, seriesKeys, withinWindow } from "../src/appmetrics/series.js";
import { CollectorState, collect, describeSource, fetchDocument } from "../src/appmetrics/collect.js";

const doc = (metrics, extra = {}) => JSON.stringify({ schema: SCHEMA_VERSION, metrics, ...extra });

/* ---------------------------------------------------------------- contract */

test("a well-formed document becomes a snapshot", () => {
  const { snapshot, problems } = parseSnapshot(
    doc(
      {
        records_total: { value: 128394, label: "Records", kind: "count", cumulative: true },
        storage_used: { value: 8.42e9, label: "Storage used", kind: "bytes" },
        tier_distribution: { value: { free: 812, pro: 44 }, kind: "breakdown" },
      },
      { capturedAt: "2026-08-22T03:00:00Z" },
    ),
    { collectedAt: new Date("2026-08-22T03:05:00Z") },
  );
  assert.deepEqual(problems, []);
  assert.equal(snapshot.collectedAt, "2026-08-22T03:05:00.000Z");
  assert.equal(snapshot.capturedAt, "2026-08-22T03:00:00.000Z");
  assert.deepEqual(Object.keys(snapshot.metrics), ["records_total", "storage_used", "tier_distribution"]);
  assert.equal(snapshot.metrics.records_total.label, "Records");
  // Null-prototype, so a category named "__proto__" is data rather than a
  // silent no-op; the stored JSON is identical either way.
  assert.deepEqual({ ...snapshot.metrics.tier_distribution.value }, { free: 812, pro: 44 });
  assert.equal(JSON.stringify(snapshot.metrics.tier_distribution.value), '{"free":812,"pro":44}');
});

test("an unknown schema is refused rather than guessed at", () => {
  // A payload the agent half-understands is worse than one it rejects,
  // because the numbers still render.
  assert.throws(() => parseSnapshot(doc({ a: { value: 1 } }).replace('"schema":1', '"schema":2')), /schema 2/);
  assert.throws(() => parseSnapshot(JSON.stringify({ metrics: {} })), /schema/);
});

test("envelope problems fail the collection", () => {
  assert.throws(() => parseSnapshot("not json at all"), /not valid JSON/);
  assert.throws(() => parseSnapshot(JSON.stringify([1, 2])), /must be a JSON object/);
  assert.throws(() => parseSnapshot(JSON.stringify({ schema: 1 })), /must have a metrics object/);
  assert.throws(() => parseSnapshot(JSON.stringify({ schema: 1, metrics: [] })), /must have a metrics object/);
});

test("one bad metric is dropped and reported, not fatal to the rest", () => {
  const { snapshot, problems } = parseSnapshot(
    doc({
      good: { value: 5, kind: "count" },
      not_a_number: { value: "twelve" },
      infinite: { value: Number.POSITIVE_INFINITY },
      bad_kind: { value: 1, kind: "temperature" },
      "bad key!": { value: 1 },
    }),
  );
  assert.deepEqual(Object.keys(snapshot.metrics), ["good"]);
  assert.equal(snapshot.dropped, 4);
  assert.equal(problems.length, 4);
  assert.ok(problems.some((p) => p.includes("not_a_number: value must be a finite number")));
  assert.ok(problems.some((p) => p.includes('bad_kind: kind "temperature" is not one of')));
});

test("a document with nothing usable in it is a failure", () => {
  assert.throws(() => parseSnapshot(doc({ a: { value: "x" } })), /no usable metrics/);
  // But a document that publishes nothing at all is legitimate: an app can
  // have nothing to say yet.
  const { snapshot } = parseSnapshot(doc({}));
  assert.deepEqual(snapshot.metrics, {});
});

test("caps bound what one broken app can do to the agent", () => {
  const many = Object.fromEntries(Array.from({ length: LIMITS.metrics + 1 }, (_, i) => [`m${i}`, { value: i }]));
  assert.throws(() => parseSnapshot(doc(many)), /the limit is 200/);

  const wide = Object.fromEntries(Array.from({ length: LIMITS.breakdownEntries + 1 }, (_, i) => [`c${i}`, i]));
  const { problems } = parseSnapshot(doc({ b: { value: wide, kind: "breakdown" }, ok: { value: 1 } }));
  assert.ok(problems[0].includes("at most 50 categories"));

  assert.throws(() => parseSnapshot("x".repeat(LIMITS.bytes + 1)), /larger than/);

  const longLabel = parseSnapshot(doc({ a: { value: 1, label: "l".repeat(LIMITS.labelLength + 1) }, b: { value: 2 } }));
  assert.ok(longLabel.problems[0].includes("at most 120 characters"));
});

test("a capture time the agent does not control never becomes the record time", () => {
  const { snapshot } = parseSnapshot(doc({ a: { value: 1 } }, { capturedAt: "not a date" }), {
    collectedAt: new Date("2026-01-01T00:00:00Z"),
  });
  assert.equal(snapshot.collectedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(snapshot.capturedAt, undefined);
});

/* -------------------------------------------------------------- formatting */

test("values are formatted by kind, with units stated rather than implied", () => {
  assert.equal(formatValue(128394, { kind: "count" }), "128,394");
  assert.equal(formatValue(8.42e9, { kind: "bytes" }), "7.8 GiB");
  assert.equal(formatValue(3.7, { kind: "number", precision: 1 }), "3.7");
  assert.equal(formatValue(42.55, { kind: "percent" }), "42.6%");
  assert.equal(formatValue(90_000, { kind: "duration" }), "1m 30s");
  assert.equal(formatValue({ free: 812, pro: 44 }, { kind: "breakdown" }), "free 812, pro 44");
  assert.equal(formatValue(Number.NaN, { kind: "count" }), "-");
  assert.equal(formatValue({}, { kind: "breakdown" }), "-");
});

test("digit grouping does not depend on a locale the server and browser share", () => {
  assert.equal(groupDigits(1234567), "1,234,567");
  assert.equal(groupDigits(-1234.5), "-1,234.5");
  assert.equal(groupDigits(999), "999");
});

test("a delta carries its sign and its metric's unit", () => {
  assert.equal(formatDelta(412, { kind: "count" }), "+412");
  assert.equal(formatDelta(-1048576, { kind: "bytes" }), "-1.0 MiB");
  assert.equal(formatDelta(0, { kind: "count" }), "no change");
  assert.equal(formatDelta(null, { kind: "count" }), null);
});

test("a breakdown plots as its total", () => {
  assert.equal(breakdownTotal({ free: 812, pro: 44 }), 856);
  assert.equal(numericValue({ kind: "breakdown", value: { a: 1, b: 2 } }), 3);
  assert.equal(numericValue({ kind: "count", value: 7 }), 7);
  assert.equal(numericValue({ kind: "count", value: "x" }), null);
  assert.equal(numericValue(undefined), null);
});

/* ------------------------------------------------------------------ series */

const at = (iso, metrics) => ({ collectedAt: new Date(iso).toISOString(), metrics });

test("a metric missing from a snapshot leaves a gap, not a zero", () => {
  const snapshots = [
    at("2026-08-01T00:00:00Z", { a: { value: 1, kind: "count" } }),
    at("2026-08-02T00:00:00Z", {}),
    at("2026-08-03T00:00:00Z", { a: { value: 3, kind: "count" } }),
  ];
  const points = buildSeries(snapshots, "a", { numericValue });
  assert.equal(points.length, 2);
  assert.deepEqual(points.map((p) => p[1]), [1, 3]);
});

test("keys still being published are separated from ones that stopped", () => {
  const snapshots = [
    at("2026-08-01T00:00:00Z", { a: { value: 1 }, retired: { value: 9 } }),
    at("2026-08-02T00:00:00Z", { a: { value: 2 }, b: { value: 5 } }),
  ];
  const { current, retired } = seriesKeys(snapshots);
  assert.deepEqual(current, ["a", "b"]);
  assert.deepEqual(retired, ["retired"]);
});

test("deltas compare with the previous sample and the same time last week", () => {
  const day = 86_400_000;
  const base = Date.parse("2026-08-22T03:00:00Z");
  const points = [];
  for (let i = 7; i >= 0; i--) points.push([base - i * day, 100 + (7 - i) * 10]);
  const d = computeDeltas(points);
  assert.equal(d.latest.value, 170);
  assert.equal(d.previous.delta, 10);
  assert.equal(d.weekAgo.delta, 70);
});

test("a week-ago delta is only offered when a sample actually exists near it", () => {
  const day = 86_400_000;
  const base = Date.parse("2026-08-22T03:00:00Z");
  // Two samples three days apart: nothing is near a week ago.
  const d = computeDeltas([[base - 3 * day, 5], [base, 9]]);
  assert.equal(d.previous.delta, 4);
  assert.equal(d.weekAgo, null, "inventing a comparison the data does not support is worse than showing none");
  assert.deepEqual(computeDeltas([]), { latest: null, previous: null, weekAgo: null });
  assert.equal(computeDeltas([[base, 1]]).previous, null);
});

test("downsampling keeps the ends exactly and does not flatten a spike", () => {
  const points = Array.from({ length: 5000 }, (_, i) => [i, 10]);
  points[2500] = [2500, 9999]; // the one interesting day
  const out = downsample(points, 600);
  assert.ok(out.length <= 600);
  assert.deepEqual(out[0], points[0]);
  assert.deepEqual(out[out.length - 1], points[points.length - 1]);
  assert.ok(out.some(([, v]) => v === 9999), "a downsample that hides the spike is worse than no chart");
  // Short series are returned untouched.
  const few = [[1, 1], [2, 2]];
  assert.equal(downsample(few, 600), few);
});

test("a window filters by the agent's clock", () => {
  const snapshots = [at("2026-01-01T00:00:00Z", {}), at("2026-08-01T00:00:00Z", {})];
  assert.equal(withinWindow(snapshots, Date.parse("2026-06-01T00:00:00Z")).length, 1);
  assert.equal(withinWindow(snapshots, null).length, 2);
});

/* ------------------------------------------------------------------- store */

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "st-metrics-"));
  const store = new Store(dir);
  store.ensureDirs();
  return { dir, store };
}

test("snapshots are stored by month and read back in order", () => {
  const { dir, store } = tmpStore();
  try {
    store.appendSnapshot("app", { collectedAt: "2026-07-31T12:00:00Z", metrics: { a: { value: 1 } } });
    store.appendSnapshot("app", { collectedAt: "2026-08-01T12:00:00Z", metrics: { a: { value: 2 } } });
    // A name that is a prefix of another is the case that matters: "app" must
    // not read "app-staging", and both are legal names.
    store.appendSnapshot("app-staging", { collectedAt: "2026-08-01T12:00:00Z", metrics: { a: { value: 99 } } });

    const files = fs.readdirSync(path.join(dir, "metrics")).sort();
    assert.deepEqual(files, ["app-2026-07.jsonl", "app-2026-08.jsonl", "app-staging-2026-08.jsonl"]);

    const all = store.readSnapshots("app");
    assert.deepEqual(all.map((s) => s.metrics.a.value), [1, 2], "one app never picks up another's history");
    assert.deepEqual(store.readSnapshots("app-staging").map((s) => s.metrics.a.value), [99]);
    const recent = store.readSnapshots("app", { sinceMs: Date.parse("2026-08-01T00:00:00Z") });
    assert.deepEqual(recent.map((s) => s.metrics.a.value), [2]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a housekeeping pass cannot reach a metrics snapshot", async () => {
  // pruneHistory matches any "-YYYY-MM-DD.jsonl" under history/ and deletes by
  // date regardless of topic, and housekeep calls it with historyDays ?? 90. A
  // series meant to last years must not be governed by a setting made for
  // check samples, and the failure mode is data quietly going missing months
  // later rather than anything breaking at the time - so this runs the real
  // housekeeping entry point, not just the store method underneath it.
  const { housekeep } = await import("../src/housekeep.js");
  const { dir, store } = tmpStore();
  try {
    // An old day-file of the kind housekeeping exists to remove, and a metrics
    // snapshot of the same age.
    const old = new Date(Date.now() - 400 * 86_400_000);
    const day = old.toISOString().slice(0, 10);
    const historyFile = path.join(dir, "history", `checks-${day}.jsonl`);
    fs.writeFileSync(historyFile, `${JSON.stringify({ ts: old.toISOString(), name: "demo" })}\n`);
    store.appendSnapshot("app", { collectedAt: old.toISOString(), metrics: { a: { value: 1 } } });

    const result = await housekeep({ dataDir: dir, housekeeping: { historyDays: 90 } }, store);
    assert.equal(fs.existsSync(historyFile), false, "the history file it is meant to prune was pruned");
    assert.match(result.summary.join(" "), /history: removed/);
    assert.equal(store.readSnapshots("app").length, 1, "the metrics snapshot survived");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("retention drops whole months once they are entirely past the cutoff", () => {
  const { dir, store } = tmpStore();
  try {
    const old = new Date(Date.now() - 400 * 86_400_000).toISOString();
    store.appendSnapshot("app", { collectedAt: old, metrics: {} });
    store.appendSnapshot("app", { collectedAt: new Date().toISOString(), metrics: {} });
    assert.equal(store.readSnapshots("app").length, 2);
    assert.equal(store.pruneSnapshots("app", 365), 1);
    assert.equal(store.readSnapshots("app").length, 1);
    // A retention of zero or nonsense removes nothing rather than everything.
    assert.equal(store.pruneSnapshots("app", 0), 0);
    assert.equal(store.readSnapshots("app").length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a name that would escape the metrics directory is refused", () => {
  const { dir, store } = tmpStore();
  try {
    assert.throws(() => store.metricsFile("../../etc/passwd"), /unsafe metrics app name/);
    assert.throws(() => store.appendSnapshot("a/b", { collectedAt: new Date().toISOString(), metrics: {} }), /unsafe/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* --------------------------------------------------------------- collector */

test("a collection stores a snapshot and records the outcome", async () => {
  const { dir, store } = tmpStore();
  try {
    const target = { name: "app", source: { url: "http://127.0.0.1:9/metrics" } };
    const fetchImpl = async () => ({ ok: true, headers: { get: () => null }, text: async () => doc({ a: { value: 5, kind: "count" } }) });
    const patch = await collect(target, { store, fetchImpl });
    assert.equal(patch.lastResult, "ok");
    assert.equal(patch.lastCount, 1);
    assert.equal(store.readSnapshots("app").length, 1);
    assert.equal(store.readState("metrics", {}).app.lastResult, "ok");
    assert.ok(store.recent("events").some((e) => e.topic === "metrics" && e.kind === "ok"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed collection is recorded and thrown, never a silent gap", async () => {
  const { dir, store } = tmpStore();
  try {
    const target = { name: "app", source: { url: "http://127.0.0.1:9/metrics" } };
    const fetchImpl = async () => ({ ok: false, status: 503, headers: { get: () => null }, text: async () => "" });
    await assert.rejects(() => collect(target, { store, fetchImpl }), /HTTP 503/);
    const state = store.readState("metrics", {}).app;
    assert.equal(state.lastResult, "fail");
    assert.match(state.lastDetail, /HTTP 503/);
    assert.ok(store.recent("events").some((e) => e.topic === "metrics" && e.kind === "fail"));
    assert.equal(store.readSnapshots("app").length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("dropped metrics are surfaced in the recorded detail", async () => {
  const { dir, store } = tmpStore();
  try {
    const target = { name: "app", source: { url: "http://127.0.0.1:9/m" } };
    const fetchImpl = async () => ({
      ok: true,
      headers: { get: () => null },
      text: async () => doc({ good: { value: 1 }, bad: { value: "x" } }),
    });
    const patch = await collect(target, { store, fetchImpl });
    assert.equal(patch.lastDropped, 1);
    assert.match(patch.lastDetail, /1 dropped/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the token reaches the request and nothing else", async () => {
  let seen = null;
  const target = { name: "app", source: { url: "http://127.0.0.1:9/m", token: "s3cret-value" } };
  const fetchImpl = async (_url, opts) => {
    seen = opts.headers;
    return { ok: true, headers: { get: () => null }, text: async () => doc({}) };
  };
  await fetchDocument(target, { fetchImpl });
  assert.equal(seen.authorization, "Bearer s3cret-value");

  // And a failure names the source without carrying the credential into the
  // message that ends up in the event log and on the dashboard.
  const failing = async () => ({ ok: false, status: 401, headers: { get: () => null }, text: async () => "" });
  await assert.rejects(
    () => fetchDocument(target, { fetchImpl: failing }),
    (e) => !e.message.includes("s3cret-value") && /HTTP 401/.test(e.message),
  );
});

test("an oversized response is refused before it is parsed", async () => {
  const target = { name: "app", source: { url: "http://127.0.0.1:9/m" } };
  const declared = async () => ({ ok: true, headers: { get: () => String(LIMITS.bytes + 1) }, text: async () => "{}" });
  await assert.rejects(() => fetchDocument(target, { fetchImpl: declared }), /the limit is/);

  const lying = async () => ({ ok: true, headers: { get: () => "10" }, text: async () => "x".repeat(LIMITS.bytes + 1) });
  await assert.rejects(() => fetchDocument(target, { fetchImpl: lying }), /larger than/);
});

test("a file source is read from disk", async () => {
  const { dir, store } = tmpStore();
  try {
    const file = path.join(dir, "metrics.json");
    fs.writeFileSync(file, doc({ queue_depth: { value: 12, kind: "count" } }));
    const patch = await collect({ name: "app", source: { file } }, { store });
    assert.equal(patch.lastCount, 1);
    assert.equal(store.readSnapshots("app")[0].metrics.queue_depth.value, 12);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("collection failures alert once and recover once", () => {
  const state = new CollectorState();
  assert.equal(state.evaluate("app", false, 2), null, "one failure is recorded, not alerted");
  assert.equal(state.evaluate("app", false, 2), "fail");
  assert.equal(state.evaluate("app", false, 2), null, "still failing is not a second alert");
  assert.equal(state.evaluate("app", true, 2), "recover");
  assert.equal(state.evaluate("app", true, 2), null);
});

test("an unbounded chunked response is cut off, not buffered whole", async () => {
  // A chunked reply declares no length, so measuring after reading is not a
  // cap at all: the agent would hold the whole thing first.
  const http = await import("node:http");
  let sent = 0;
  let cancelled = false;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" }); // chunked, no length
    const chunk = "x".repeat(64 * 1024);
    const pump = () => {
      if (res.writableEnded || cancelled) return;
      sent += chunk.length;
      if (sent > 20 * 1024 * 1024) return res.end(); // do not run away in a test
      if (res.write(chunk)) setImmediate(pump);
      else res.once("drain", pump);
    };
    res.on("close", () => (cancelled = true));
    pump();
  });
  await new Promise((r) => server.listen(0, r));
  try {
    const target = { name: "app", source: { url: `http://127.0.0.1:${server.address().port}/m` } };
    await assert.rejects(() => fetchDocument(target), /larger than/);
    // It stopped early rather than reading everything the server would send.
    assert.ok(sent < 5 * 1024 * 1024, `read ${sent} bytes before giving up`);
  } finally {
    server.close();
  }
});

test("a source that is not a regular file is refused rather than blocking", async () => {
  const { execFileSync } = await import("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "st-fifo-"));
  try {
    const fifo = path.join(dir, "pipe");
    execFileSync("mkfifo", [fifo]);

    // A FIFO reports size 0, so a size check waves it through, and the read
    // then blocks forever - on a scheduled collector that is a stuck job
    // rather than a failed one. The read must never be reached, so the stub
    // records whether it was: asserting on a hang would only turn a
    // regression into a test suite that never finishes.
    let readAttempted = false;
    const readFile = async () => {
      readAttempted = true;
      return "{}";
    };
    await assert.rejects(() => fetchDocument({ name: "app", source: { file: fifo } }, { readFile }), /not a regular file/);
    assert.equal(readAttempted, false, "refused before the read that would block");

    await assert.rejects(() => fetchDocument({ name: "app", source: { file: dir } }, { readFile }), /not a regular file/);
    assert.equal(readAttempted, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the byte cap counts bytes, not characters", () => {
  // A multi-byte document is bigger than its length suggests.
  const multibyte = "é".repeat(LIMITS.bytes - 10); // 2 bytes each
  assert.ok(multibyte.length < LIMITS.bytes);
  assert.throws(() => parseSnapshot(multibyte), /larger than/);
});

test("retention keeps the cutoff month whole", () => {
  // The boundary of a deletion, which the 400-days-vs-365 case never reaches.
  // Getting "<" wrong here destroys data the operator asked to keep.
  const { dir, store } = tmpStore();
  try {
    const now = new Date();
    const thisMonth = new Date(now.getFullYear(), now.getMonth(), 15).toISOString();
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15).toISOString();
    store.appendSnapshot("app", { collectedAt: lastMonth, metrics: {} });
    store.appendSnapshot("app", { collectedAt: thisMonth, metrics: {} });
    // A retention that reaches back into last month must keep last month.
    assert.equal(store.pruneSnapshots("app", 45), 0);
    assert.equal(store.readSnapshots("app").length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a window skips whole months without dropping a record inside one", () => {
  const { dir, store } = tmpStore();
  try {
    store.appendSnapshot("app", { collectedAt: "2026-06-15T00:00:00Z", metrics: { a: { value: 1 } } });
    store.appendSnapshot("app", { collectedAt: "2026-08-05T00:00:00Z", metrics: { a: { value: 2 } } });
    store.appendSnapshot("app", { collectedAt: "2026-08-25T00:00:00Z", metrics: { a: { value: 3 } } });
    // Mid-month cutoff: the month file is read, and the record before the
    // cutoff inside it is still excluded.
    const got = store.readSnapshots("app", { sinceMs: Date.parse("2026-08-10T00:00:00Z") });
    assert.deepEqual(got.map((s) => s.metrics.a.value), [3]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a metric key cannot start with an underscore", () => {
  // "__proto__" as a metric key assigns the object's own prototype, so the
  // metric silently disappears rather than being reported.
  // Raw JSON text: a JS object literal would set the prototype instead of
  // creating the key, so the payload has to be written out.
  const { problems } = parseSnapshot('{"schema":1,"metrics":{"__proto__":{"value":1},"ok":{"value":2}}}');
  assert.ok(problems.some((p) => p.startsWith("__proto__:")));
  const { problems: leading } = parseSnapshot(doc({ _private: { value: 1 }, ok: { value: 2 } }));
  assert.ok(leading.some((p) => p.startsWith("_private:")));
});

test("a JSON value that parses to Infinity is dropped, not stored as null", () => {
  // 1e999 is legal JSON text and becomes Infinity, which JSON.stringify would
  // then write back as null.
  const { snapshot, problems } = parseSnapshot('{"schema":1,"metrics":{"big":{"value":1e999},"ok":{"value":1}}}');
  assert.deepEqual(Object.keys(snapshot.metrics), ["ok"]);
  assert.ok(problems.some((p) => p.includes("big: value must be a finite number")));
});

test("a slow source is abandoned rather than wedging the collector", async () => {
  // agent.js awaits the collection before re-arming the job, so a source that
  // never finishes stops that job permanently and alerts nobody.
  const http = await import("node:http");
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"schema":1,');
    // and then nothing, forever
  });
  await new Promise((r) => server.listen(0, r));
  try {
    const target = { name: "app", source: { url: `http://127.0.0.1:${server.address().port}/m` } };
    // Racing rather than awaiting: without the timeout this never settles, and
    // a test that hangs reports a regression as a CI timeout rather than a
    // named failure.
    const outcome = await Promise.race([
      fetchDocument(target, { timeoutMs: 300 }).then(() => "resolved", () => "abandoned"),
      new Promise((r) => setTimeout(() => r("hung"), 4000)),
    ]);
    assert.equal(outcome, "abandoned", "a source that never finishes must be given up on");
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test("a redirect is not followed", async () => {
  // Following one would send the bearer token somewhere the operator did not
  // configure.
  const http = await import("node:http");
  let secondHop = false;
  const server = http.createServer((req, res) => {
    if (req.url === "/m") {
      res.writeHead(302, { location: "/elsewhere" });
      return res.end();
    }
    secondHop = true;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(doc({ a: { value: 1 } }));
  });
  await new Promise((r) => server.listen(0, r));
  try {
    const target = { name: "app", source: { url: `http://127.0.0.1:${server.address().port}/m`, token: "tok" } };
    await assert.rejects(() => fetchDocument(target), /HTTP 302/);
    assert.equal(secondHop, false);
  } finally {
    server.close();
  }
});

test("a url with a credential in it is not written to state, events, or logs", () => {
  assert.equal(describeSource({ url: "https://u:pw@host:3000/m?token=SECRET#f" }), "https://host:3000/m");
  assert.equal(describeSource({ url: "not a url" }), "configured url");
  assert.equal(describeSource({ file: "/apps/app/metrics.json" }), "/apps/app/metrics.json");
});

test("an empty publish does not retire every metric", async () => {
  // An app mid-deploy, or one whose query failed, publishes {}. Reading the
  // latest snapshot blindly would report the whole history as retired while
  // recording the collection as ok.
  const full = { collectedAt: "2026-08-01T00:00:00Z", metrics: { a: { value: 1 }, b: { value: 2 } } };
  const empty = { collectedAt: "2026-08-02T00:00:00Z", metrics: {} };
  const { current, retired } = seriesKeys([full, empty]);
  assert.deepEqual(current, ["a", "b"]);
  assert.deepEqual(retired, []);
});
