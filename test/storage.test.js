import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  summarizeDf,
  unusedImages,
  selectStaleContainers,
  projectRollup,
  volumeRows,
  logRotationFindings,
  globMatch,
  buildPlan,
  backupUsage,
  removeUnusedImages,
  removeStaleContainers,
  report,
  invalidate,
} from "../src/storage.js";
import { ACTION_IDS } from "../src/remediate.js";
import { Docker, safeRef } from "../src/docker.js";
import { Store } from "../src/store.js";

const HOUR = 3_600_000;

/**
 * A disk-usage document shaped like the Engine's, with the interesting cases:
 * a used image, an old tagged one, an untagged leftover, a pinned image, a
 * referenced volume and an orphaned one, and build cache in both states.
 */
function df() {
  return {
    LayersSize: 10_000,
    BuilderSize: 1000,
    Images: [
      { Id: "sha256:aaa", RepoTags: ["app:v2"], Size: 4000, VirtualSize: 4000, SharedSize: 1000, Containers: 1, Created: 1_700_000_000 },
      { Id: "sha256:bbb", RepoTags: ["app:v1"], Size: 3500, VirtualSize: 3500, SharedSize: 1000, Containers: 0, Created: 1_600_000_000 },
      { Id: "sha256:ccc", RepoTags: ["<none>:<none>"], Size: 1500, VirtualSize: 1500, SharedSize: 0, Containers: 0, Created: 1_650_000_000 },
      { Id: "sha256:ddd", RepoTags: ["keepme:stable"], Size: 1000, VirtualSize: 1000, SharedSize: 0, Containers: 0, Created: 1_690_000_000 },
    ],
    Containers: [
      {
        Id: "c1",
        Names: ["/web-app-1"],
        Image: "app:v2",
        ImageID: "sha256:aaa",
        State: "running",
        Status: "Up 3 days",
        SizeRw: 100,
        Created: 1_700_000_000,
        Labels: { "com.docker.compose.project": "web", "com.docker.compose.service": "app" },
      },
      {
        Id: "c2",
        Names: ["/web-migrate-run-abc"],
        Image: "app:v1",
        ImageID: "sha256:bbb",
        State: "exited",
        Status: "Exited (0) 5 days ago",
        SizeRw: 200,
        Created: 1_600_000_000,
        Labels: { "com.docker.compose.project": "web", "com.docker.compose.service": "migrate" },
      },
      { Id: "c3", Names: ["/scratch"], Image: "app:v1", ImageID: "sha256:bbb", State: "exited", Status: "Exited (1) 2 days ago", SizeRw: 50, Created: 1_600_000_000, Labels: {} },
    ],
    Volumes: [
      { Name: "web_db", UsageData: { Size: 5000, RefCount: 1 }, Labels: { "com.docker.compose.project": "web" } },
      { Name: "orphan_data", UsageData: { Size: 2000, RefCount: 0 }, Labels: {} },
    ],
    BuildCache: [
      { ID: "bc1", Size: 800, InUse: false, Shared: false },
      { ID: "bc2", Size: 200, InUse: true, Shared: false },
    ],
  };
}

test("summarizeDf follows Docker's accounting and never counts volumes as reclaimable", () => {
  const s = summarizeDf(df());

  assert.equal(s.images.totalBytes, 10_000);
  assert.equal(s.images.count, 4);
  assert.equal(s.images.unusedCount, 3);
  // Only "app:v2" backs a container: 4000 total minus 1000 shared stays put.
  assert.equal(s.images.reclaimableBytes, 7000);
  assert.equal(s.images.danglingBytes, 1500);

  assert.equal(s.containers.totalBytes, 350);
  assert.equal(s.containers.stoppedCount, 2);
  assert.equal(s.containers.reclaimableBytes, 250);

  assert.equal(s.volumes.totalBytes, 7000);
  assert.equal(s.volumes.unusedCount, 1);
  assert.equal(s.volumes.unusedBytes, 2000);

  assert.equal(s.buildCache.totalBytes, 1000);
  assert.equal(s.buildCache.reclaimableBytes, 800);

  // Images + stopped writable layers + build cache. Volume bytes excluded.
  assert.equal(s.reclaimableBytes, 8050);
  assert.ok(!("reclaimableBytes" in s.volumes), "volumes must not advertise reclaimable bytes");
});

test("summarizeDf tolerates an empty or partial document", () => {
  const s = summarizeDf({});
  assert.equal(s.totalBytes, 0);
  assert.equal(s.reclaimableBytes, 0);
  assert.equal(summarizeDf({ Images: [{ Id: "x", Size: 500, Containers: 0 }] }).images.totalBytes, 500);
});

test("globMatch handles literal, wildcard, and anchored patterns", () => {
  assert.ok(globMatch("app:stable", "app:stable"));
  assert.ok(globMatch("app:*", "app:v3"));
  assert.ok(globMatch("*/base:latest", "acme/base:latest"));
  assert.ok(!globMatch("app:*", "other:v3"));
  assert.ok(!globMatch("app:v1", "app:v1-rc"), "patterns are anchored at both ends");
});

test("unusedImages lists only images with no container, honouring the keep list", () => {
  const all = unusedImages(df());
  assert.deepEqual(all.map((i) => i.name), ["app:v1", "ccc (untagged)", "keepme:stable"]);
  assert.equal(all[0].sizeBytes, 3500, "sorted biggest first");
  assert.equal(all[1].dangling, true);

  const kept = unusedImages(df(), { keep: ["keepme:*"] });
  assert.deepEqual(kept.map((i) => i.name), ["app:v1", "ccc (untagged)"]);
  assert.ok(!kept.some((i) => i.tags.includes("app:v2")), "an image backing a container is never a candidate");
});

test("selectStaleContainers only picks up finished, unsupervised, aged-out containers", () => {
  const now = Date.parse("2026-07-27T12:00:00Z");
  const records = [
    { id: "1", name: "old-oneoff", state: "exited", restartPolicy: "no", finishedAt: "2026-07-25T00:00:00Z", sizeBytes: 300 },
    { id: "2", name: "small-oneoff", state: "exited", restartPolicy: "on-failure", finishedAt: "2026-07-24T00:00:00Z", sizeBytes: 10 },
    { id: "3", name: "service-down", state: "exited", restartPolicy: "unless-stopped", finishedAt: "2026-07-20T00:00:00Z", sizeBytes: 900 },
    { id: "4", name: "supervised", state: "exited", restartPolicy: "always", finishedAt: "2026-07-01T00:00:00Z", sizeBytes: 900 },
    { id: "5", name: "just-finished", state: "exited", restartPolicy: "no", finishedAt: "2026-07-27T11:00:00Z", sizeBytes: 900 },
    { id: "6", name: "running", state: "running", restartPolicy: "no", finishedAt: null, sizeBytes: 900 },
    { id: "7", name: "created", state: "created", restartPolicy: "no", finishedAt: null, sizeBytes: 900 },
  ];

  const picked = selectStaleContainers(records, { olderThanMs: 24 * HOUR, now });
  assert.deepEqual(picked.map((c) => c.name), ["old-oneoff", "small-oneoff"]);
  assert.ok(picked[0].stoppedForMs > 24 * HOUR);

  // A longer grace period narrows it further; a shorter one never picks up a
  // supervised service or anything still running.
  const strict = selectStaleContainers(records, { olderThanMs: 7 * 24 * HOUR, now });
  assert.deepEqual(strict.map((c) => c.name), []);
  const loose = selectStaleContainers(records, { olderThanMs: 0, now });
  assert.ok(!loose.some((c) => ["service-down", "supervised", "running", "created"].includes(c.name)));
});

test("projectRollup attributes containers, images, and volumes to compose projects", () => {
  const records = [
    { id: "c1", name: "web-app-1", project: "web", service: "app", state: "running", sizeBytes: 100, image: "app:v2", imageId: "sha256:aaa" },
    { id: "c2", name: "web-migrate", project: "web", service: "migrate", state: "exited", sizeBytes: 200, image: "app:v1", imageId: "sha256:bbb" },
    { id: "c3", name: "scratch", project: null, service: null, state: "exited", sizeBytes: 50, image: "app:v1", imageId: "sha256:bbb" },
  ];
  const rows = projectRollup(records, df());
  const web = rows.find((p) => p.name === "web");
  assert.equal(web.containers, 2);
  assert.equal(web.running, 1);
  assert.equal(web.serviceCount, 2);
  assert.equal(web.writableBytes, 300);
  assert.equal(web.volumeBytes, 5000);
  assert.equal(web.imageBytes, 7500, "distinct images only, counted once each");

  const loose = rows.find((p) => p.name !== "web");
  assert.equal(loose.writableBytes, 50);
  assert.equal(loose.volumeBytes, 2000, "unlabelled volumes land outside any project");
  assert.ok(rows[0].totalBytes >= rows[1].totalBytes, "biggest project first");
});

test("volumeRows flags what nothing references without proposing to delete it", () => {
  const rows = volumeRows(df());
  assert.deepEqual(rows.map((v) => v.name), ["web_db", "orphan_data"]);
  assert.equal(rows[0].inUse, true);
  assert.equal(rows[1].inUse, false);
  assert.equal(rows[1].sizeBytes, 2000);
});

test("logRotationFindings warns only about running containers with unbounded json logs", () => {
  const records = [
    { name: "a", state: "running", logDriver: "json-file", logMaxSize: null },
    { name: "b", state: "running", logDriver: "json-file", logMaxSize: "10m" },
    { name: "c", state: "running", logDriver: "journald", logMaxSize: null },
    { name: "d", state: "exited", logDriver: "json-file", logMaxSize: null },
  ];
  const findings = logRotationFindings(records);
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0].names, ["a"]);
  assert.equal(logRotationFindings([{ name: "b", state: "running", logDriver: "json-file", logMaxSize: "10m" }]).length, 0);
});

test("buildPlan offers only real savings, sorted, and never touches volumes", () => {
  const base = {
    summary: summarizeDf(df()),
    unusedImages: unusedImages(df()),
    staleContainers: [{ name: "old", sizeBytes: 250 }],
    backups: [
      { name: "app-db", prunableCount: 2, prunableBytes: 4000, retention: { daily: 7, weekly: 4, monthly: 6 } },
      { name: "media", prunableCount: 0, prunableBytes: 0, retention: { daily: 7, weekly: 4, monthly: 6 } },
    ],
    toolkit: { historyBytes: 100, tmpBytes: 0, historyFiles: 2, tmpFiles: 0 },
  };
  const plan = buildPlan(base);
  const ids = plan.map((a) => a.id);

  assert.ok(ids.includes("reclaim-build-cache"));
  assert.ok(ids.includes("reclaim-dangling-images"));
  assert.ok(ids.includes("remove-unused-images"));
  assert.ok(ids.includes("remove-stopped-containers"));
  assert.equal(plan.filter((a) => a.id === "prune-backups").length, 1, "a target with nothing to prune is not offered");
  assert.ok(!ids.includes("trim-history"), "trivial history is not worth offering");

  for (let i = 1; i < plan.length; i++) assert.ok(plan[i - 1].bytes >= plan[i].bytes, "biggest saving first");
  for (const action of plan) {
    assert.ok(ACTION_IDS.has(action.id), `${action.id} must be a known action`);
    assert.ok(action.what && action.risk, `${action.id} must explain itself`);
    assert.ok(["safe", "caution"].includes(action.kind));
  }

  const empty = buildPlan({ summary: summarizeDf({}), unusedImages: [], staleContainers: [], backups: [], toolkit: { historyBytes: 0, tmpBytes: 0, historyFiles: 0, tmpFiles: 0 } });
  assert.deepEqual(empty, []);
});

test("no action anywhere in the toolkit removes a volume", () => {
  for (const id of ACTION_IDS) {
    assert.ok(!/volume/i.test(id), `action "${id}" must not target volumes`);
  }
  const source = fs.readFileSync(new URL("../src/storage.js", import.meta.url), "utf8");
  assert.ok(!/removeVolume|volumes\/prune|\/volumes\/[^"]*",\s*"DELETE"/i.test(source), "storage must never call a volume delete endpoint");
  const docker = fs.readFileSync(new URL("../src/docker.js", import.meta.url), "utf8");
  assert.ok(!/volumes\/prune|DELETE.*volumes/i.test(docker), "the Docker client must not expose volume deletion");
});

test("container removal never asks the engine to delete volumes", async () => {
  const calls = [];
  const docker = new Docker();
  docker.request = (method, apiPath) => {
    calls.push(`${method} ${apiPath}`);
    return Promise.resolve({});
  };
  await docker.removeContainer("abc123");
  assert.deepEqual(calls, ["DELETE /containers/abc123"]);
  assert.ok(!calls[0].includes("v=true"));
});

test("docker references that could rewrite the request path are rejected", () => {
  assert.equal(safeRef("acme/app:v1"), "acme/app:v1");
  assert.equal(safeRef("sha256:abc123"), "sha256:abc123");
  for (const bad of ["../containers/x", "app:v1?force=true", "app v1", "app:v1#x", "", "-rf"]) {
    assert.throws(() => safeRef(bad), /unsafe docker reference/);
  }
});

/** Fake engine that records what was asked of it. */
function fakeDocker({ document = df(), failOn = [] } = {}) {
  const removed = { images: [], containers: [] };
  let layers = document.LayersSize;
  return {
    removed,
    systemDf: async () => ({ ...document, LayersSize: layers }),
    inspect: async (id) => ({
      Id: id,
      State: { FinishedAt: "2026-07-20T00:00:00Z" },
      HostConfig: { RestartPolicy: { Name: id === "c3" ? "unless-stopped" : "no" }, LogConfig: { Type: "json-file", Config: {} } },
      LogPath: null,
    }),
    removeImage: async (ref) => {
      if (failOn.includes(ref)) throw new Error("conflict: image is in use");
      removed.images.push(ref);
      layers -= 1000;
    },
    removeContainer: async (id) => {
      if (failOn.includes(id)) throw new Error("container is running");
      removed.containers.push(id);
    },
  };
}

test("removeUnusedImages removes exactly what was listed and reports real bytes freed", async () => {
  const doc = df();
  doc.Images[1].RepoTags = ["app:v1", "app:previous"]; // multi-tagged: remove per tag
  const docker = fakeDocker({ document: doc });

  const result = await removeUnusedImages(docker, { keep: ["keepme:*"] });
  assert.deepEqual(docker.removed.images, ["app:v1", "app:previous", "sha256:ccc"]);
  assert.ok(!docker.removed.images.some((r) => r.startsWith("keepme")), "the keep list is honoured");
  assert.ok(!docker.removed.images.includes("app:v2"), "an image with a container is never removed");
  assert.equal(result.removed, 2);
  assert.equal(result.bytes, 3000, "freed bytes come from the layer total, not the sum of image sizes");
});

test("removeUnusedImages skips images the engine refuses and keeps going", async () => {
  const docker = fakeDocker({ failOn: ["app:v1"] });
  const result = await removeUnusedImages(docker);
  assert.equal(result.removed, 2);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].name, "app:v1");
  assert.match(result.skipped[0].reason, /in use/);
});

test("removeStaleContainers removes only the aged-out, unsupervised ones", async () => {
  const now = Date.parse("2026-07-27T00:00:00Z");
  const docker = fakeDocker();
  const result = await removeStaleContainers(docker, { olderThanMs: 24 * HOUR, now });
  // c1 is running, c3 inspects as unless-stopped; only c2 qualifies.
  assert.deepEqual(docker.removed.containers, ["c2"]);
  assert.equal(result.removed, 1);
  assert.equal(result.bytes, 200);
});

test("backupUsage counts artifacts and what retention would drop", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "st-storage-"));
  try {
    const store = new Store(dir);
    store.ensureDirs();
    const target = { name: "app-db", type: "postgres", retention: { daily: 2, weekly: 0, monthly: 0 } };
    const backupDir = store.backupDir("app-db");
    for (const stamp of ["20260720-030000", "20260721-030000", "20260722-030000", "20260723-030000"]) {
      fs.writeFileSync(path.join(backupDir, `app-db-${stamp}.sql.gz.enc`), Buffer.alloc(1000));
    }
    fs.writeFileSync(path.join(backupDir, "notes.json"), "{}");

    const [row] = await backupUsage({ backups: [target] }, store);
    assert.equal(row.name, "app-db");
    assert.equal(row.artifactCount, 4);
    assert.equal(row.fileCount, 5);
    assert.equal(row.totalBytes, 4002);
    assert.equal(row.prunableCount, 2, "keeps the newest 2 dailies");
    assert.equal(row.prunableBytes, 2000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("report composes a full picture and degrades when Docker is unreachable", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "st-report-"));
  try {
    const store = new Store(dir);
    store.ensureDirs();
    const config = { checks: [{ name: "disk", type: "disk", path: dir }], backups: [], housekeeping: { keepImages: ["keepme:*"] } };

    invalidate();
    const good = await report({ docker: fakeDocker(), store, config });
    assert.equal(good.dockerAvailable, true);
    assert.equal(good.diskPath, dir);
    assert.ok(good.disk.totalBytes > 0);
    assert.ok(good.breakdown.some((b) => b.key === "volumes" && b.bytes === 7000));
    assert.ok(good.breakdown.some((b) => b.key === "other"), "unaccounted usage is shown, not hidden");
    assert.ok(good.plan.length > 0);
    assert.equal(good.reclaimableBytes, good.plan.reduce((s, a) => s + a.bytes, 0));
    assert.ok(!good.unusedImages.some((i) => i.tags.includes("keepme:stable")));

    invalidate();
    const blind = await report({
      docker: { systemDf: async () => { throw new Error("no socket"); } },
      store,
      config,
    });
    assert.equal(blind.dockerAvailable, false);
    assert.equal(blind.summary, null);
    assert.deepEqual(blind.projects, []);
    assert.deepEqual(blind.plan, []);
  } finally {
    invalidate();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
