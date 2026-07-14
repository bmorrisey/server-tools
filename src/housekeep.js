/**
 * Housekeeping: prune the toolkit's own history files, expire temp files, and
 * optionally clean configured directories (age-based) - e.g. an application's
 * tmp upload folder. Deliberately conservative: it only deletes inside the
 * directories it is explicitly given, never follows symlinks out of them, and
 * logs what it removed.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { parseDuration, formatBytes } from "./util.js";
import { logger } from "./log.js";

const log = logger("housekeep");

/**
 * Remove files older than maxAge in a directory (recursive, files only,
 * then empty dirs). Returns { files, bytes }.
 */
export async function cleanDir(dir, maxAgeMs, { dryRun = false } = {}) {
  const cutoff = Date.now() - maxAgeMs;
  let files = 0;
  let bytes = 0;
  async function walk(d) {
    let entries;
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(full);
        const remaining = await fsp.readdir(full).catch(() => ["x"]);
        if (remaining.length === 0 && !dryRun) await fsp.rmdir(full).catch(() => {});
      } else if (entry.isFile()) {
        const st = await fsp.stat(full).catch(() => null);
        if (st && st.mtimeMs < cutoff) {
          if (!dryRun) await fsp.rm(full, { force: true });
          files++;
          bytes += st.size;
        }
      }
    }
  }
  await walk(dir);
  return { files, bytes };
}

/** Run all configured housekeeping. config.housekeeping:
 *   { historyDays?: 90, tmpAge?: "2d", clean?: [{ path, maxAge }] }
 */
export async function housekeep(config, store, { dryRun = false } = {}) {
  const hk = config.housekeeping ?? {};
  const summary = [];

  const removedHistory = dryRun ? 0 : store.pruneHistory(hk.historyDays ?? 90);
  if (removedHistory) summary.push(`history: removed ${removedHistory} old day-files`);

  const tmpAge = parseDuration(hk.tmpAge ?? "2d");
  const tmpResult = await cleanDir(store.tmpDir(), tmpAge, { dryRun });
  if (tmpResult.files) summary.push(`tmp: ${tmpResult.files} files (${formatBytes(tmpResult.bytes)})`);

  for (const rule of hk.clean ?? []) {
    const maxAge = parseDuration(rule.maxAge ?? "7d");
    const r = await cleanDir(rule.path, maxAge, { dryRun });
    if (r.files) summary.push(`${rule.path}: ${r.files} files (${formatBytes(r.bytes)})`);
  }

  const detail = summary.length ? summary.join("; ") : "nothing to remove";
  store.append("events", { topic: "housekeep", kind: "ok", detail: `${dryRun ? "(dry run) " : ""}${detail}` });
  log.info(`housekeeping${dryRun ? " (dry run)" : ""}: ${detail}`);
  return { summary, dryRun };
}
