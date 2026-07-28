/**
 * Disk usage analysis and safe reclamation for a box running containers.
 *
 * The question this answers is the one an operator actually has when a disk
 * alert fires: what is using the space, how much of it is genuinely garbage,
 * and what can I remove right now without taking a production service down?
 *
 * Safety model (deliberate, and enforced in code rather than only in the UI):
 *
 * - Volumes are never deleted. A dangling volume is usually somebody's
 *   database. They are reported, named, and sized so a human can decide, and
 *   there is no action id anywhere in this toolkit that removes one.
 * - Running containers are never touched. Image removal goes through Docker,
 *   which refuses to remove anything a container references; container removal
 *   is restricted to containers that already exited.
 * - Stopped containers are only offered for removal when they are one-off or
 *   stopped-on-purpose work (restart policy "no" or "on-failure") and have been
 *   exited longer than the configured grace period. A container belonging to a
 *   service that is supposed to be running is left alone, because removing it
 *   also destroys the logs that explain why it died.
 * - Removal never passes the "also delete volumes" flag to the Engine API.
 * - Every candidate list is computed and shown before anything runs, so what
 *   the operator approves is exactly what happens.
 *
 * Everything that decides *what* to remove is a pure function over the Docker
 * Engine's own disk-usage document, so the rules are unit tested without a
 * daemon. The functions that actually remove things are thin wrappers that
 * take the output of those decisions.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import * as metrics from "./metrics.js";
import { planRetention, dateFromArtifactName } from "./backup/retention.js";
import { parseDuration, formatBytes } from "./util.js";
import { logger } from "./log.js";

const log = logger("storage");

/** How long a container must have been stopped before it counts as leftover. */
export const DEFAULT_STALE_CONTAINER_AGE = "24h";

/** Restart policies that mark a container as "meant to be running". */
const SUPERVISED_POLICIES = new Set(["always", "unless-stopped"]);

const COMPOSE_PROJECT = "com.docker.compose.project";
const COMPOSE_SERVICE = "com.docker.compose.service";
const NO_PROJECT = "(not part of a compose project)";

// ---------------------------------------------------------------------------
// Pure analysis over the Engine's /system/df document
// ---------------------------------------------------------------------------

/** Bytes an image occupies including the layers it inherits. */
function imageBytes(image) {
  const virtual = Number(image?.VirtualSize);
  if (Number.isFinite(virtual) && virtual > 0) return virtual;
  const size = Number(image?.Size);
  return Number.isFinite(size) && size > 0 ? size : 0;
}

function sharedBytes(image) {
  const shared = Number(image?.SharedSize);
  return Number.isFinite(shared) && shared > 0 ? shared : 0;
}

function tagsOf(image) {
  return (image?.RepoTags ?? []).filter((t) => t && t !== "<none>:<none>");
}

function containerName(entry) {
  const name = entry?.Names?.[0] ?? entry?.Name ?? entry?.Id ?? "";
  return String(name).replace(/^\//, "");
}

/**
 * Roll the Engine's disk-usage document into totals per category.
 *
 * Reclaimable follows Docker's own accounting: image bytes that no container
 * references, writable layers of stopped containers, and build cache that is
 * not in use. Volume bytes are reported separately and are never counted as
 * reclaimable, because this toolkit does not delete volumes.
 */
export function summarizeDf(df = {}) {
  const images = df.Images ?? [];
  const containers = df.Containers ?? [];
  const volumes = df.Volumes ?? [];
  const cache = df.BuildCache ?? [];

  const layersSize = Number.isFinite(df.LayersSize)
    ? df.LayersSize
    : images.reduce((sum, i) => sum + imageBytes(i), 0);
  const activeImageBytes = images
    .filter((i) => (i.Containers ?? 0) > 0)
    .reduce((sum, i) => sum + Math.max(imageBytes(i) - sharedBytes(i), 0), 0);

  const containerBytes = containers.reduce((sum, c) => sum + (Number(c.SizeRw) || 0), 0);
  const stopped = containers.filter((c) => c.State !== "running");
  const stoppedBytes = stopped.reduce((sum, c) => sum + (Number(c.SizeRw) || 0), 0);

  const volumeBytes = volumes.reduce((sum, v) => sum + Math.max(Number(v.UsageData?.Size) || 0, 0), 0);
  const unusedVolumes = volumes.filter((v) => (v.UsageData?.RefCount ?? 0) === 0);
  const unusedVolumeBytes = unusedVolumes.reduce((sum, v) => sum + Math.max(Number(v.UsageData?.Size) || 0, 0), 0);

  // Each cache record is distinct on disk, shared or not, so the total is a
  // plain sum and everything not in use can go. Deriving this from the records
  // rather than the engine's BuilderSize field matches `docker buildx du` on
  // every engine version (older ones omit the field entirely).
  const cacheBytes = cache.reduce((sum, c) => sum + (Number(c.Size) || 0), 0);
  const cacheInUse = cache.filter((c) => c.InUse).reduce((sum, c) => sum + (Number(c.Size) || 0), 0);

  const summary = {
    images: {
      count: images.length,
      unusedCount: images.filter((i) => (i.Containers ?? 0) === 0).length,
      totalBytes: layersSize,
      reclaimableBytes: Math.max(layersSize - activeImageBytes, 0),
      danglingBytes: images
        .filter((i) => (i.Containers ?? 0) === 0 && tagsOf(i).length === 0)
        .reduce((sum, i) => sum + imageBytes(i), 0),
    },
    containers: {
      count: containers.length,
      stoppedCount: stopped.length,
      totalBytes: containerBytes,
      reclaimableBytes: stoppedBytes,
    },
    volumes: {
      count: volumes.length,
      unusedCount: unusedVolumes.length,
      totalBytes: volumeBytes,
      // Named separately from "reclaimable" on purpose: never auto-removed.
      unusedBytes: unusedVolumeBytes,
    },
    buildCache: {
      count: cache.length,
      totalBytes: Math.max(cacheBytes, 0),
      reclaimableBytes: Math.max(cacheBytes - cacheInUse, 0),
    },
  };

  summary.totalBytes =
    summary.images.totalBytes + summary.containers.totalBytes + summary.volumes.totalBytes + summary.buildCache.totalBytes;
  // Volumes excluded: this toolkit will not delete data for you.
  summary.reclaimableBytes =
    summary.images.reclaimableBytes + summary.containers.reclaimableBytes + summary.buildCache.reclaimableBytes;
  return summary;
}

/** Turn a shell-style tag pattern (for example "app:*") into a matcher. */
export function globMatch(pattern, value) {
  const rx = new RegExp(
    `^${String(pattern)
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")}$`,
  );
  return rx.test(String(value));
}

/**
 * Images no container references, biggest first. `keep` is a list of glob
 * patterns matched against tags; anything matching is never offered for
 * removal (so an operator can pin a known-good rollback image).
 */
export function unusedImages(df = {}, { keep = [] } = {}) {
  return (df.Images ?? [])
    .filter((i) => (i.Containers ?? 0) === 0)
    .map((i) => {
      const tags = tagsOf(i);
      return {
        id: i.Id,
        tags,
        name: tags[0] ?? `${String(i.Id).replace(/^sha256:/, "").slice(0, 12)} (untagged)`,
        dangling: tags.length === 0,
        sizeBytes: imageBytes(i),
        createdAt: i.Created ? new Date(i.Created * 1000).toISOString() : null,
      };
    })
    .filter((img) => !img.tags.some((t) => keep.some((p) => globMatch(p, t))))
    .sort((a, b) => b.sizeBytes - a.sizeBytes);
}

/**
 * Stopped containers that are safe to remove: already exited, not supervised
 * by a restart policy (so not a service that is meant to be up), and stopped
 * for longer than the grace period. Records come from collectContainers().
 */
export function selectStaleContainers(records = [], { olderThanMs = 86_400_000, now = Date.now() } = {}) {
  return records
    .filter((r) => r.state === "exited")
    .filter((r) => !SUPERVISED_POLICIES.has(r.restartPolicy))
    .filter((r) => r.finishedAt && now - Date.parse(r.finishedAt) >= olderThanMs)
    .map((r) => ({ ...r, stoppedForMs: now - Date.parse(r.finishedAt) }))
    .sort((a, b) => b.sizeBytes - a.sizeBytes);
}

/**
 * Group containers, their writable layers, their images, and their volumes by
 * compose project. Image bytes include shared base layers, so two projects
 * built on the same base each count it; the UI says so.
 */
export function projectRollup(records = [], df = {}) {
  const imagesById = new Map();
  for (const i of df.Images ?? []) {
    imagesById.set(i.Id, i);
    for (const tag of tagsOf(i)) imagesById.set(tag, i);
  }

  const byProject = new Map();
  const project = (name) => {
    if (!byProject.has(name)) {
      byProject.set(name, {
        name,
        containers: 0,
        running: 0,
        writableBytes: 0,
        volumeBytes: 0,
        imageBytes: 0,
        volumeCount: 0,
        services: new Set(),
        imageIds: new Set(),
      });
    }
    return byProject.get(name);
  };

  for (const r of records) {
    const p = project(r.project || NO_PROJECT);
    p.containers += 1;
    if (r.state === "running") p.running += 1;
    p.writableBytes += r.sizeBytes || 0;
    if (r.service) p.services.add(r.service);
    const image = imagesById.get(r.imageId) ?? imagesById.get(r.image);
    if (image && !p.imageIds.has(image.Id)) {
      p.imageIds.add(image.Id);
      p.imageBytes += imageBytes(image);
    }
  }

  for (const v of df.Volumes ?? []) {
    const name = v.Labels?.[COMPOSE_PROJECT] || NO_PROJECT;
    const p = project(name);
    p.volumeBytes += Math.max(Number(v.UsageData?.Size) || 0, 0);
    p.volumeCount += 1;
  }

  return [...byProject.values()]
    .map(({ services, imageIds, ...rest }) => ({
      ...rest,
      serviceCount: services.size,
      totalBytes: rest.writableBytes + rest.volumeBytes + rest.imageBytes,
    }))
    .sort((a, b) => b.totalBytes - a.totalBytes);
}

/** Volumes with size and whether anything references them, biggest first. */
export function volumeRows(df = {}) {
  return (df.Volumes ?? [])
    .map((v) => ({
      name: v.Name,
      project: v.Labels?.[COMPOSE_PROJECT] ?? null,
      sizeBytes: Math.max(Number(v.UsageData?.Size) || 0, 0),
      refCount: v.UsageData?.RefCount ?? 0,
      inUse: (v.UsageData?.RefCount ?? 0) > 0,
    }))
    .sort((a, b) => b.sizeBytes - a.sizeBytes);
}

/**
 * Preventive findings: things that are not using space yet but will. Today
 * that is container log files with no rotation limit, which is the classic way
 * a box fills up months after it was set up.
 */
export function logRotationFindings(records = []) {
  const unbounded = records.filter(
    (r) => r.state === "running" && r.logDriver === "json-file" && !r.logMaxSize,
  );
  if (!unbounded.length) return [];
  return [
    {
      id: "log-rotation",
      title: `${unbounded.length} running container${unbounded.length > 1 ? "s have" : " has"} no log size limit`,
      detail:
        "Container logs are written to disk and, with no limit, grow until the disk is full. Add a logging limit to each service in your compose file and recreate it: logging.options.max-size (for example \"10m\") and max-file (for example \"3\").",
      names: unbounded.map((r) => r.name).sort(),
    },
  ];
}

// ---------------------------------------------------------------------------
// Collection (I/O)
// ---------------------------------------------------------------------------

/** Run an async mapper over a list with a small concurrency cap. */
async function mapLimit(items, limit, fn) {
  const out = [];
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const i = index++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Merge the Engine's disk-usage container entries with the per-container
 * details that only inspect carries (exit time, restart policy, log config).
 * Any container that fails to inspect is kept with what we already know.
 */
export async function collectContainers(docker, df) {
  const entries = df.Containers ?? [];
  return mapLimit(entries, 6, async (entry) => {
    const base = {
      id: entry.Id,
      name: containerName(entry),
      image: entry.Image,
      imageId: entry.ImageID,
      project: entry.Labels?.[COMPOSE_PROJECT] ?? null,
      service: entry.Labels?.[COMPOSE_SERVICE] ?? null,
      state: entry.State,
      status: entry.Status,
      sizeBytes: Number(entry.SizeRw) || 0,
      createdAt: entry.Created ? new Date(entry.Created * 1000).toISOString() : null,
      finishedAt: null,
      restartPolicy: "",
      logDriver: null,
      logMaxSize: null,
      logPath: null,
    };
    try {
      const info = await docker.inspect(entry.Id);
      base.finishedAt = info.State?.FinishedAt && !info.State.FinishedAt.startsWith("0001-") ? info.State.FinishedAt : null;
      base.restartPolicy = info.HostConfig?.RestartPolicy?.Name ?? "";
      base.logDriver = info.HostConfig?.LogConfig?.Type ?? null;
      base.logMaxSize = info.HostConfig?.LogConfig?.Config?.["max-size"] ?? null;
      base.logPath = info.LogPath ?? null;
    } catch {
      // Container vanished between listing and inspect, or the daemon is busy.
    }
    return base;
  });
}

/** Sum a directory tree, following no symlinks. Returns { bytes, files }. */
async function dirSize(dir) {
  let bytes = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    const entries = await fsp.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        const st = await fsp.stat(full).catch(() => null);
        if (st) {
          bytes += st.size;
          files += 1;
        }
      }
    }
  }
  return { bytes, files };
}

/**
 * Local backup artifacts per target, with how much the configured retention
 * policy would drop if it ran right now. Pruning to policy is exactly what the
 * scheduler already does, so this number is safe to act on.
 */
export async function backupUsage(config, store) {
  const rows = [];
  for (const target of config.backups ?? []) {
    const dir = store.backupDir(target.name);
    const names = await fsp.readdir(dir).catch(() => []);
    const files = [];
    let totalBytes = 0;
    for (const name of names) {
      const st = await fsp.stat(path.join(dir, name)).catch(() => null);
      if (!st?.isFile()) continue;
      totalBytes += st.size;
      files.push({ key: name, size: st.size, date: dateFromArtifactName(name) });
    }
    const artifacts = files.filter((f) => f.date && !f.key.endsWith(".json"));
    const plan = planRetention(artifacts, target.retention);
    const dropped = artifacts.filter((f) => plan.drop.includes(f.key));
    rows.push({
      name: target.name,
      fileCount: files.length,
      artifactCount: artifacts.length,
      totalBytes,
      prunableCount: dropped.length,
      prunableBytes: dropped.reduce((sum, f) => sum + f.size, 0),
      retention: target.retention ?? { daily: 7, weekly: 4, monthly: 6 },
    });
  }
  return rows.sort((a, b) => b.totalBytes - a.totalBytes);
}

/** Space used by the toolkit's own history and temp files. */
export async function toolkitUsage(store) {
  const history = await dirSize(path.join(store.dataDir, "history"));
  const tmp = await dirSize(store.tmpDir());
  return { historyBytes: history.bytes, historyFiles: history.files, tmpBytes: tmp.bytes, tmpFiles: tmp.files };
}

/**
 * Container log file sizes, when the daemon's log files happen to be readable
 * from here. Inspect reports the host path, so we also try it under the
 * read-only host mount the deployment uses for disk checks. Without either,
 * the rotation finding still stands, just not the current sizes.
 */
export async function logUsage(records = [], { prefixes = ["", "/host"] } = {}) {
  const rows = [];
  for (const r of records) {
    if (!r.logPath) continue;
    for (const prefix of prefixes) {
      const st = await fsp.stat(`${prefix}${r.logPath}`).catch(() => null);
      if (st) {
        rows.push({ name: r.name, sizeBytes: st.size });
        break;
      }
    }
  }
  // No readable log files at all means the daemon's directory is not visible
  // from here, which is the normal case; the panel is simply omitted.
  if (!rows.length) return { available: false, totalBytes: 0, top: [] };
  rows.sort((a, b) => b.sizeBytes - a.sizeBytes);
  return { available: true, totalBytes: rows.reduce((s, r) => s + r.sizeBytes, 0), top: rows.slice(0, 8) };
}

/** The disk the report is about: the configured "/" check, else the first. */
function primaryDiskPath(config) {
  const paths = (config.checks ?? []).filter((c) => c.type === "disk").map((c) => c.path);
  return paths.find((p) => p === "/") ?? paths[0] ?? "/";
}

function staleAgeMs(config) {
  return parseDuration(config.housekeeping?.staleContainerAge ?? DEFAULT_STALE_CONTAINER_AGE) ?? 86_400_000;
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

let cache = { at: 0, report: null };

/** Drop the cached report so the next read reflects a change we just made. */
export function invalidate() {
  cache = { at: 0, report: null };
}

/**
 * The whole storage picture: filesystem, category breakdown, per-project
 * rollup, removal candidates, and the cleanup plan. Cached briefly because
 * /system/df walks the graph driver and is not free.
 */
export async function report({ docker, store, config }, { maxAgeMs = 20_000, now = Date.now() } = {}) {
  if (cache.report && now - cache.at < maxAgeMs) return cache.report;

  const diskPath = primaryDiskPath(config);
  let disk = null;
  try {
    disk = await metrics.disk(diskPath);
  } catch {
    // Path not visible from here; the rest of the report still works.
  }

  let df = null;
  try {
    df = await docker.systemDf();
  } catch (e) {
    log.warn(`disk usage unavailable: ${e.message}`);
  }

  const keep = config.housekeeping?.keepImages ?? [];
  const summary = df ? summarizeDf(df) : null;
  const records = df ? await collectContainers(docker, df) : [];
  const stale = selectStaleContainers(records, { olderThanMs: staleAgeMs(config), now });
  const images = df ? unusedImages(df, { keep }) : [];
  const backups = await backupUsage(config, store);
  const toolkit = await toolkitUsage(store);
  const logs = await logUsage(records);

  const backupBytes = backups.reduce((s, b) => s + b.totalBytes, 0);
  const toolkitBytes = toolkit.historyBytes + toolkit.tmpBytes;

  const breakdown = [
    {
      key: "images",
      label: "Container images",
      bytes: summary?.images.totalBytes ?? 0,
      note: "Every image layer stored on the box, including old versions nothing runs any more.",
    },
    {
      key: "writable",
      label: "Container writable layers",
      bytes: summary?.containers.totalBytes ?? 0,
      note: "Files written inside containers that are not on a volume. Usually small, and lost on recreate anyway.",
    },
    {
      key: "volumes",
      label: "Volumes (your data)",
      bytes: summary?.volumes.totalBytes ?? 0,
      note: "Databases, uploads, anything a container was told to keep. Never removed by this toolkit.",
    },
    {
      key: "cache",
      label: "Build cache",
      bytes: summary?.buildCache.totalBytes ?? 0,
      note: "Intermediate layers kept to make the next image build faster. Safe to clear; builds just take longer once.",
    },
    {
      key: "backups",
      label: "Backups on this box",
      bytes: backupBytes,
      note: "Encrypted backup artifacts this toolkit wrote, kept to your retention policy.",
    },
    {
      key: "toolkit",
      label: "This toolkit's history",
      bytes: toolkitBytes,
      note: "Check history and temp files. Tiny, and pruned automatically.",
    },
  ];
  const accounted = breakdown.reduce((s, b) => s + b.bytes, 0);
  if (disk) {
    breakdown.push({
      key: "other",
      label: "Everything else",
      bytes: Math.max(disk.usedBytes - accounted, 0),
      note: "The operating system, your application files, system logs, and anything else on this filesystem.",
    });
  }

  const built = {
    generatedAt: new Date(now).toISOString(),
    diskPath,
    disk,
    dockerAvailable: Boolean(df),
    summary,
    breakdown,
    accountedBytes: accounted,
    projects: df ? projectRollup(records, df) : [],
    unusedImages: images,
    staleContainers: stale,
    volumes: df ? volumeRows(df) : [],
    backups,
    toolkit,
    logs,
    findings: logRotationFindings(records),
    staleAgeMs: staleAgeMs(config),
    keepImages: keep,
  };
  built.plan = buildPlan(built);
  built.reclaimableBytes = built.plan.reduce((s, a) => s + a.bytes, 0);

  cache = { at: now, report: built };
  return built;
}

/**
 * The cleanup options worth offering right now, biggest first. Each carries
 * the words the UI and the CLI both use: what it does, and what the risk is.
 * An option only appears when it would actually free something.
 */
export function buildPlan(r) {
  const plan = [];
  const s = r.summary;

  if (s?.buildCache.reclaimableBytes > 0) {
    plan.push({
      id: "reclaim-build-cache",
      label: "Clear unused build cache",
      kind: "safe",
      bytes: s.buildCache.reclaimableBytes,
      count: s.buildCache.count,
      what: "Removes intermediate build layers that no image needs any more.",
      risk: "No risk to anything running. Your next image build takes longer because it starts from scratch.",
    });
  }

  const dangling = r.unusedImages.filter((i) => i.dangling);
  if (dangling.length) {
    plan.push({
      id: "reclaim-dangling-images",
      label: "Remove untagged leftover images",
      kind: "safe",
      bytes: dangling.reduce((sum, i) => sum + i.sizeBytes, 0),
      count: dangling.length,
      what: "Removes images with no name and no container using them, the debris every rebuild leaves behind.",
      risk: "No risk. Nothing can start from an image with no name.",
    });
  }

  const tagged = r.unusedImages.filter((i) => !i.dangling);
  if (tagged.length) {
    plan.push({
      id: "remove-unused-images",
      label: "Remove all images with no container",
      kind: "caution",
      bytes: r.unusedImages.reduce((sum, i) => sum + i.sizeBytes, 0),
      count: r.unusedImages.length,
      what: `Removes every image no container is using, including ${tagged.length} named one${tagged.length > 1 ? "s" : ""} listed below.`,
      risk:
        "Running services are untouched. The cost is time: if you roll back to one of these versions, it has to be rebuilt or pulled again first.",
    });
  }

  if (r.staleContainers.length) {
    plan.push({
      id: "remove-stopped-containers",
      label: "Remove old stopped containers",
      kind: "caution",
      bytes: r.staleContainers.reduce((sum, c) => sum + c.sizeBytes, 0),
      count: r.staleContainers.length,
      what: "Removes finished one-off containers listed below, along with their logs.",
      risk:
        "Services that are meant to be running are never included, and no volume is ever removed. You do lose the logs of the containers that go.",
    });
  }

  for (const b of r.backups) {
    if (!b.prunableCount) continue;
    plan.push({
      id: "prune-backups",
      target: b.name,
      label: `Apply retention to "${b.name}" backups`,
      kind: "safe",
      bytes: b.prunableBytes,
      count: b.prunableCount,
      what: `Deletes ${b.prunableCount} backup artifact${b.prunableCount > 1 ? "s" : ""} that are already older than your retention policy (${b.retention.daily} daily, ${b.retention.weekly} weekly, ${b.retention.monthly} monthly).`,
      risk: "Removes only copies the schedule was going to remove anyway. Your most recent backups are kept.",
    });
  }

  if (r.toolkit.historyBytes + r.toolkit.tmpBytes > 5_000_000) {
    plan.push({
      id: "trim-history",
      label: "Trim this toolkit's own history",
      kind: "safe",
      bytes: r.toolkit.historyBytes + r.toolkit.tmpBytes,
      count: r.toolkit.historyFiles + r.toolkit.tmpFiles,
      what: "Prunes old check history and expired temp files, using the housekeeping settings in your config.",
      risk: "No risk. Only this toolkit's own records are affected, and only the ones past their keep window.",
    });
  }

  return plan.sort((a, b) => b.bytes - a.bytes);
}

// ---------------------------------------------------------------------------
// Reclamation (the only code here that removes anything)
// ---------------------------------------------------------------------------

/** Clear build cache that is not in use. Returns { bytes }. */
export async function reclaimBuildCache(docker) {
  const bytes = await docker.pruneBuildCache();
  invalidate();
  return { bytes: bytes ?? 0 };
}

/** Remove untagged images no container references. Returns { bytes }. */
export async function reclaimDanglingImages(docker) {
  const bytes = await docker.pruneImages();
  invalidate();
  return { bytes: bytes ?? 0 };
}

/**
 * Remove exactly the images the report listed as unused, honouring the keep
 * list. Deleting by explicit reference rather than a blanket prune keeps what
 * happens identical to what the operator was shown. Images that turn out to be
 * in use are skipped, not forced.
 */
export async function removeUnusedImages(docker, { keep = [] } = {}) {
  const before = await docker.systemDf();
  const targets = unusedImages(before, { keep });
  let removed = 0;
  const skipped = [];
  for (const image of targets) {
    // A multi-tagged image cannot be removed by id; drop each tag instead.
    const refs = image.tags.length > 1 ? image.tags : [image.tags[0] ?? image.id];
    try {
      for (const ref of refs) await docker.removeImage(ref);
      removed += 1;
    } catch (e) {
      skipped.push({ name: image.name, reason: e.message });
    }
  }
  const after = await docker.systemDf().catch(() => null);
  invalidate();
  const bytes = after ? Math.max((before.LayersSize ?? 0) - (after.LayersSize ?? 0), 0) : 0;
  return { bytes, removed, skipped, considered: targets.length };
}

/**
 * Remove stopped containers that passed selectStaleContainers(). Volumes are
 * never removed: the Engine call omits the volume flag entirely.
 */
export async function removeStaleContainers(docker, { olderThanMs = 86_400_000, now = Date.now() } = {}) {
  const df = await docker.systemDf();
  const records = await collectContainers(docker, df);
  const targets = selectStaleContainers(records, { olderThanMs, now });
  let removed = 0;
  let bytes = 0;
  const skipped = [];
  for (const container of targets) {
    try {
      await docker.removeContainer(container.id);
      removed += 1;
      bytes += container.sizeBytes;
    } catch (e) {
      skipped.push({ name: container.name, reason: e.message });
    }
  }
  invalidate();
  return { bytes, removed, skipped, considered: targets.length };
}

/** One-line summary used by the CLI and by alert/event detail text. */
export function describe(r) {
  if (!r.summary) return "Docker is not reachable from here, so only backup and history usage is known.";
  return [
    `images ${formatBytes(r.summary.images.totalBytes)}`,
    `volumes ${formatBytes(r.summary.volumes.totalBytes)}`,
    `build cache ${formatBytes(r.summary.buildCache.totalBytes)}`,
    `reclaimable ${formatBytes(r.reclaimableBytes ?? r.summary.reclaimableBytes)}`,
  ].join(", ");
}
