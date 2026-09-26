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
 * - Running containers are never touched. Container removal is restricted to
 *   containers that already exited.
 * - An image any container references, running or stopped, is never a removal
 *   candidate. Docker refuses to delete an in-use image by its last tag, but it
 *   will untag an in-use image that has a second tag, so for a multi-tagged
 *   image this check is the only protection there is. It is made here, from
 *   the container list, and not left to the Engine.
 * - The newest versions of each image repository are kept for rollback
 *   (housekeeping.keepImageVersions, 3 by default), so "remove unused images"
 *   cannot take away the previous release a deploy would roll back to.
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
import { dateFromArtifactName } from "./backup/retention.js";
import { planPrune } from "./backup/backup.js";
import { parseDuration, formatBytes } from "./util.js";
import { logger } from "./log.js";

const log = logger("storage");

/** How long a container must have been stopped before it counts as leftover. */
export const DEFAULT_STALE_CONTAINER_AGE = "24h";

/** Image versions kept per repository for rollback, unless configured. */
export const DEFAULT_KEEP_IMAGE_VERSIONS = 3;

/**
 * How old a cached report may be before a page view starts a new measurement
 * in the background. The page still renders at once from the cached report.
 */
export const PAGE_STALE_MS = 5 * 60_000;

/**
 * How often the agent re-measures on its own. /system/df walks every image
 * layer and takes over a minute on a box with hundreds of images, so it runs
 * on a slow schedule rather than per page view.
 */
export const BACKGROUND_REFRESH_MS = 30 * 60_000;

/** Restart policies that mark a container as "meant to be running". */
const SUPERVISED_POLICIES = new Set(["always", "unless-stopped"]);

const COMPOSE_PROJECT = "com.docker.compose.project";
const COMPOSE_SERVICE = "com.docker.compose.service";
const NO_PROJECT = "(not part of a compose project)";

// ---------------------------------------------------------------------------
// Pure analysis over the Engine's /system/df document
// ---------------------------------------------------------------------------

/**
 * Bytes an image occupies including the layers it inherits. Right for one
 * image and wrong to add up: versions of the same application share their
 * base layers, so a sum over images counts each shared layer once per image.
 * Totals over several images go through imageReclaimEstimate() instead.
 */
function imageBytes(image) {
  const virtual = Number(image?.VirtualSize);
  if (Number.isFinite(virtual) && virtual > 0) return virtual;
  const size = Number(image?.Size);
  return Number.isFinite(size) && size > 0 ? size : 0;
}

/**
 * Bytes of an image that no other image uses, and the bytes it shares.
 *
 * The Engine reports SharedSize as -1 when it did not compute it. Reading that
 * as "nothing shared" would call the whole image unique and overstate what
 * removing it frees, so an unknown share is treated as all shared instead:
 * the estimate then errs towards promising less.
 */
function layerSplit(image) {
  const size = imageBytes(image);
  const raw = Number(image?.SharedSize);
  const shared = Number.isFinite(raw) && raw >= 0 ? Math.min(raw, size) : size;
  return { size, shared, unique: size - shared };
}

function tagsOf(image) {
  return (image?.RepoTags ?? []).filter((t) => t && t !== "<none>:<none>");
}

function digestsOf(image) {
  return (image?.RepoDigests ?? []).filter((d) => d && !d.startsWith("<none>"));
}

/**
 * The repository part of a tag or digest reference: "registry:5000/o/app:v1"
 * and "o/app@sha256:..." give "registry:5000/o/app" and "o/app". The tag is
 * whatever follows the last colon after the last slash, so a registry port is
 * not mistaken for one.
 */
export function repositoryOf(ref) {
  const s = String(ref ?? "");
  const at = s.indexOf("@");
  if (at >= 0) return s.slice(0, at);
  const slash = s.lastIndexOf("/");
  const colon = s.lastIndexOf(":");
  return colon > slash ? s.slice(0, colon) : s;
}

/**
 * Every repository an image belongs to. An image pulled by digest has no tag
 * but still has a repository through its digest, which matters: it is exactly
 * how a digest-pinned release looks, and it must not be mistaken for build
 * debris.
 */
function repositoriesOf(image) {
  return [...new Set([...tagsOf(image), ...digestsOf(image)].map(repositoryOf).filter(Boolean))];
}

/**
 * IDs of every image a container references, running or stopped.
 *
 * The Engine's per-image Containers count already covers this, and the
 * container list is checked as well because the consequence of a miss is
 * deleting (or silently untagging) an image something still needs.
 */
export function referencedImageIds(df = {}) {
  const ids = new Set();
  for (const c of df.Containers ?? []) if (c.ImageID) ids.add(c.ImageID);
  for (const i of df.Images ?? []) if ((i.Containers ?? 0) > 0) ids.add(i.Id);
  return ids;
}

/**
 * The keep count actually applied. 0 turns the rule off. 1 is raised to 2:
 * the newest version is usually the one running, so keeping only one would
 * keep nothing to roll back to.
 */
export function effectiveKeepVersions(n) {
  if (n === undefined || n === null) return DEFAULT_KEEP_IMAGE_VERSIONS;
  const v = Math.max(Math.floor(Number(n)) || 0, 0);
  return v === 1 ? 2 : v;
}

/**
 * Images kept for rollback: the newest N distinct image IDs of each
 * repository, newest by build time. In-use images take part in the ranking,
 * because the version running now is one of the N; an image with several
 * tags counts once. Returns a Map of image ID to the repository that kept it.
 */
export function rollbackKeepers(df = {}, keepVersions = DEFAULT_KEEP_IMAGE_VERSIONS) {
  const n = effectiveKeepVersions(keepVersions);
  const kept = new Map();
  if (n === 0) return kept;
  const byRepo = new Map();
  for (const image of df.Images ?? []) {
    for (const repo of repositoriesOf(image)) {
      if (!byRepo.has(repo)) byRepo.set(repo, new Map());
      byRepo.get(repo).set(image.Id, image);
    }
  }
  for (const [repo, images] of [...byRepo.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const newest = [...images.values()].sort((a, b) => (b.Created ?? 0) - (a.Created ?? 0)).slice(0, n);
    for (const image of newest) if (!kept.has(image.Id)) kept.set(image.Id, repo);
  }
  return kept;
}

/**
 * What removing a set of images would free, as { minBytes, maxBytes }.
 *
 * Per image the Engine reports its full size and how much of it is shared
 * with at least one other image; it does not say which images share what. So
 * the answer is a range:
 *
 * - At least the bytes that only the removed images use (sum of Size minus
 *   SharedSize over them), because nothing else can be holding those.
 * - At most that plus whatever shared bytes no kept image can need. Every
 *   kept image needs all of its own shared layers, so the largest SharedSize
 *   among kept images is still needed whatever else is true.
 * - Never more than the removed images add up to, and never more than every
 *   image layer on the box (LayersSize).
 *
 * For "remove every image with no container" the floor is exactly the
 * reclaimable figure `docker system df` shows on Docker 29. The ceiling is
 * what an operator can call "up to": on a box where old versions share a base
 * that nothing running uses any more, removing them frees that base as well.
 */
export function imageReclaimEstimate(df = {}, removeIds = []) {
  const removing = new Set(removeIds);
  let minBytes = 0;
  let removedSize = 0;
  let uniqueAll = 0;
  let sizeAll = 0;
  let keptShared = 0;
  for (const image of df.Images ?? []) {
    const { size, shared, unique } = layerSplit(image);
    uniqueAll += unique;
    sizeAll += size;
    if (removing.has(image.Id)) {
      minBytes += unique;
      removedSize += size;
    } else {
      keptShared = Math.max(keptShared, shared);
    }
  }
  const layers = Number.isFinite(df.LayersSize) && df.LayersSize >= 0 ? df.LayersSize : sizeAll;
  const sharedPool = Math.max(layers - uniqueAll, 0);
  const upper = Math.min(removedSize, minBytes + Math.max(sharedPool - keptShared, 0), layers);
  return { minBytes, maxBytes: Math.max(upper, minBytes) };
}

function containerName(entry) {
  const name = entry?.Names?.[0] ?? entry?.Name ?? entry?.Id ?? "";
  return String(name).replace(/^\//, "");
}

/**
 * Roll the Engine's disk-usage document into totals per category.
 *
 * Image reclaimable bytes agree with `docker system df`. Engines from API
 * 1.52 (Docker 29) send the figure themselves, ImageUsage.Reclaimable, and it
 * is used as sent. Older engines get the same calculation done here: the bytes
 * only unused images hold, which is the floor of imageReclaimEstimate(). The
 * older CLI formula, LayersSize minus what in-use images hold alone, counted
 * every layer shared with a running image as reclaimable and on a real box
 * claimed 46 GiB where 17.5 GiB was true. Writable layers of stopped containers
 * and build cache that is not in use complete the picture. Volume bytes are
 * reported separately and are never counted as reclaimable, because this
 * toolkit does not delete volumes.
 */
export function summarizeDf(df = {}) {
  const images = df.Images ?? [];
  const containers = df.Containers ?? [];
  const volumes = df.Volumes ?? [];
  const cache = df.BuildCache ?? [];
  const referenced = referencedImageIds(df);
  const inUse = (i) => referenced.has(i.Id);

  const layersSize = Number.isFinite(df.LayersSize)
    ? df.LayersSize
    : images.reduce((sum, i) => sum + imageBytes(i), 0);
  const unusedIds = images.filter((i) => !inUse(i)).map((i) => i.Id);
  const engineReclaimable = Number(df.ImageUsage?.Reclaimable);
  const imageReclaimable =
    Number.isFinite(engineReclaimable) && engineReclaimable >= 0
      ? engineReclaimable
      : imageReclaimEstimate(df, unusedIds).minBytes;
  const danglingIds = images.filter((i) => !inUse(i) && tagsOf(i).length === 0 && digestsOf(i).length === 0).map((i) => i.Id);

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
      unusedCount: images.filter((i) => !inUse(i)).length,
      totalBytes: layersSize,
      reclaimableBytes: Math.min(imageReclaimable, layersSize),
      danglingBytes: imageReclaimEstimate(df, danglingIds).maxBytes,
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

function imageRow(image) {
  const tags = tagsOf(image);
  const digests = digestsOf(image);
  const shortId = String(image.Id).replace(/^sha256:/, "").slice(0, 12);
  const { size, shared, unique } = layerSplit(image);
  let name = tags[0];
  if (!name && digests.length) name = `${repositoryOf(digests[0])}@${digests[0].split("@")[1]?.replace(/^sha256:/, "").slice(0, 12)}`;
  return {
    id: image.Id,
    tags,
    name: name ?? `${shortId} (untagged)`,
    // Untagged AND undigested: build debris nothing can start from by name.
    // A digest-pinned release has no tag but is not debris.
    dangling: tags.length === 0 && digests.length === 0,
    sizeBytes: size,
    sharedBytes: shared,
    uniqueBytes: unique,
    createdAt: image.Created ? new Date(image.Created * 1000).toISOString() : null,
  };
}

/**
 * Sort images no container references into removal candidates and the ones
 * kept for rollback, each biggest first. Returns { candidates, kept }.
 *
 * - `keep`: glob patterns matched against tags. A match is never listed at
 *   all, so an operator can pin a known-good image by name.
 * - `keepVersions`: the newest N image IDs per repository are kept (see
 *   rollbackKeepers). They are returned in `kept` with the repository that
 *   kept them, so the page can say what it is holding back and why.
 */
export function classifyUnusedImages(df = {}, { keep = [], keepVersions = DEFAULT_KEEP_IMAGE_VERSIONS } = {}) {
  const referenced = referencedImageIds(df);
  const keepers = rollbackKeepers(df, keepVersions);
  const candidates = [];
  const kept = [];
  for (const image of df.Images ?? []) {
    if (referenced.has(image.Id)) continue;
    const row = imageRow(image);
    if (row.tags.some((t) => keep.some((p) => globMatch(p, t)))) continue;
    if (keepers.has(image.Id)) kept.push({ ...row, keptFor: keepers.get(image.Id) });
    else candidates.push(row);
  }
  const bySize = (a, b) => b.sizeBytes - a.sizeBytes;
  return { candidates: candidates.sort(bySize), kept: kept.sort(bySize) };
}

/** Images that would be removed: no container, not pinned, not kept for rollback. */
export function unusedImages(df = {}, opts = {}) {
  return classifyUnusedImages(df, opts).candidates;
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
    // An external target stores nothing here; asking for its directory would
    // create an empty one and then report it as a row.
    if (target.type === "external") continue;
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
    // Same plan the scheduler applies after every run, so the number shown is
    // exactly what the button would delete.
    const plan = planPrune(files.map((f) => f.key), target.retention, { type: target.type });
    const dropping = new Set(plan.drop);
    const dropped = files.filter((f) => dropping.has(f.key));
    rows.push({
      name: target.name,
      fileCount: files.length,
      artifactCount: files.filter((f) => f.date).length,
      totalBytes,
      prunableCount: plan.droppedRuns,
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

/**
 * The last measurement, kept in memory.
 *
 * `stale` is set by invalidate() after an action changed the disk: the old
 * report stays readable, so the page does not go blank after every click, but
 * the next read starts a new measurement. `generation` catches the other
 * order of events, an action finishing while a measurement it predates is
 * still running; that result is stored as stale rather than as current.
 */
let cache = { at: 0, report: null, stale: false };
let inflight = null;
let generation = 0;

/** Mark the cached report as out of date after a change we just made. */
export function invalidate() {
  generation += 1;
  cache = { ...cache, stale: true };
}

/** The last completed report, however old, without measuring anything. */
export function latest() {
  return cache.report;
}

/**
 * Start a measurement, or join the one already running. Two page views, or a
 * page view and the scheduled refresh, never run /system/df side by side.
 */
export function refresh(ctx, { now } = {}) {
  if (inflight) {
    if (inflight.generation === generation) return inflight.promise;
    // The running measurement predates a change. Let it land, then measure again.
    return inflight.promise.catch(() => {}).then(() => refresh(ctx, { now }));
  }
  const gen = generation;
  const at = now ?? Date.now();
  const promise = compute(ctx, { now: at })
    .then((built) => {
      cache = { at, report: built, stale: gen !== generation };
      return built;
    })
    .finally(() => {
      inflight = null;
    });
  inflight = { promise, generation: gen };
  return promise;
}

/**
 * The storage report, measured now unless a fresh one is cached. This waits
 * for the measurement, which is right for the CLI and for reclaim, where the
 * operator is about to act on the numbers. Pages use peek() instead.
 */
export async function report(ctx, { maxAgeMs = 20_000, now = Date.now() } = {}) {
  if (cache.report && !cache.stale && now - cache.at < maxAgeMs) return cache.report;
  return refresh(ctx, { now });
}

/**
 * The cached report for a page, returned at once. When there is none, or it
 * is older than `staleAfterMs`, or an action has changed the disk since, a
 * measurement starts in the background and `refreshing` says so. The page
 * shows the figures it has with their age rather than holding the request
 * open for the minute or more /system/df can take on a busy box.
 *
 * Returns { report, measuredAt, ageMs, refreshing, stale }; report is null
 * until the first measurement completes.
 */
export function peek(ctx, { staleAfterMs = PAGE_STALE_MS, now = Date.now() } = {}) {
  const due = !cache.report || cache.stale || now - cache.at >= staleAfterMs;
  if (due && !inflight) {
    refresh(ctx).catch((e) => log.warn(`storage measurement failed: ${e.message}`));
  }
  return {
    report: cache.report,
    measuredAt: cache.report ? new Date(cache.at).toISOString() : null,
    ageMs: cache.report ? Math.max(now - cache.at, 0) : null,
    refreshing: Boolean(inflight),
    stale: cache.stale,
  };
}

/**
 * The whole storage picture: filesystem, category breakdown, per-project
 * rollup, removal candidates, and the cleanup plan.
 */
async function compute({ docker, store, config }, { now = Date.now() } = {}) {
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
  const keepVersions = effectiveKeepVersions(config.housekeeping?.keepImageVersions);
  const summary = df ? summarizeDf(df) : null;
  const records = df ? await collectContainers(docker, df) : [];
  const stale = selectStaleContainers(records, { olderThanMs: staleAgeMs(config), now });
  const { candidates: images, kept } = df ? classifyUnusedImages(df, { keep, keepVersions }) : { candidates: [], kept: [] };
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
    // Blocks the filesystem holds back for root are neither data nor free to
    // ordinary processes. Left inside "used" they inflated it (and "Everything
    // else") by about 5% of the disk on ext4, so they get their own line.
    if (disk.reservedBytes > 0) {
      breakdown.push({
        key: "reserved",
        label: "Reserved by the filesystem",
        bytes: disk.reservedBytes,
        note: "Space the filesystem keeps back for the root user, usually 5% on ext4. It holds no data, and it is not counted as used, the same as df.",
      });
    }
  }

  const imageIds = (rows) => rows.map((i) => i.id);
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
    keptImages: kept,
    keepImageVersions: keepVersions,
    imageEstimates: df
      ? {
          dangling: imageReclaimEstimate(df, imageIds(images.filter((i) => i.dangling))),
          unused: imageReclaimEstimate(df, imageIds(images)),
        }
      : null,
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
  const totals = planTotals(built.plan);
  built.reclaimableBytes = totals.all;
  built.safeReclaimableBytes = totals.safe;
  return built;
}

/**
 * Totals over the plan without counting anything twice. The untagged-images
 * action removes a subset of what "remove all unused images" removes, so when
 * both are offered only the larger one counts towards the total.
 */
export function planTotals(plan = []) {
  const counted = plan.filter((a) => !a.subsetOf || !plan.some((b) => b.id === a.subsetOf));
  return {
    all: counted.reduce((s, a) => s + a.bytes, 0),
    safe: plan.filter((a) => a.kind === "safe").reduce((s, a) => s + a.bytes, 0),
  };
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

  // Image sizes overlap, so what an image action frees is an estimate over the
  // whole set (see imageReclaimEstimate). Without one, fall back to the bytes
  // only those images use, which can only understate.
  const estimate = (rows, known) =>
    known ?? { minBytes: rows.reduce((sum, i) => sum + (i.uniqueBytes ?? 0), 0), maxBytes: rows.reduce((sum, i) => sum + (i.uniqueBytes ?? 0), 0) };
  const kept = r.keptImages ?? [];
  const keptNote =
    r.keepImageVersions > 0
      ? ` The newest ${r.keepImageVersions} versions of each image are kept for rollback${kept.length ? ` (${kept.length} held back, listed below)` : ""}.`
      : "";

  const dangling = r.unusedImages.filter((i) => i.dangling);
  const tagged = r.unusedImages.filter((i) => !i.dangling);
  if (dangling.length) {
    const e = estimate(dangling, r.imageEstimates?.dangling);
    plan.push({
      id: "reclaim-dangling-images",
      label: "Remove untagged leftover images",
      kind: "safe",
      bytes: e.maxBytes,
      minBytes: e.minBytes,
      count: dangling.length,
      items: dangling.map((i) => i.name),
      ...(tagged.length ? { subsetOf: "remove-unused-images" } : {}),
      what: "Removes images with no name, no digest and no container using them, the debris every rebuild leaves behind.",
      risk: "No risk. Nothing can start from an image with no name. Images pulled by digest keep their digest and are not included.",
    });
  }

  if (tagged.length) {
    const e = estimate(r.unusedImages, r.imageEstimates?.unused);
    plan.push({
      id: "remove-unused-images",
      label: "Remove old images with no container",
      kind: "caution",
      bytes: e.maxBytes,
      minBytes: e.minBytes,
      count: r.unusedImages.length,
      items: r.unusedImages.map((i) => i.name),
      what: `Removes the ${r.unusedImages.length} image${r.unusedImages.length > 1 ? "s" : ""} listed below, which no container uses, running or stopped, including ${tagged.length} named one${tagged.length > 1 ? "s" : ""}.${keptNote}`,
      risk:
        "Running and stopped containers are untouched. The cost is time: rolling back to one of these versions means pulling or rebuilding it first.",
    });
  }

  if (r.staleContainers.length) {
    plan.push({
      id: "remove-stopped-containers",
      label: "Remove old stopped containers",
      kind: "caution",
      bytes: r.staleContainers.reduce((sum, c) => sum + c.sizeBytes, 0),
      count: r.staleContainers.length,
      items: r.staleContainers.map((c) => c.name),
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
      what: `Deletes ${b.prunableCount} backup run${b.prunableCount > 1 ? "s" : ""} (artifacts and their manifests) already older than your retention policy (${b.retention.daily} daily, ${b.retention.weekly} weekly, ${b.retention.monthly} monthly).`,
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

/**
 * Remove a list of images by explicit reference, and measure what it freed.
 *
 * A multi-tagged image cannot be removed by id, so each tag is dropped in
 * turn. Nothing is forced: an image the Engine refuses (in use after all, or
 * a parent of another image) is skipped with its reason and the rest carry
 * on. Freed bytes come from the Engine's layer total before and after, the
 * only figure that is exact.
 */
async function removeImages(docker, before, targets) {
  let removed = 0;
  const skipped = [];
  for (const image of targets) {
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
 * Remove untagged, undigested images no container references.
 *
 * This lists them and removes each one rather than calling the Engine's
 * prune: prune's idea of "dangling" is "no tag", which includes an image
 * pulled by digest - the previous release of a digest-pinned deploy. The list
 * here is the one the page showed.
 */
export async function reclaimDanglingImages(docker, { keep = [], keepVersions } = {}) {
  const before = await docker.systemDf();
  const targets = unusedImages(before, { keep, keepVersions }).filter((i) => i.dangling);
  return removeImages(docker, before, targets);
}

/**
 * Remove exactly the images the report listed as unused: no container
 * references them, they match no keep pattern, and they are not among the
 * newest versions kept for rollback. The list is recomputed from a fresh
 * disk-usage document immediately before removing, so a container created
 * since the page was drawn protects its image.
 */
export async function removeUnusedImages(docker, { keep = [], keepVersions } = {}) {
  const before = await docker.systemDf();
  return removeImages(docker, before, unusedImages(before, { keep, keepVersions }));
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
