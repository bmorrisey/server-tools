/**
 * The application metrics contract: what an app publishes, and how the agent
 * reads it.
 *
 * Host metrics (src/metrics.js) are numbers the box knows about itself. These
 * are numbers an *application* knows about itself and the box cannot see: row
 * counts, storage per tenant, queue depth, whatever that application considers
 * worth tracking. The agent deliberately knows nothing about what any of them
 * mean. The app supplies the key, the label and the unit; `kind` is a
 * rendering hint and nothing more. Adding a vocabulary here for any particular
 * application is the thing this design exists to avoid.
 *
 * The document is versioned from the first release. An unknown `schema` is
 * refused rather than guessed at: a payload the agent half-understands is
 * worse than one it rejects, because the numbers still render.
 *
 * Everything here treats the document as untrusted. It arrives over HTTP from
 * a separate application that may be broken, mid-deploy, or compromised, so
 * sizes and shapes are capped and anything that fails validation is dropped
 * and counted rather than stored. Labels reach the dashboard and are escaped
 * at render time like any other untrusted string.
 */
import { formatBytes, formatDuration } from "../util.js";

/** The only document version this agent understands. */
export const SCHEMA_VERSION = 1;

/**
 * Rendering hints. These say how to format a number, never what it means.
 * `duration` is milliseconds and `percent` is 0-100, because a unit that is
 * only implied is a unit that eventually gets it wrong.
 */
export const KINDS = new Set(["count", "bytes", "number", "percent", "duration", "breakdown"]);

// Caps. A published document is remote input; these bound what one broken app
// can do to the agent's memory, its data directory, and its dashboard.
export const LIMITS = {
  bytes: 256 * 1024,
  metrics: 200,
  breakdownEntries: 50,
  keyLength: 64,
  labelLength: 120,
};

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);

/**
 * Validate one metric entry. Returns { ok, metric } or { ok: false, problem }.
 * Problems name the key so an operator can tell the app's author what to fix.
 */
function parseMetric(key, raw) {
  const bad = (why) => ({ ok: false, problem: `${key}: ${why}` });

  if (!KEY_RE.test(key)) return bad("key must start alphanumeric and use only letters, digits, _ . or -");
  if (key.length > LIMITS.keyLength) return bad(`key is longer than ${LIMITS.keyLength} characters`);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad("must be an object");

  const kind = raw.kind ?? "number";
  if (!KINDS.has(kind)) return bad(`kind "${kind}" is not one of ${[...KINDS].join(", ")}`);

  if (raw.label !== undefined && (typeof raw.label !== "string" || raw.label.length > LIMITS.labelLength)) {
    return bad(`label must be a string of at most ${LIMITS.labelLength} characters`);
  }
  if (raw.precision !== undefined && !(Number.isInteger(raw.precision) && raw.precision >= 0 && raw.precision <= 6)) {
    return bad("precision must be an integer from 0 to 6");
  }
  if (raw.cumulative !== undefined && typeof raw.cumulative !== "boolean") {
    return bad("cumulative must be true or false");
  }

  let value;
  if (kind === "breakdown") {
    if (!raw.value || typeof raw.value !== "object" || Array.isArray(raw.value)) {
      return bad("a breakdown value must be an object of category to number");
    }
    const entries = Object.entries(raw.value);
    if (entries.length > LIMITS.breakdownEntries) {
      return bad(`a breakdown may have at most ${LIMITS.breakdownEntries} categories`);
    }
    value = {};
    for (const [category, n] of entries) {
      if (category.length > LIMITS.keyLength) return bad(`breakdown category "${category.slice(0, 20)}..." is too long`);
      if (!isFiniteNumber(n)) return bad(`breakdown category "${category}" is not a finite number`);
      value[category] = n;
    }
  } else {
    if (!isFiniteNumber(raw.value)) return bad("value must be a finite number");
    value = raw.value;
  }

  const metric = { value, kind };
  if (raw.label !== undefined) metric.label = raw.label;
  if (raw.precision !== undefined) metric.precision = raw.precision;
  if (raw.cumulative !== undefined) metric.cumulative = raw.cumulative;
  return { ok: true, metric };
}

/**
 * Parse a published document into a snapshot.
 *
 * Envelope problems throw: a document whose version or shape the agent cannot
 * read is a failed collection, and failing loudly is the point. Individual bad
 * metrics are dropped and reported instead, so one malformed number does not
 * cost the operator every other number in the same document.
 *
 * `collectedAt` is when the agent read it and is always the agent's own clock.
 * `capturedAt` is what the app claimed, kept separately because the two can
 * legitimately differ (a nightly job publishing a file, say) and because a
 * clock the agent does not control must never drive retention or ordering.
 */
export function parseSnapshot(raw, { collectedAt = new Date() } = {}) {
  let doc = raw;
  if (typeof doc === "string") {
    // Bytes, not characters: a document of multi-byte text is larger than its
    // length suggests, and the cap is about memory.
    if (Buffer.byteLength(doc) > LIMITS.bytes) throw new Error(`document is larger than ${LIMITS.bytes} bytes`);
    try {
      doc = JSON.parse(doc);
    } catch (e) {
      throw new Error(`document is not valid JSON: ${e.message}`);
    }
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("document must be a JSON object");
  if (doc.schema !== SCHEMA_VERSION) {
    throw new Error(
      `document declares schema ${JSON.stringify(doc.schema)}; this agent reads schema ${SCHEMA_VERSION} only`,
    );
  }
  if (!doc.metrics || typeof doc.metrics !== "object" || Array.isArray(doc.metrics)) {
    throw new Error("document must have a metrics object");
  }

  const entries = Object.entries(doc.metrics);
  if (entries.length > LIMITS.metrics) {
    throw new Error(`document publishes ${entries.length} metrics; the limit is ${LIMITS.metrics}`);
  }

  const metrics = {};
  const problems = [];
  for (const [key, value] of entries) {
    const parsed = parseMetric(key, value);
    if (parsed.ok) metrics[key] = parsed.metric;
    else problems.push(parsed.problem);
  }
  if (entries.length > 0 && Object.keys(metrics).length === 0) {
    throw new Error(`no usable metrics in the document: ${problems.slice(0, 3).join("; ")}`);
  }

  const snapshot = {
    collectedAt: collectedAt.toISOString(),
    metrics,
  };
  const captured = doc.capturedAt === undefined ? null : Date.parse(doc.capturedAt);
  if (captured !== null && Number.isFinite(captured)) snapshot.capturedAt = new Date(captured).toISOString();
  if (problems.length) snapshot.dropped = problems.length;
  return { snapshot, problems };
}

/* -------------------------------------------------------------------------
 * Formatting
 *
 * One number, two audiences: a tile wants the exact value, an axis tick wants
 * something that fits. `formatValue` is the exact one.
 * ---------------------------------------------------------------------- */

/** Group digits without depending on a locale the server and browser share. */
export function groupDigits(n) {
  const [whole, fraction] = String(n).split(".");
  const sign = whole.startsWith("-") ? "-" : "";
  const digits = sign ? whole.slice(1) : whole;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}${grouped}${fraction ? `.${fraction}` : ""}`;
}

/** Render a metric value the way its `kind` asks for. */
export function formatValue(value, { kind = "number", precision } = {}) {
  if (kind === "breakdown") {
    const entries = Object.entries(value ?? {});
    if (!entries.length) return "-";
    return entries.map(([k, v]) => `${k} ${groupDigits(v)}`).join(", ");
  }
  if (!isFiniteNumber(value)) return "-";
  switch (kind) {
    case "bytes":
      return formatBytes(value);
    case "duration":
      return formatDuration(value);
    case "percent":
      return `${groupDigits(round(value, precision ?? 1))}%`;
    case "count":
      return groupDigits(round(value, precision ?? 0));
    default:
      return groupDigits(round(value, precision ?? 2));
  }
}

/** A signed change, formatted like the metric it belongs to. */
export function formatDelta(delta, { kind = "number", precision } = {}) {
  if (!isFiniteNumber(delta)) return null;
  if (delta === 0) return "no change";
  const sign = delta > 0 ? "+" : "-";
  const magnitude = formatValue(Math.abs(delta), { kind, precision });
  return `${sign}${magnitude}`;
}

function round(n, places) {
  const factor = 10 ** places;
  return Math.round(n * factor) / factor;
}

/** The total a breakdown represents, for charting it as one series. */
export function breakdownTotal(value) {
  return Object.values(value ?? {}).reduce((sum, n) => sum + (isFiniteNumber(n) ? n : 0), 0);
}

/** The number to plot for a metric, whatever its kind. */
export function numericValue(metric) {
  if (!metric) return null;
  if (metric.kind === "breakdown") return breakdownTotal(metric.value);
  return isFiniteNumber(metric.value) ? metric.value : null;
}

/**
 * A short form for an axis tick, where space is the constraint and precision
 * is not. Deliberately mirrored by the browser-side formatter in the
 * dashboard's one hashed script: the page cannot call back for labels under a
 * "default-src 'none'" policy, so the same rules exist in both places and the
 * tests below pin the server's half.
 */
export function compactValue(value, kind = "number") {
  if (!Number.isFinite(value)) return "-";
  if (kind === "bytes") return formatBytes(value);
  if (kind === "duration") return formatDuration(value);
  const suffix = kind === "percent" ? "%" : "";
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${trim(value / 1e9)}G${suffix}`;
  if (abs >= 1e6) return `${trim(value / 1e6)}M${suffix}`;
  if (abs >= 1e4) return `${trim(value / 1e3)}k${suffix}`;
  if (abs >= 100 || Number.isInteger(value)) return `${Math.round(value)}${suffix}`;
  return `${trim(value)}${suffix}`;
}

function trim(n) {
  return String(Math.round(n * 10) / 10);
}

/**
 * A UTC axis label. UTC rather than the server's zone because the same label
 * is regenerated in the browser, and a chart whose axis shifts when you drag
 * it is worse than one that names a zone the reader has to convert.
 */
export function compactTime(ms, spanMs) {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return "";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (n) => String(n).padStart(2, "0");
  if (spanMs <= 2 * 86_400_000) return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  if (spanMs <= 400 * 86_400_000) return `${d.getUTCDate()} ${months[d.getUTCMonth()]}`;
  return `${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
