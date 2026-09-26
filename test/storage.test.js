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
  peek,
  refresh,
  latest,
  planTotals,
  repositoryOf,
  rollbackKeepers,
  effectiveKeepVersions,
  classifyUnusedImages,
  imageReclaimEstimate,
  referencedImageIds,
  reclaimDanglingImages,
} from "../src/storage.js";
import { diskFromStatfs } from "../src/metrics.js";
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
      { Id: "sha256:aaa", RepoTags: ["app:v2"], Size: 4000, VirtualSize: 4000, SharedSize: 1000, Containers: 3, Created: 1_700_000_000 },
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
        Image: "app:v2",
        ImageID: "sha256:aaa",
        State: "exited",
        Status: "Exited (0) 5 days ago",
        SizeRw: 200,
        Created: 1_600_000_000,
        Labels: { "com.docker.compose.project": "web", "com.docker.compose.service": "migrate" },
      },
      { Id: "c3", Names: ["/scratch"], Image: "app:v2", ImageID: "sha256:aaa", State: "exited", Status: "Exited (1) 2 days ago", SizeRw: 50, Created: 1_600_000_000, Labels: {} },
    ],
    Volumes: [
      { Name: "web_db", UsageData: { Size: 5000, RefCount: 1 }, Labels: { "com.docker.compose.project": "web" } },
      { Name: "orphan_data", UsageData: { Size: 2000, RefCount: 0 }, Labels: {} },
    ],
    BuildCache: [
      { ID: "bc1", Size: 700, InUse: false, Shared: false },
      { ID: "bc2", Size: 200, InUse: true, Shared: false },
      { ID: "bc3", Size: 100, InUse: false, Shared: true },
    ],
  };
}

test("summarizeDf follows Docker's accounting and never counts volumes as reclaimable", () => {
  const s = summarizeDf(df());

  assert.equal(s.images.totalBytes, 10_000);
  assert.equal(s.images.count, 4);
  assert.equal(s.images.unusedCount, 3);
  // The bytes only unused images hold: 2500 + 1500 + 1000. Docker 29 reports
  // the same figure, and the older formula (7000 here) counted the layers
  // "app:v2" shares with them as reclaimable although it still needs them.
  assert.equal(s.images.reclaimableBytes, 5000);
  assert.equal(s.images.danglingBytes, 1500);

  assert.equal(s.containers.totalBytes, 350);
  assert.equal(s.containers.stoppedCount, 2);
  assert.equal(s.containers.reclaimableBytes, 250);

  assert.equal(s.volumes.totalBytes, 7000);
  assert.equal(s.volumes.unusedCount, 1);
  assert.equal(s.volumes.unusedBytes, 2000);

  // Shared cache is still bytes on disk and is still reclaimable when idle;
  // only records the builder is actively using are held back.
  assert.equal(s.buildCache.totalBytes, 1000);
  assert.equal(s.buildCache.reclaimableBytes, 800);
  assert.equal(summarizeDf({ BuildCache: [{ Size: 500, InUse: false, Shared: true }] }).buildCache.reclaimableBytes, 500);

  // Images + stopped writable layers + build cache. Volume bytes excluded.
  assert.equal(s.reclaimableBytes, 6050);
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
  const all = unusedImages(df(), { keepVersions: 0 });
  assert.deepEqual(all.map((i) => i.name), ["app:v1", "ccc (untagged)", "keepme:stable"]);
  assert.equal(all[0].sizeBytes, 3500, "sorted biggest first");
  assert.equal(all[1].dangling, true);

  const kept = unusedImages(df(), { keep: ["keepme:*"], keepVersions: 0 });
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
    unusedImages: unusedImages(df(), { keepVersions: 0 }),
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

  const result = await removeUnusedImages(docker, { keep: ["keepme:*"], keepVersions: 0 });
  assert.deepEqual(docker.removed.images, ["app:v1", "app:previous", "sha256:ccc"]);
  assert.ok(!docker.removed.images.some((r) => r.startsWith("keepme")), "the keep list is honoured");
  assert.ok(!docker.removed.images.includes("app:v2"), "an image with a container is never removed");
  assert.equal(result.removed, 2);
  assert.equal(result.bytes, 3000, "freed bytes come from the layer total, not the sum of image sizes");
});

test("removeUnusedImages skips images the engine refuses and keeps going", async () => {
  const docker = fakeDocker({ failOn: ["app:v1"] });
  const result = await removeUnusedImages(docker, { keepVersions: 0 });
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

test("an external target gets no storage row and no directory", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "st-ext-"));
  try {
    const store = new Store(dir);
    store.ensureDirs();
    const config = {
      backups: [
        { name: "db", type: "postgres" },
        { name: "media", type: "external", note: "somewhere else" },
      ],
    };
    const rows = await backupUsage(config, store);
    assert.deepEqual(rows.map((r) => r.name), ["db"]);
    // Asking for its directory would create one for a target that will never
    // hold an artifact, and then report it as a row of zeroes.
    assert.equal(fs.existsSync(path.join(dir, "backups", "media")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------
 * Issue: reclaimable space summed from full image sizes
 *
 * Versions of one application share their base layers. Each image's Size
 * includes that base, so adding sizes counts it once per version. On a box
 * with hundreds of versions the old figure claimed several times the disk.
 * ---------------------------------------------------------------------- */

/** Ten versions of one app on a shared 900-byte base, newest running. */
function manyVersions() {
  const images = [];
  for (let v = 1; v <= 10; v++) {
    images.push({
      Id: `sha256:v${v}`,
      RepoTags: [`app:v${v}`],
      Size: 1000,
      SharedSize: 900,
      Containers: v === 10 ? 1 : 0,
      Created: 1_700_000_000 + v,
    });
  }
  return { LayersSize: 900 + 10 * 100, Images: images, Containers: [], Volumes: [], BuildCache: [] };
}

test("removing old versions frees their own layers, not the base the running one still needs", () => {
  const doc = manyVersions();
  const unused = unusedImages(doc, { keepVersions: 0 });
  assert.equal(unused.length, 9);
  const summed = unused.reduce((sum, i) => sum + i.sizeBytes, 0);
  assert.equal(summed, 9000, "the old way: more than every layer on the box");

  const e = imageReclaimEstimate(doc, unused.map((i) => i.id));
  // Each old version owns 100 bytes; the shared base stays for v10.
  assert.deepEqual(e, { minBytes: 900, maxBytes: 900 });
  assert.ok(e.maxBytes <= doc.LayersSize);

  // The summary agrees with what Docker 29 computes for the same document.
  assert.equal(summarizeDf(doc).images.reclaimableBytes, 900);
});

test("the Engine's own reclaimable figure is used when it sends one", () => {
  // Docker 29 (API 1.52+) adds ImageUsage.Reclaimable; `docker system df`
  // prints it, so the report prints the same number.
  const doc = { ...manyVersions(), ImageUsage: { Reclaimable: 850, TotalSize: 1900 } };
  assert.equal(summarizeDf(doc).images.reclaimableBytes, 850);
  // A figure larger than every layer on the box is clamped, whoever sent it.
  assert.equal(summarizeDf({ ...doc, ImageUsage: { Reclaimable: 1e12 } }).images.reclaimableBytes, 1900);
});

test("a base shared only by removed images counts towards the upper figure", () => {
  const doc = {
    LayersSize: 1700,
    Images: [
      { Id: "sha256:run", RepoTags: ["new:v1"], Size: 500, SharedSize: 0, Containers: 1, Created: 3 },
      { Id: "sha256:a", RepoTags: ["old:a"], Size: 1000, SharedSize: 800, Containers: 0, Created: 1 },
      { Id: "sha256:b", RepoTags: ["old:b"], Size: 1000, SharedSize: 800, Containers: 0, Created: 2 },
    ],
  };
  // The 800-byte base belongs to a and b alone, so removing both frees it.
  assert.deepEqual(imageReclaimEstimate(doc, ["sha256:a", "sha256:b"]), { minBytes: 400, maxBytes: 1200 });
  // Removing only one cannot free it: b still needs the whole base.
  assert.deepEqual(imageReclaimEstimate(doc, ["sha256:a"]), { minBytes: 200, maxBytes: 200 });
});

test("an unknown SharedSize is treated as all shared, so the floor never overstates", () => {
  const doc = {
    LayersSize: 1500,
    Images: [
      { Id: "sha256:x", RepoTags: ["x:1"], Size: 1000, SharedSize: -1, Containers: 0 },
      { Id: "sha256:y", RepoTags: ["y:1"], Size: 500, SharedSize: -1, Containers: 1 },
    ],
  };
  const e = imageReclaimEstimate(doc, ["sha256:x"]);
  assert.equal(e.minBytes, 0);
  assert.ok(e.maxBytes <= 1000);
});

test("the plan reports an image range and the total counts nothing twice", () => {
  const doc = manyVersions();
  doc.Images.push({ Id: "sha256:junk", RepoTags: ["<none>:<none>"], Size: 50, SharedSize: 0, Containers: 0, Created: 1 });
  doc.LayersSize += 50;
  const unused = unusedImages(doc, { keepVersions: 0 });
  const r = {
    summary: summarizeDf(doc),
    unusedImages: unused,
    keptImages: [],
    keepImageVersions: 0,
    imageEstimates: {
      dangling: imageReclaimEstimate(doc, unused.filter((i) => i.dangling).map((i) => i.id)),
      unused: imageReclaimEstimate(doc, unused.map((i) => i.id)),
    },
    staleContainers: [],
    backups: [],
    toolkit: { historyBytes: 0, tmpBytes: 0, historyFiles: 0, tmpFiles: 0 },
  };
  const plan = buildPlan(r);
  const all = plan.find((a) => a.id === "remove-unused-images");
  const junk = plan.find((a) => a.id === "reclaim-dangling-images");
  assert.equal(all.bytes, 950);
  assert.equal(all.minBytes, 950);
  assert.equal(junk.bytes, 50);
  assert.equal(junk.subsetOf, "remove-unused-images");
  assert.deepEqual(junk.items, ["junk (untagged)"]);
  // 950 once, not 950 + 50: the untagged image is inside the larger action.
  assert.deepEqual(planTotals(plan), { all: 950, safe: 50 });
});

/* -------------------------------------------------------------------------
 * Issue: "used" included blocks the filesystem reserves for root
 * ---------------------------------------------------------------------- */

test("disk usage is on the same basis as df, with reserved blocks reported apart", () => {
  // 473 GB disk in 4 KiB blocks, 81 GB used, 5% reserved.
  const bsize = 4096;
  const blocks = Math.round(473e9 / bsize);
  const usedBlocks = Math.round(81e9 / bsize);
  const reservedBlocks = Math.round(blocks * 0.05);
  const bfree = blocks - usedBlocks;
  const d = diskFromStatfs({ bsize, blocks, bfree, bavail: bfree - reservedBlocks }, "/");
  assert.equal(d.usedBytes, usedBlocks * bsize);
  assert.equal(d.reservedBytes, reservedBlocks * bsize);
  assert.equal(d.freeBytes, (bfree - reservedBlocks) * bsize);
  // df: used / (used + available) = 81 / (81 + 368.35) = 18.0%. The old
  // formula, (total - available) / total, said 22.1%.
  assert.equal(d.usedPct, 18);
  assert.equal(diskFromStatfs({ bsize: 1, blocks: 0, bfree: 0, bavail: 0 }, "/").usedPct, 0);
});

test("the report gives reserved space its own line instead of padding Everything else", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "st-reserved-"));
  try {
    const store = new Store(dir);
    store.ensureDirs();
    const config = { checks: [{ name: "disk", type: "disk", path: dir }], backups: [] };
    invalidate();
    const r = await report({ docker: fakeDocker(), store, config });
    const reserved = r.breakdown.find((b) => b.key === "reserved");
    if (r.disk.reservedBytes > 0) assert.equal(reserved.bytes, r.disk.reservedBytes);
    else assert.equal(reserved, undefined, "no line when nothing is reserved (tmpfs, most containers)");
    const other = r.breakdown.find((b) => b.key === "other");
    assert.equal(other.bytes, Math.max(r.disk.usedBytes - r.accountedBytes, 0), "used excludes the reservation");
  } finally {
    invalidate();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------
 * Issue: the page blocked on /system/df for 90+ seconds
 * ---------------------------------------------------------------------- */

test("a page read never waits for the measurement, and shows its age once it has one", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "st-peek-"));
  try {
    const store = new Store(dir);
    store.ensureDirs();
    const config = { checks: [], backups: [] };
    let calls = 0;
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const slow = { ...fakeDocker(), systemDf: async () => { calls += 1; await gate; return df(); } };
    const ctx = { docker: slow, store, config };

    invalidate();
    // Clear any report left by an earlier test so this starts from boot.
    await refresh({ docker: { systemDf: async () => { throw new Error("x"); } }, store, config });
    const first = peek(ctx, { staleAfterMs: 0 });
    assert.equal(first.refreshing, true, "a measurement starts in the background");
    assert.equal(first.report?.dockerAvailable, false, "and the page gets the last report meanwhile");

    // A second view and the scheduled refresh join the same measurement.
    peek(ctx, { staleAfterMs: 0 });
    const joined = refresh(ctx);
    release();
    const r = await joined;
    assert.equal(calls, 1, "/system/df ran once, not once per caller");
    assert.equal(r.dockerAvailable, true);

    const now = Date.parse(r.generatedAt) + 4 * 60_000;
    const view = peek(ctx, { now });
    assert.equal(view.report, r);
    assert.equal(view.ageMs, 4 * 60_000);
    assert.equal(view.refreshing, false, "4 minutes old is fresh enough, nothing new starts");
    assert.equal(latest(), r);
  } finally {
    invalidate();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("after a change the old figures stay readable, marked stale, and a new measurement starts", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "st-stale-"));
  try {
    const store = new Store(dir);
    store.ensureDirs();
    const ctx = { docker: fakeDocker(), store, config: { checks: [], backups: [] } };
    invalidate();
    const before = await report(ctx);
    invalidate();
    const view = peek(ctx);
    assert.equal(view.report, before, "the page does not go blank after an action");
    assert.equal(view.stale, true);
    assert.equal(view.refreshing, true);
    const after = await refresh(ctx);
    assert.notEqual(after, before);
    assert.equal(peek(ctx).stale, false);
  } finally {
    invalidate();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------
 * Issue: remove-unused-images deleted rollback images
 * ---------------------------------------------------------------------- */

test("repositoryOf strips the tag or digest and leaves a registry port alone", () => {
  assert.equal(repositoryOf("app:v1"), "app");
  assert.equal(repositoryOf("ghcr.io/o/app:v1"), "ghcr.io/o/app");
  assert.equal(repositoryOf("registry.example.com:5000/o/app:v1"), "registry.example.com:5000/o/app");
  assert.equal(repositoryOf("registry.example.com:5000/o/app"), "registry.example.com:5000/o/app");
  assert.equal(repositoryOf("o/app@sha256:abc"), "o/app");
});

test("the keep count: default 3, 0 turns it off, 1 is raised to 2", () => {
  assert.equal(effectiveKeepVersions(undefined), 3);
  assert.equal(effectiveKeepVersions(0), 0);
  assert.equal(effectiveKeepVersions(1), 2);
  assert.equal(effectiveKeepVersions(5), 5);
});

test("the newest versions per repository are kept, counting the running one and each image once", () => {
  const doc = manyVersions();
  // v9 also carries a second tag; it must count once, not twice.
  doc.Images[8].RepoTags.push("app:previous");
  const kept = rollbackKeepers(doc, 3);
  assert.deepEqual([...kept.keys()].sort(), ["sha256:v10", "sha256:v8", "sha256:v9"]);

  const { candidates, kept: held } = classifyUnusedImages(doc, { keepVersions: 3 });
  // v10 is running, so of the kept three only v9 and v8 appear as held back.
  assert.deepEqual(held.map((i) => i.id).sort(), ["sha256:v8", "sha256:v9"]);
  assert.equal(held[0].keptFor, "app");
  assert.equal(candidates.length, 7);
  assert.ok(!candidates.some((i) => i.id === "sha256:v10"));

  // Asking for 1 keeps 2, so the previous release always survives.
  assert.deepEqual([...rollbackKeepers(doc, 1).keys()].sort(), ["sha256:v10", "sha256:v9"]);
  assert.equal(rollbackKeepers(doc, 0).size, 0);
});

test("an image a stopped container uses is never a candidate, whatever the image count says", () => {
  const doc = manyVersions();
  // The Engine's per-image count says nobody uses v2, but a stopped container
  // does. Docker would untag it if it had a second tag, so this is the guard.
  doc.Images[1].RepoTags.push("app:second-tag");
  doc.Containers = [{ Id: "old", ImageID: "sha256:v2", State: "exited" }];
  assert.ok(referencedImageIds(doc).has("sha256:v2"));
  const ids = unusedImages(doc, { keepVersions: 0 }).map((i) => i.id);
  assert.ok(!ids.includes("sha256:v2"));
  assert.equal(summarizeDf(doc).images.unusedCount, 8);
});

test("an image pulled by digest is a release, not build debris", () => {
  const doc = {
    LayersSize: 3000,
    Images: [
      { Id: "sha256:cur", RepoTags: [], RepoDigests: ["ghcr.io/o/app@sha256:c"], Size: 1000, SharedSize: 0, Containers: 1, Created: 3 },
      { Id: "sha256:prev", RepoTags: [], RepoDigests: ["ghcr.io/o/app@sha256:p"], Size: 1000, SharedSize: 0, Containers: 0, Created: 2 },
      { Id: "sha256:junk", RepoTags: ["<none>:<none>"], RepoDigests: [], Size: 1000, SharedSize: 0, Containers: 0, Created: 1 },
    ],
    Containers: [],
  };
  const { candidates, kept } = classifyUnusedImages(doc, { keepVersions: 3 });
  assert.deepEqual(candidates.map((i) => i.id), ["sha256:junk"]);
  assert.deepEqual(kept.map((i) => i.id), ["sha256:prev"]);
  assert.equal(kept[0].dangling, false);
  assert.match(kept[0].name, /^ghcr\.io\/o\/app@/);
  // With keeping off it is still named, not lumped in with the debris.
  const off = classifyUnusedImages(doc, { keepVersions: 0 }).candidates;
  assert.equal(off.find((i) => i.id === "sha256:prev").dangling, false);
});

test("reclaimDanglingImages removes the listed debris by id and leaves digest-pinned images", async () => {
  let layers = 3000;
  const removed = [];
  const docker = {
    systemDf: async () => ({
      LayersSize: layers,
      Images: [
        { Id: "sha256:prev", RepoTags: [], RepoDigests: ["o/app@sha256:p"], Size: 1000, SharedSize: 0, Containers: 0, Created: 2 },
        { Id: "sha256:junk", RepoTags: ["<none>:<none>"], Size: 1000, SharedSize: 0, Containers: 0, Created: 1 },
      ],
      Containers: [],
    }),
    removeImage: async (ref) => {
      removed.push(ref);
      layers -= 1000;
    },
    pruneImages: async () => assert.fail("the Engine's prune would take the digest-pinned image too"),
  };
  const result = await reclaimDanglingImages(docker, { keepVersions: 0 });
  assert.deepEqual(removed, ["sha256:junk"]);
  assert.equal(result.removed, 1);
  assert.equal(result.bytes, 1000);
});

test("removeUnusedImages keeps the newest versions by default", async () => {
  let layers = 1900;
  const removed = [];
  const docker = {
    systemDf: async () => ({ ...manyVersions(), LayersSize: layers }),
    removeImage: async (ref) => {
      removed.push(ref);
      layers -= 100;
    },
  };
  const result = await removeUnusedImages(docker);
  assert.equal(result.removed, 7);
  for (const keep of ["app:v10", "app:v9", "app:v8"]) assert.ok(!removed.includes(keep), `${keep} survives`);
  assert.equal(result.bytes, 700);
});
