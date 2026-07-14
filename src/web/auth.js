/**
 * Dashboard authentication: magic links + server-side sessions.
 *
 * - No passwords. A login token (128-bit random) is issued only for addresses
 *   on web.allowedEmails, stored hashed, single-use, 15 minute expiry.
 * - Tokens reach the operator by email (when SMTP alerting is configured) or
 *   via `server-tools login-link <email>` on the box - so SMTP is optional.
 * - A consumed token becomes a session: random 128-bit id, stored hashed with
 *   its expiry in the data dir, sent as an httpOnly cookie. Sessions survive
 *   agent restarts and can be revoked by deleting them from auth.json.
 * - Login attempts are rate-limited per IP and per email. All comparisons of
 *   secrets go through hashing (lookups by digest), never string equality on
 *   raw values.
 */
import crypto from "node:crypto";
import { randomId, safeEqual } from "../util.js";
import { logger } from "../log.js";

const log = logger("auth");

const TOKEN_TTL_MS = 15 * 60_000;
const COOKIE_NAME = "st_session";

const hash = (v) => crypto.createHash("sha256").update(v).digest("hex");

function readAuth(store) {
  return store.readState("auth", { tokens: {}, sessions: {} });
}

function writeAuth(store, auth) {
  store.writeState("auth", auth);
}

function pruneExpired(auth) {
  const now = Date.now();
  for (const [k, t] of Object.entries(auth.tokens)) {
    if (t.expires < now) delete auth.tokens[k];
  }
  for (const [k, s] of Object.entries(auth.sessions)) {
    if (s.expires < now) delete auth.sessions[k];
  }
}

export function emailAllowed(config, email) {
  const normalized = String(email).trim().toLowerCase();
  return (config.web.allowedEmails ?? []).some((e) => e.toLowerCase() === normalized);
}

/** Issue a login URL for an allowed email. Throws for unknown addresses. */
export function createLoginToken({ config, store, email }) {
  if (!emailAllowed(config, email)) {
    throw new Error(`"${email}" is not in web.allowedEmails`);
  }
  const token = randomId(16);
  const auth = readAuth(store);
  pruneExpired(auth);
  auth.tokens[hash(token)] = {
    email: String(email).trim().toLowerCase(),
    expires: Date.now() + TOKEN_TTL_MS,
  };
  writeAuth(store, auth);
  const base = config.web.baseUrl.replace(/\/$/, "");
  return `${base}/auth?token=${token}`;
}

/** Exchange a valid token for a session id (null if invalid/expired/used). */
export function consumeToken({ config, store, token }) {
  if (typeof token !== "string" || token.length < 16) return null;
  const auth = readAuth(store);
  pruneExpired(auth);
  const key = hash(token);
  const entry = auth.tokens[key];
  if (!entry) return null;
  delete auth.tokens[key]; // single use
  const sessionId = randomId(16);
  const days = config.web.sessionDays ?? 30;
  auth.sessions[hash(sessionId)] = {
    email: entry.email,
    csrf: randomId(16),
    created: Date.now(),
    expires: Date.now() + days * 86_400_000,
  };
  writeAuth(store, auth);
  log.info(`login: ${entry.email}`);
  return sessionId;
}

/** Resolve the session cookie to { email, csrf } or null. */
export function sessionFromCookie({ store, cookieHeader }) {
  const sessionId = parseCookies(cookieHeader)[COOKIE_NAME];
  if (!sessionId) return null;
  const auth = readAuth(store);
  const key = hash(sessionId);
  const entry = auth.sessions[key];
  if (!entry || entry.expires < Date.now()) return null;
  // Backfill a CSRF token for sessions created before this field existed.
  if (!entry.csrf) {
    entry.csrf = randomId(16);
    auth.sessions[key] = entry;
    writeAuth(store, auth);
  }
  return { email: entry.email, csrf: entry.csrf };
}

/** Constant-time check that a submitted CSRF token matches the session. */
export function csrfValid(session, token) {
  return Boolean(session?.csrf) && typeof token === "string" && safeEqual(session.csrf, token);
}

export function destroySession({ store, cookieHeader }) {
  const sessionId = parseCookies(cookieHeader)[COOKIE_NAME];
  if (!sessionId) return;
  const auth = readAuth(store);
  delete auth.sessions[hash(sessionId)];
  writeAuth(store, auth);
}

export function sessionCookie(config, sessionId) {
  const days = config.web.sessionDays ?? 30;
  const secure = config.web.baseUrl?.startsWith("https") ? "; Secure" : "";
  return `${COOKIE_NAME}=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${days * 86_400}${secure}`;
}

export function clearCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** Sliding-window rate limiter (in-memory; login is the only guarded path). */
export class RateLimiter {
  constructor({ max = 5, windowMs = 15 * 60_000 } = {}) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  allow(key) {
    const now = Date.now();
    const list = (this.hits.get(key) ?? []).filter((t) => t > now - this.windowMs);
    if (list.length >= this.max) {
      this.hits.set(key, list);
      return false;
    }
    list.push(now);
    this.hits.set(key, list);
    return true;
  }
}
