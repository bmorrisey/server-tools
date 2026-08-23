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
 * Every metric key seen across the snapshots, with the ones still being
 * published first. Metrics legitimately appear and disappear, and the history
 * of a key that is gone is still worth having.
 */
export function seriesKeys(snapshots) {
  const latest = snapshots[snapshots.length - 1];
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
  return { current, retired };
}

/**
 * The [time, value] points for one key. Snapshots that did not publish the key
 * are skipped rather than filled with zeroes: a gap in a chart is honest, a
 * zero is a claim the app never made.
 */
export function buildSeries(snapshots, key, { numericValue }) {
  const points = [];
  for (const snapshot of snapshots) {
    const t = timeOf(snapshot);
    if (!Number.isFinite(t)) continue;
    const metric = snapshot.metrics?.[key];
    if (!metric) continue;
    const v = numericValue(metric);
    if (v === null) continue;
    points.push([t, v]);
  }
  points.sort((a, b) => a[0] - b[0]);
  return points;
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

/** Snapshots newer than `sinceMs`, or all of them when it is null. */
export function withinWindow(snapshots, sinceMs) {
  if (sinceMs === null || sinceMs === undefined) return snapshots;
  return snapshots.filter((s) => {
    const t = timeOf(s);
    return Number.isFinite(t) && t >= sinceMs;
  });
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
