/**
 * File-backed state store under the data directory. Everything is plain JSON
 * or JSONL so an operator can inspect state with cat/jq during an incident.
 *
 * Layout (relative to dataDir):
 *   state/<name>.json          latest snapshot documents (checks, backups...)
 *   history/<topic>-YYYY-MM-DD.jsonl   append-only samples and events
 *   backups/<target>/          local backup artifacts
 */
import fs from "node:fs";
import path from "node:path";
import { isoNow } from "./util.js";

export class Store {
  constructor(dataDir) {
    this.dataDir = path.resolve(dataDir);
  }

  ensureDirs() {
    for (const d of ["state", "history", "backups", "tmp"]) {
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
    const out = [];
    for (const f of files) {
      const lines = fs.readFileSync(path.join(dir, f), "utf8").split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line));
        } catch {
          // Skip torn writes rather than failing the whole read.
        }
      }
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
