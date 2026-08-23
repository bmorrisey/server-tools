/**
 * Collecting application metrics.
 *
 * Pull, not push: the agent reads a URL the app serves or a file the app
 * writes, which is how every other check here already works and keeps the
 * application entirely ignorant of the agent. An app that cannot expose either
 * can write the file from a cron job; nothing has to be taught about us.
 *
 * This is a deliberately slow channel. The default interval is hourly and the
 * documented advice is daily; anything wanting per-second data wants a
 * different tool and the docs say so. The value here is the long view, which
 * is also why a failed collection is loud: a gap nobody noticed is the one
 * thing that makes a years-long series worthless.
 *
 * Failure reuses the check machinery's shape rather than inventing a second
 * alerting path: consecutive failures below the threshold are recorded and
 * shown, the threshold-crossing failure alerts once, and a later success
 * sends the recovery.
 */
import fsp from "node:fs/promises";
import { parseSnapshot, LIMITS } from "./snapshot.js";
import { parseDuration } from "../util.js";
import { logger } from "../log.js";

const log = logger("appmetrics");

export const DEFAULT_RETENTION_DAYS = 3650;
export const DEFAULT_INTERVAL = "1h";

/** How the source is described in logs and on the page. Never the token. */
export function describeSource(source) {
  if (source?.url) return source.url;
  if (source?.file) return source.file;
  return "unconfigured";
}

/**
 * Read the document from wherever the app publishes it.
 *
 * The size cap is enforced on the way in rather than after parsing, because
 * the point of a cap is to not hold the thing in memory in the first place.
 */
export async function fetchDocument(target, { timeoutMs = 10_000, fetchImpl = fetch, readFile = fsp.readFile } = {}) {
  const source = target.source ?? {};
  if (source.file) {
    const stat = await fsp.stat(source.file).catch(() => null);
    if (stat && stat.size > LIMITS.bytes) {
      throw new Error(`${source.file} is ${stat.size} bytes; the limit is ${LIMITS.bytes}`);
    }
    return readFile(source.file, "utf8");
  }
  if (!source.url) throw new Error("no source configured");

  const headers = { accept: "application/json", "user-agent": "server-tools-metrics" };
  // The token is a config secret: it goes in a header and never into a log
  // line, an error message, or the recorded event detail.
  if (source.token) headers.authorization = `Bearer ${source.token}`;

  const res = await fetchImpl(source.url, {
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const declared = Number(res.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > LIMITS.bytes) {
    throw new Error(`response declares ${declared} bytes; the limit is ${LIMITS.bytes}`);
  }
  const text = await res.text();
  if (text.length > LIMITS.bytes) throw new Error(`response is larger than ${LIMITS.bytes} bytes`);
  return text;
}

/**
 * Collect one app once: read, validate, store, prune.
 *
 * Returns the recorded state patch. Throws on failure, having recorded it, so
 * the caller can alert without needing to know what went wrong.
 */
export async function collect(target, { store, ...io } = {}) {
  const startedAt = new Date();
  try {
    const raw = await fetchDocument(target, { timeoutMs: parseDuration(target.timeout ?? "10s"), ...io });
    const { snapshot, problems } = parseSnapshot(raw, { collectedAt: startedAt });
    store.appendSnapshot(target.name, snapshot);

    const count = Object.keys(snapshot.metrics).length;
    const detail =
      `${count} metric${count === 1 ? "" : "s"} from ${describeSource(target.source)}` +
      (problems.length ? `; ${problems.length} dropped: ${problems.slice(0, 3).join("; ")}` : "");

    const patch = {
      lastSuccess: startedAt.toISOString(),
      lastResult: "ok",
      lastDetail: detail,
      lastCount: count,
      lastDropped: problems.length,
      lastDurationMs: Date.now() - startedAt.getTime(),
    };
    record(store, target, patch);
    store.append("events", { topic: "metrics", kind: "ok", name: target.name, detail });
    if (problems.length) log.warn(`metrics ${target.name}: ${problems.length} metric(s) dropped`);
    log.info(`metrics ${target.name}: ${detail}`);

    const removed = store.pruneSnapshots(target.name, target.retentionDays ?? DEFAULT_RETENTION_DAYS);
    if (removed) log.info(`metrics ${target.name}: pruned ${removed} month-file(s) past retention`);
    return patch;
  } catch (e) {
    const patch = { lastResult: "fail", lastDetail: e.message, lastAttempt: startedAt.toISOString() };
    record(store, target, patch);
    store.append("events", { topic: "metrics", kind: "fail", name: target.name, detail: e.message });
    log.error(`metrics ${target.name} failed: ${e.message}`);
    throw e;
  }
}

function record(store, target, patch) {
  const state = store.readState("metrics", {});
  state[target.name] = { ...(state[target.name] ?? {}), ...patch };
  store.writeState("metrics", state);
}

/**
 * Consecutive-failure gating, the same shape the check engine uses: alert once
 * when the threshold is crossed, recover once when it passes again. Kept as a
 * small class rather than reusing CheckEngine because a collection is not a
 * check and should not appear among them.
 */
export class CollectorState {
  constructor() {
    this.runtime = new Map();
  }

  /** Returns "fail" | "recover" | null - the transition worth alerting on. */
  evaluate(name, ok, threshold = 2) {
    const rt = this.runtime.get(name) ?? { consecutiveFails: 0, alerted: false };
    let transition = null;
    if (ok) {
      if (rt.alerted) transition = "recover";
      rt.consecutiveFails = 0;
      rt.alerted = false;
    } else {
      rt.consecutiveFails++;
      if (!rt.alerted && rt.consecutiveFails >= threshold) {
        rt.alerted = true;
        transition = "fail";
      }
    }
    this.runtime.set(name, rt);
    return transition;
  }
}
