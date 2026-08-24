/**
 * File-backed state store under the data directory. Everything is plain JSON
 * or JSONL so an operator can inspect state with cat/jq during an incident.
 *
 * Layout (relative to dataDir):
 *   state/<name>.json          latest snapshot documents (checks, backups...)
 *   history/<topic>-YYYY-MM-DD.jsonl   append-only samples and events
 *   backups/<target>/          local backup artifacts
 *   metrics/<app>-YYYY-MM.jsonl        application metric snapshots
 *
 * Metric snapshots live outside history/ on purpose. History is pruned to
 * housekeeping.historyDays (90 by default) and that is right for check samples
 * and events, but these are a deliberately long record - a daily sample kept
 * for years - and putting them in history would hand that decision to a
 * setting made for something else. They are partitioned by month rather than
 * by day because there are few of them and many months.
 */
import fs from "node:fs";
import path from "node:path";
import { isoNow } from "./util.js";

export class Store {
  constructor(dataDir) {
    this.dataDir = path.resolve(dataDir);
  }

  ensureDirs() {
    for (const d of ["state", "history", "backups", "metrics", "tmp"]) {
      fs.mkdirSync(path.join(this.dataDir, d), { recursive: true });
    }
  }

  statePath(name) {
    return path.join(this.dataDir, "state", `${name}.json`);
  }

  readState(name, fallback = null) {
    try {
      return JSON.parse(fs.readFileSync(this.statePath(name), "utf8"));
    } catch {
      return fallback;
    }
  }

  writeState(name, value) {
    this.ensureDirs();
    const p = this.statePath(name);
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, p);
  }

  /** Append one record to a day-partitioned JSONL topic. */
  append(topic, record) {
    this.ensureDirs();
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(this.dataDir, "history", `${topic}-${day}.jsonl`);
    fs.appendFileSync(file, JSON.stringify({ ts: isoNow(), ...record }) + "\n");
  }

  /**
   * Read the most recent records for a topic (across day files, newest last).
   * Reads at most `maxDays` day-files back.
   */
  recent(topic, { limit = 500, maxDays = 7 } = {}) {
    const dir = path.join(this.dataDir, "history");
    let files = [];
    try {
      files = fs
        .readdirSync(dir)
        .filter((f) => f.startsWith(`${topic}-`) && f.endsWith(".jsonl"))
        .sort()
        .slice(-maxDays);
    } catch {
      return [];
    }
    // Newest file first, stopping once `limit` records are in hand. The
    // output is identical to reading everything and slicing, but the work is
    // not: the connectors let a caller widen the window to years, and the
    // limit has to bound what one request makes this process read, not just
    // what it returns.
    let out = [];
    for (let i = files.length - 1; i >= 0; i--) {
      const batch = [];
      for (const line of fs.readFileSync(path.join(dir, files[i]), "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          batch.push(JSON.parse(line));
        } catch {
          // Skip torn writes rather than failing the whole read.
        }
      }
      out = batch.concat(out);
      if (out.length >= limit) break;
    }
    return out.slice(-limit);
  }

  /** Delete history day-files older than `keepDays`. Returns removed count. */
  pruneHistory(keepDays = 90) {
    const dir = path.join(this.dataDir, "history");
    let removed = 0;
    const cutoff = new Date(Date.now() - keepDays * 86_400_000).toISOString().slice(0, 10);
    let files = [];
    try {
      files = fs.readdirSync(dir);
    } catch {
      return 0;
    }
    for (const f of files) {
      const m = f.match(/-(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (m && m[1] < cutoff) {
        fs.unlinkSync(path.join(dir, f));
        removed++;
      }
    }
    return removed;
  }

  /* ---------------------------------------------------------------------
   * Application metric snapshots
   * ------------------------------------------------------------------ */

  metricsDir() {
    const dir = path.join(this.dataDir, "metrics");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * One month-file per app. The name is checked here as well as in config
   * validation: it becomes a filename, and a store should not depend on
   * having been called correctly.
   */
  metricsFile(app, date = new Date()) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(String(app))) {
      throw new Error(`unsafe metrics app name: ${JSON.stringify(String(app)).slice(0, 60)}`);
    }
    const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    return path.join(this.metricsDir(), `${app}-${month}.jsonl`);
  }

  appendSnapshot(app, snapshot) {
    const file = this.metricsFile(app, new Date(Date.parse(snapshot.collectedAt) || Date.now()));
    fs.appendFileSync(file, `${JSON.stringify(snapshot)}\n`);
  }

  /**
   * Stored snapshots for an app, oldest first. `sinceMs` skips whole months
   * that cannot contain anything wanted, so a request for the last 30 days
   * does not read ten years off the disk.
   */
  readSnapshots(app, { sinceMs = null, limit = null } = {}) {
    const dir = this.metricsDir();
    const prefix = `${app}-`;
    let files;
    try {
      // The month suffix is what identifies the file, not the prefix alone.
      // A bare startsWith would make "api" read "api-staging"'s history, since
      // both are valid names and "api-staging-2026-08.jsonl" starts with
      // "api-".
      files = fs
        .readdirSync(dir)
        .filter((f) => f.startsWith(prefix) && monthOf(f, prefix) !== null)
        .sort();
    } catch {
      return [];
    }
    if (sinceMs !== null) {
      const since = new Date(sinceMs);
      const cutoff = `${since.getFullYear()}-${String(since.getMonth() + 1).padStart(2, "0")}`;
      files = files.filter((f) => monthOf(f, prefix) >= cutoff);
    }
    // Newest file first, stopping once `limit` records are in hand. Slicing
    // after reading everything is not a limit: a decade of daily samples is
    // read in full to print one snapshot, in the same process that runs the
    // checks and the backups.
    let out = [];
    for (let i = files.length - 1; i >= 0; i--) {
      const batch = [];
      for (const line of fs.readFileSync(path.join(dir, files[i]), "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line);
          if (sinceMs !== null && Date.parse(record.collectedAt) < sinceMs) continue;
          batch.push(record);
        } catch {
          // Skip a torn write rather than failing the whole read.
        }
      }
      // concat, not unshift(...batch): spreading a large array as arguments
      // overflows the stack at around 127k elements, and a fast schedule
      // reaches that inside a single month - defeating the very limit this
      // loop exists to honour.
      out = batch.concat(out);
      if (limit && out.length >= limit) break;
    }
    out.sort((a, b) => Date.parse(a.collectedAt) - Date.parse(b.collectedAt));
    return limit ? out.slice(-limit) : out;
  }

  /** Drop month-files entirely older than `keepDays`. Returns removed count. */
  pruneSnapshots(app, keepDays) {
    if (!Number.isFinite(keepDays) || keepDays <= 0) return 0;
    const dir = this.metricsDir();
    const prefix = `${app}-`;
    const cutoffDate = new Date(Date.now() - keepDays * 86_400_000);
    // A month is only removable once the whole of it is past the cutoff, so
    // compare against the month before the cutoff's own month.
    const cutoff = `${cutoffDate.getFullYear()}-${String(cutoffDate.getMonth() + 1).padStart(2, "0")}`;
    let removed = 0;
    let files = [];
    try {
      files = fs.readdirSync(dir);
    } catch {
      return 0;
    }
    for (const f of files) {
      if (!f.startsWith(prefix)) continue;
      const month = monthOf(f, prefix);
      if (month && month < cutoff) {
        fs.unlinkSync(path.join(dir, f));
        removed++;
      }
    }
    return removed;
  }

  backupDir(target) {
    const dir = path.join(this.dataDir, "backups", target);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  tmpDir() {
    const dir = path.join(this.dataDir, "tmp");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
}

/** "app-2026-08.jsonl" -> "2026-08". Null when the name does not carry one. */
function monthOf(filename, prefix) {
  const m = filename.slice(prefix.length).match(/^(\d{4}-\d{2})\.jsonl$/);
  return m ? m[1] : null;
}
