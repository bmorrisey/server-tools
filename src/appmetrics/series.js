/**
 * Turning stored snapshots into something a page can draw.
 *
 * Everything here is a pure function over the snapshots, and that is the point
 * for deltas in particular: a delta is never stored. A stored delta can
 * disagree with the values it was computed from - after a backfill, a clock
 * correction, or a pruned snapshot - and then there are two truths and no way
 * to tell which one is lying. Recomputing on read costs nothing at this
 * volume and cannot drift.
 */

/** Ordering is the agent's own clock, never the app's claimed capture time. */
const timeOf = (snapshot) => Date.parse(snapshot?.collectedAt ?? "");

/**
 * Sort only when the points are not already in order.
 *
 * Snapshots come out of the store ascending, so every series built from them
 * already is. Sorting anyway is the single most expensive thing on a page with
 * many metrics: comparing sorted data still costs n log n, once per metric.
 */
function sortByTime(points) {
  for (let i = 1; i < points.length; i++) {
    if (points[i][0] < points[i - 1][0]) return points.sort((a, b) => a[0] - b[0]);
  }
  return points;
}

/**
 * Every metric key seen across the snapshots, with the ones still being
 * published first. Metrics legitimately appear and disappear, and the history
 * of a key that is gone is still worth having.
 */
export function seriesKeys(snapshots) {
  // The newest snapshot that actually published something, not simply the
  // newest. An empty document is legitimate - an app mid-deploy, or one whose
  // query failed - and reading the latest blindly would report every metric as
  // retired and the application as having published nothing, on a collection
  // recorded as ok. That looks exactly like losing the data.
  let latest = null;
  for (let i = snapshots.length - 1; i >= 0; i--) {
    if (Object.keys(snapshots[i].metrics ?? {}).length > 0) {
      latest = snapshots[i];
      break;
    }
  }
  const current = Object.keys(latest?.metrics ?? {});
  const seen = new Set(current);
  const retired = [];
  for (let i = snapshots.length - 2; i >= 0; i--) {
    for (const key of Object.keys(snapshots[i].metrics ?? {})) {
      if (seen.has(key)) continue;
      seen.add(key);
      retired.push(key);
    }
  }
  // The snapshot the keys came from travels with them. A caller that took the
  // newest snapshot instead would look up a key that is not in it and get
  // undefined, which is the same empty-publish case wearing a different hat.
  return { current, retired, latest };
}

/**
 * Every key's points in one pass over the snapshots.
 *
 * buildSeries per key means re-walking the whole history once per metric, and
 * the metric count is set by the application rather than by the operator. At
 * the documented ceiling that is millions of iterations in the process that
 * also runs the checks and the backups.
 */
export function buildAllSeries(snapshots, keys, { numericValue }) {
  const series = new Map(keys.map((key) => [key, []]));
  for (const snapshot of snapshots) {
    const t = timeOf(snapshot);
    if (!Number.isFinite(t)) continue;
    // Walk what the snapshot actually holds rather than probing it for every
    // requested key: a metric that came and went costs nothing on the
    // snapshots that never carried it.
    const metrics = snapshot.metrics;
    if (!metrics) continue;
    for (const key in metrics) {
      const points = series.get(key);
      if (points === undefined) continue;
      const v = numericValue(metrics[key]);
      if (v === null) continue;
      points.push([t, v]);
    }
  }
  for (const points of series.values()) sortByTime(points);
  return series;
}

/**
 * Deltas against the previous snapshot and against roughly a week earlier.
 *
 * The week-ago comparison is what makes a slow metric readable: day-over-day
 * noise on a weekly cycle says very little, and the same weekday last week
 * says a lot. It only answers when a sample actually exists near that point -
 * `tolerance` decides how near - because inventing a comparison the data does
 * not support is worse than showing none.
 */
export function computeDeltas(points, { weekMs = 7 * 86_400_000, tolerance = 36 * 3_600_000 } = {}) {
  if (points.length === 0) return { latest: null, previous: null, weekAgo: null };
  const [latestT, latestV] = points[points.length - 1];
  const result = { latest: { at: latestT, value: latestV }, previous: null, weekAgo: null };

  if (points.length > 1) {
    const [prevT, prevV] = points[points.length - 2];
    result.previous = { at: prevT, value: prevV, delta: latestV - prevV };
  }

  const target = latestT - weekMs;
  let best = null;
  for (let i = points.length - 2; i >= 0; i--) {
    const distance = Math.abs(points[i][0] - target);
    if (best === null || distance < best.distance) best = { index: i, distance };
    // Points are sorted, so once we are moving away from the target we are done.
    if (points[i][0] < target && best.distance <= Math.abs(points[i][0] - target)) break;
  }
  if (best !== null && best.distance <= tolerance) {
    const [t, v] = points[best.index];
    result.weekAgo = { at: t, value: v, delta: latestV - v };
  }
  return result;
}

/**
 * Reduce a long series to at most `max` points for the browser.
 *
 * Ten years of daily samples is a small file by most standards but a large one
 * to repeat for every metric on a page. Buckets keep the first and last point
 * exactly, and take each bucket's extreme against the running mean so a spike
 * survives the reduction - a downsample that quietly flattens the one
 * interesting day is worse than no chart.
 */
export function downsample(points, max = 600) {
  if (points.length <= max || max < 3) return points;
  const out = [points[0]];
  const inner = max - 2;
  const span = points.length - 2;
  for (let b = 0; b < inner; b++) {
    const start = 1 + Math.floor((b * span) / inner);
    const end = 1 + Math.floor(((b + 1) * span) / inner);
    if (end <= start) continue;
    let mean = 0;
    for (let i = start; i < end; i++) mean += points[i][1];
    mean /= end - start;
    let pick = start;
    let furthest = -1;
    for (let i = start; i < end; i++) {
      const d = Math.abs(points[i][1] - mean);
      if (d > furthest) {
        furthest = d;
        pick = i;
      }
    }
    out.push(points[pick]);
  }
  out.push(points[points.length - 1]);
  return out;
}

/** Named windows offered on the page. `null` days means everything stored. */
export const WINDOWS = [
  { id: "30d", label: "30 days", days: 30 },
  { id: "90d", label: "90 days", days: 90 },
  { id: "1y", label: "1 year", days: 365 },
  { id: "all", label: "All", days: null },
];

export function windowById(id) {
  return WINDOWS.find((w) => w.id === id) ?? WINDOWS[1];
}
