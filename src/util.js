/**
 * Small shared utilities. No dependencies.
 */
import crypto from "node:crypto";

/**
 * Parse a human duration string into milliseconds.
 * Supports: "500ms", "30s", "5m", "2h", "1d", "1w" and bare numbers (ms).
 * Returns null for anything it does not understand.
 */
export function parseDuration(input) {
  if (typeof input === "number" && Number.isFinite(input) && input >= 0) return input;
  if (typeof input !== "string") return null;
  const m = input.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2] ?? "ms";
  const mult = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[unit];
  return Math.round(n * mult);
}

/** Render milliseconds as a short human string ("3d 4h", "90s", "250ms"). */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60 ? `${s % 60}s` : ""}`.trim();
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60 ? `${m % 60}m` : ""}`.trim();
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24 ? `${h % 24}h` : ""}`.trim();
}

/** Bytes to a human string with binary units. */
export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return "?";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/**
 * Parse a schedule spec into a descriptor. Accepted forms:
 *   - interval: "5m", "1h" (runs every N)
 *   - daily at: "03:30" (server-local time)
 *   - weekly at: "sun 03:30" (day name + time)
 * Returns { kind: "interval", everyMs } | { kind: "daily", hour, minute }
 *       | { kind: "weekly", dow, hour, minute } | null.
 */
export function parseSchedule(spec) {
  if (typeof spec !== "string") return null;
  const s = spec.trim().toLowerCase();
  const days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const weekly = s.match(/^(sun|mon|tue|wed|thu|fri|sat)\s+(\d{1,2}):(\d{2})$/);
  if (weekly) {
    const hour = Number(weekly[2]);
    const minute = Number(weekly[3]);
    if (hour > 23 || minute > 59) return null;
    return { kind: "weekly", dow: days.indexOf(weekly[1]), hour, minute };
  }
  const daily = s.match(/^(\d{1,2}):(\d{2})$/);
  if (daily) {
    const hour = Number(daily[1]);
    const minute = Number(daily[2]);
    if (hour > 23 || minute > 59) return null;
    return { kind: "daily", hour, minute };
  }
  const everyMs = parseDuration(s);
  if (everyMs !== null && everyMs >= 1000) return { kind: "interval", everyMs };
  return null;
}

/**
 * Milliseconds from `now` until the next firing of a parsed schedule.
 * For intervals, that is simply the interval (the caller anchors phase).
 */
export function msUntilNext(sched, now = new Date()) {
  if (!sched) return null;
  if (sched.kind === "interval") return sched.everyMs;
  const next = new Date(now);
  next.setSeconds(0, 0);
  next.setHours(sched.hour, sched.minute, 0, 0);
  if (sched.kind === "daily") {
    if (next <= now) next.setDate(next.getDate() + 1);
    return next.getTime() - now.getTime();
  }
  // weekly
  let delta = (sched.dow - next.getDay() + 7) % 7;
  next.setDate(next.getDate() + delta);
  if (next <= now) next.setDate(next.getDate() + 7);
  return next.getTime() - now.getTime();
}

/** URL-safe random id. */
export function randomId(bytes = 16) {
  return crypto.randomBytes(bytes).toString("base64url");
}

/** Constant-time string comparison (length-safe). */
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    // Compare against self to keep timing flat, then fail.
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

/** ISO timestamp without milliseconds, always UTC. */
export function isoNow(d = new Date()) {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Compact local timestamp safe for filenames: 20260713-153000. */
export function fileStamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/** Escape a string for safe inclusion in HTML text/attributes. */
export function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Deep get by dotted path ("a.b.c"), undefined when missing. */
export function dget(obj, path) {
  return String(path)
    .split(".")
    .reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** Simple concurrency-1 mutex per key; returns a release function. */
const locks = new Map();
export async function withLock(key, fn) {
  while (locks.get(key)) await locks.get(key);
  let release;
  const gate = new Promise((r) => (release = r));
  locks.set(key, gate);
  try {
    return await fn();
  } finally {
    locks.delete(key);
    release();
  }
}
