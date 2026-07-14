/**
 * Grandfather-father-son retention. Every backup is a "daily"; a backup also
 * qualifies as "weekly" when taken on Sunday and "monthly" when taken on the
 * first day of the month. Pruning keeps the newest N of each class and
 * deletes everything else, where one artifact can satisfy multiple classes.
 *
 * Pure function over artifact descriptors so it is trivially testable:
 * artifacts: [{ key, date: Date }], policy: { daily, weekly, monthly }.
 * Returns { keep: Set<key>, drop: string[] }.
 */
export function planRetention(artifacts, policy = {}) {
  const daily = policy.daily ?? 7;
  const weekly = policy.weekly ?? 4;
  const monthly = policy.monthly ?? 6;

  const sorted = [...artifacts].sort((a, b) => b.date - a.date);
  const keep = new Set();

  let d = 0;
  for (const a of sorted) {
    if (d >= daily) break;
    keep.add(a.key);
    d++;
  }
  let w = 0;
  for (const a of sorted) {
    if (w >= weekly) break;
    if (a.date.getDay() === 0) {
      keep.add(a.key);
      w++;
    }
  }
  let m = 0;
  for (const a of sorted) {
    if (m >= monthly) break;
    if (a.date.getDate() === 1) {
      keep.add(a.key);
      m++;
    }
  }

  const drop = sorted.filter((a) => !keep.has(a.key)).map((a) => a.key);
  return { keep, drop };
}

/**
 * Parse the timestamp out of an artifact filename produced by this toolkit
 * (…-YYYYMMDD-HHMMSS.ext). Returns a Date or null.
 */
export function dateFromArtifactName(name) {
  const m = String(name).match(/(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  const [, y, mo, da, h, mi, s] = m.map(Number);
  const d = new Date(y, mo - 1, da, h, mi, s);
  return Number.isFinite(d.getTime()) ? d : null;
}
