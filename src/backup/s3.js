/**
 * Minimal S3-compatible client (AWS Signature Version 4), covering exactly
 * what offsite backups need: PUT, GET, DELETE, and ListObjectsV2. Works with
 * AWS S3 and S3-compatible stores that speak SigV4 (set `endpoint` for
 * non-AWS providers; path-style addressing is used when an endpoint is set).
 */
import crypto from "node:crypto";

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();

/**
 * SigV4 signing-key derivation, exported so tests can pin it to the vector
 * published in the AWS documentation.
 */
export function deriveSigningKey(secretAccessKey, day, region, service) {
  let key = hmac(`AWS4${secretAccessKey}`, day);
  key = hmac(key, region);
  key = hmac(key, service);
  return hmac(key, "aws4_request");
}

function amzDate(d = new Date()) {
  const iso = d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return { full: iso, day: iso.slice(0, 8) };
}

/** RFC 3986 encode a single path segment (S3 canonical URI rules). */
function encodeSegment(seg) {
  return encodeURIComponent(seg).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export class S3 {
  /**
   * cfg: { bucket, region, accessKeyId, secretAccessKey, endpoint?, prefix? }
   * endpoint example: "https://<accountid>.r2.cloudflarestorage.com"
   */
  constructor(cfg) {
    this.cfg = cfg;
    this.host = cfg.endpoint
      ? new URL(cfg.endpoint).host
      : `${cfg.bucket}.s3.${cfg.region}.amazonaws.com`;
    this.pathStyle = Boolean(cfg.endpoint);
    this.base = cfg.endpoint ? cfg.endpoint.replace(/\/$/, "") : `https://${this.host}`;
  }

  objectPath(key) {
    const prefixed = this.cfg.prefix ? `${this.cfg.prefix.replace(/\/$/, "")}/${key}` : key;
    const encoded = prefixed.split("/").map(encodeSegment).join("/");
    return this.pathStyle ? `/${this.cfg.bucket}/${encoded}` : `/${encoded}`;
  }

  /** Compute SigV4 headers for a request. Exposed for testability. */
  sign({ method, path, query = "", payloadHash, date = new Date() }) {
    const { full, day } = amzDate(date);
    const scope = `${day}/${this.cfg.region}/s3/aws4_request`;
    const headers = {
      host: this.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": full,
    };
    const signedHeaders = Object.keys(headers).sort().join(";");
    const canonicalHeaders = Object.keys(headers)
      .sort()
      .map((k) => `${k}:${String(headers[k]).trim()}\n`)
      .join("");
    const canonicalRequest = [method, path, query, canonicalHeaders, signedHeaders, payloadHash].join("\n");
    const stringToSign = ["AWS4-HMAC-SHA256", full, scope, sha256(canonicalRequest)].join("\n");
    const key = deriveSigningKey(this.cfg.secretAccessKey, day, this.cfg.region, "s3");
    const signature = crypto.createHmac("sha256", key).update(stringToSign).digest("hex");
    return {
      ...headers,
      authorization: `AWS4-HMAC-SHA256 Credential=${this.cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    };
  }

  async request(method, key, { query = "", body = null, rawPath = null } = {}) {
    const path = rawPath ?? this.objectPath(key);
    const payloadHash = body ? sha256(body) : sha256("");
    const headers = this.sign({ method, path, query, payloadHash });
    const url = `${this.base}${path}${query ? `?${query}` : ""}`;
    const res = await fetch(url, {
      method,
      headers: { ...headers, ...(body ? { "content-length": String(body.length) } : {}) },
      body: body ?? undefined,
      signal: AbortSignal.timeout(10 * 60_000),
    });
    if (!res.ok && res.status !== 404) {
      const text = await res.text().catch(() => "");
      throw new Error(`S3 ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    }
    return res;
  }

  async put(key, buf) {
    const res = await this.request("PUT", key, { body: buf });
    if (!res.ok) throw new Error(`S3 PUT ${key} -> ${res.status}`);
  }

  /** Returns a Buffer, or null when the object does not exist. */
  async get(key) {
    const res = await this.request("GET", key);
    if (res.status === 404) return null;
    return Buffer.from(await res.arrayBuffer());
  }

  async delete(key) {
    await this.request("DELETE", key);
  }

  /** List object keys under a prefix (relative to configured prefix). */
  async list(prefix = "") {
    const fullPrefix = this.cfg.prefix ? `${this.cfg.prefix.replace(/\/$/, "")}/${prefix}` : prefix;
    const keys = [];
    let token = null;
    do {
      const q = new URLSearchParams({ "list-type": "2", prefix: fullPrefix });
      if (token) q.set("continuation-token", token);
      const query = q.toString().replace(/\+/g, "%20");
      const rawPath = this.pathStyle ? `/${this.cfg.bucket}` : "/";
      const res = await this.request("GET", "", { query, rawPath });
      const xml = await res.text();
      for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) {
        const key = m[1];
        keys.push(this.cfg.prefix ? key.slice(this.cfg.prefix.replace(/\/$/, "").length + 1) : key);
      }
      const t = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
      token = t ? t[1] : null;
    } while (token);
    return keys;
  }
}
