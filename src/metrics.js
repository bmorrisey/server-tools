/**
 * Host resource metrics read from /proc and statfs. Inside a container these
 * proc files reflect the host (loadavg, meminfo, and /proc/stat are not
 * namespaced), which is exactly what a single-box operator wants. Disk usage
 * needs the host path bind-mounted into the agent container (see DEPLOY.md).
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";

/** Memory usage from /proc/meminfo. Values in bytes. */
export function memory() {
  try {
    const text = fs.readFileSync("/proc/meminfo", "utf8");
    const get = (k) => {
      const m = text.match(new RegExp(`^${k}:\\s+(\\d+) kB`, "m"));
      return m ? Number(m[1]) * 1024 : null;
    };
    const total = get("MemTotal");
    const available = get("MemAvailable");
    if (total === null || available === null) throw new Error("missing fields");
    return { totalBytes: total, availableBytes: available, usedBytes: total - available, usedPct: Math.round(((total - available) / total) * 1000) / 10 };
  } catch {
    const total = os.totalmem();
    const free = os.freemem();
    return { totalBytes: total, availableBytes: free, usedBytes: total - free, usedPct: Math.round(((total - free) / total) * 1000) / 10 };
  }
}

/** 1/5/15 minute load averages plus core count for context. */
export function load() {
  const [m1, m5, m15] = os.loadavg();
  return { m1, m5, m15, cores: os.cpus().length };
}

let lastCpu = null;
/**
 * Host CPU utilisation percent since the previous call (first call returns
 * null pct). Reads aggregate jiffies from /proc/stat.
 */
export function cpu() {
  let line;
  try {
    line = fs.readFileSync("/proc/stat", "utf8").split("\n")[0];
  } catch {
    return { pct: null };
  }
  const parts = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = parts[3] + (parts[4] ?? 0);
  const total = parts.reduce((a, b) => a + b, 0);
  const prev = lastCpu;
  lastCpu = { idle, total };
  if (!prev || total === prev.total) return { pct: null };
  const dIdle = idle - prev.idle;
  const dTotal = total - prev.total;
  return { pct: Math.round((1 - dIdle / dTotal) * 1000) / 10 };
}

/** Disk usage for a path via statfs. */
export async function disk(pathname) {
  const s = await fsp.statfs(pathname);
  const total = s.blocks * s.bsize;
  const free = s.bavail * s.bsize;
  const used = total - free;
  return {
    path: pathname,
    totalBytes: total,
    freeBytes: free,
    usedBytes: used,
    usedPct: total ? Math.round((used / total) * 1000) / 10 : 0,
  };
}

/** Seconds the host has been up (host /proc/uptime is not namespaced). */
export function uptimeSeconds() {
  try {
    return Math.floor(Number(fs.readFileSync("/proc/uptime", "utf8").split(" ")[0]));
  } catch {
    return Math.floor(os.uptime());
  }
}
