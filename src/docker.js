/**
 * Minimal Docker Engine API client over the unix socket. No docker CLI and no
 * npm packages required; the agent just needs the socket mounted (read/write).
 *
 * Only the handful of endpoints the toolkit uses are implemented:
 *   - listContainers / inspect / stats  (health + resource checks)
 *   - exec                              (pg_dump, psql, in-container commands)
 *
 * Exec output uses Docker's multiplexed stream framing (8-byte header per
 * frame: [type, 0, 0, 0, len_be32]); demux() splits stdout/stderr.
 */
import http from "node:http";
import { logger } from "./log.js";

const log = logger("docker");

export class Docker {
  constructor({ socketPath = "/var/run/docker.sock" } = {}) {
    this.socketPath = socketPath;
  }

  /** One JSON request/response against the engine API. */
  request(method, apiPath, body = undefined) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const req = http.request(
        {
          socketPath: this.socketPath,
          method,
          path: apiPath,
          headers: payload
            ? { "Content-Type": "application/json", "Content-Length": payload.length }
            : {},
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            if (res.statusCode >= 400) {
              reject(new Error(`docker ${method} ${apiPath} -> ${res.statusCode}: ${text.slice(0, 300)}`));
              return;
            }
            if (!text) return resolve(null);
            try {
              resolve(JSON.parse(text));
            } catch {
              resolve(text);
            }
          });
        },
      );
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  async ping() {
    try {
      await this.request("GET", "/_ping");
      return true;
    } catch {
      return false;
    }
  }

  /** All containers (running and stopped). */
  listContainers() {
    return this.request("GET", "/containers/json?all=true");
  }

  /** Inspect one container by name or id. */
  inspect(nameOrId) {
    return this.request("GET", `/containers/${encodeURIComponent(nameOrId)}/json`);
  }

  /** One-shot resource stats for a running container. */
  stats(nameOrId) {
    return this.request("GET", `/containers/${encodeURIComponent(nameOrId)}/stats?stream=false&one-shot=true`);
  }

  /** Restart a container (graceful stop with timeout, then start). */
  async restart(nameOrId, { timeoutSec = 10 } = {}) {
    const c = await this.inspect(nameOrId);
    await this.request("POST", `/containers/${c.Id}/restart?t=${timeoutSec}`);
  }

  /** Disk usage summary (images, containers, volumes, build cache). */
  systemDf() {
    return this.request("GET", "/system/df");
  }

  /** Remove dangling (untagged, unused) images. Returns bytes reclaimed. */
  async pruneImages() {
    const r = await this.request("POST", "/images/prune", undefined);
    return r?.SpaceReclaimed ?? 0;
  }

  /** Remove reclaimable build cache. Returns bytes reclaimed. */
  async pruneBuildCache() {
    const r = await this.request("POST", "/build/prune", undefined);
    return r?.SpaceReclaimed ?? 0;
  }

  /**
   * Recent log lines from a container, newest last, as text. Handles both the
   * multiplexed stream format (no TTY) and raw output (TTY containers).
   */
  logs(nameOrId, { tail = 25, timeoutMs = 8000 } = {}) {
    return new Promise((resolve) => {
      const req = http.request(
        {
          socketPath: this.socketPath,
          method: "GET",
          path: `/containers/${encodeURIComponent(nameOrId)}/logs?stdout=true&stderr=true&tail=${tail}&timestamps=false`,
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve(demuxLogs(Buffer.concat(chunks))));
          res.on("error", () => resolve(""));
        },
      );
      req.setTimeout(timeoutMs, () => {
        req.destroy();
        resolve("");
      });
      req.on("error", () => resolve(""));
      req.end();
    });
  }

  /**
   * Find a container by exact name (with or without leading slash) or by
   * compose service label. Returns the inspect document or null.
   */
  async findContainer(name) {
    const all = await this.listContainers();
    const hit = all.find(
      (c) =>
        c.Names?.some((n) => n === `/${name}` || n === name) ||
        c.Labels?.["com.docker.compose.service"] === name,
    );
    return hit ? this.inspect(hit.Id) : null;
  }

  /**
   * Run a command inside a container. Returns { exitCode, stdout, stderr }.
   * When `stdoutStream` is provided, stdout bytes are written to it instead of
   * being buffered (used to stream large database dumps straight to disk).
   */
  async exec(nameOrId, cmd, { env = [], user = "", stdoutStream = null, timeoutMs = 15 * 60_000 } = {}) {
    const container = await this.inspect(nameOrId);
    const create = await this.request("POST", `/containers/${container.Id}/exec`, {
      AttachStdout: true,
      AttachStderr: true,
      Env: env,
      User: user,
      Cmd: cmd,
    });

    const { stdout, stderr } = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath: this.socketPath,
          method: "POST",
          path: `/exec/${create.Id}/start`,
          headers: { "Content-Type": "application/json" },
        },
        (res) => {
          if (res.statusCode >= 400) {
            reject(new Error(`docker exec start -> ${res.statusCode}`));
            return;
          }
          const demux = new Demuxer(stdoutStream);
          res.on("data", (chunk) => demux.push(chunk));
          res.on("end", () => resolve(demux.finish()));
          res.on("error", reject);
        },
      );
      req.setTimeout(timeoutMs, () => req.destroy(new Error("docker exec timed out")));
      req.on("error", reject);
      req.end(JSON.stringify({ Detach: false, Tty: false }));
    });

    if (stdoutStream) {
      await new Promise((resolve, reject) => stdoutStream.end((e) => (e ? reject(e) : resolve())));
    }
    const info = await this.request("GET", `/exec/${create.Id}/json`);
    return { exitCode: info.ExitCode ?? -1, stdout, stderr };
  }
}

/**
 * Decode a container logs response to text. Non-TTY logs are framed with an
 * 8-byte header per chunk (same as exec); TTY logs are raw. We detect framing
 * by checking the header shape and fall back to treating the bytes as raw.
 */
export function demuxLogs(buf) {
  const out = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const type = buf[i];
    const len = buf.readUInt32BE(i + 4);
    const framed = (type === 0 || type === 1 || type === 2) && buf[i + 1] === 0 && buf[i + 2] === 0 && buf[i + 3] === 0 && i + 8 + len <= buf.length;
    if (!framed) return buf.toString("utf8"); // raw / TTY output
    out.push(buf.subarray(i + 8, i + 8 + len));
    i += 8 + len;
  }
  return out.length ? Buffer.concat(out).toString("utf8") : buf.toString("utf8");
}

/** Splits Docker's multiplexed attach stream into stdout/stderr. */
class Demuxer {
  constructor(stdoutStream = null) {
    this.buf = Buffer.alloc(0);
    this.stdoutStream = stdoutStream;
    this.stdoutChunks = [];
    this.stderrChunks = [];
  }

  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 8) {
      const type = this.buf[0];
      const len = this.buf.readUInt32BE(4);
      if (this.buf.length < 8 + len) break;
      const payload = this.buf.subarray(8, 8 + len);
      this.buf = this.buf.subarray(8 + len);
      if (type === 2) {
        this.stderrChunks.push(Buffer.from(payload));
      } else if (this.stdoutStream) {
        this.stdoutStream.write(Buffer.from(payload));
      } else {
        this.stdoutChunks.push(Buffer.from(payload));
      }
    }
  }

  finish() {
    if (this.buf.length) log.warn(`discarding ${this.buf.length} trailing bytes from exec stream`);
    return {
      stdout: Buffer.concat(this.stdoutChunks).toString("utf8"),
      stderr: Buffer.concat(this.stderrChunks).toString("utf8"),
    };
  }
}
