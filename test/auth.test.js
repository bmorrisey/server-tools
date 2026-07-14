import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import {
  createLoginToken,
  consumeToken,
  sessionFromCookie,
  destroySession,
  sessionCookie,
  emailAllowed,
  csrfValid,
  RateLimiter,
} from "../src/web/auth.js";

function ctx() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "st-auth-"));
  const store = new Store(dir);
  store.ensureDirs();
  const config = {
    web: { baseUrl: "https://ops.example.com", allowedEmails: ["op@example.com"], sessionDays: 30 },
  };
  return { store, config, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("login link only for allowlisted emails; case-insensitive", () => {
  const { store, config, cleanup } = ctx();
  try {
    assert.ok(emailAllowed(config, "OP@example.com"));
    assert.ok(!emailAllowed(config, "attacker@example.com"));
    const url = createLoginToken({ config, store, email: "Op@Example.com" });
    assert.match(url, /^https:\/\/ops\.example\.com\/auth\?token=[A-Za-z0-9_-]{20,}$/);
    assert.throws(() => createLoginToken({ config, store, email: "nope@example.com" }), /allowedEmails/);
  } finally {
    cleanup();
  }
});

test("token is single-use and yields a working session", () => {
  const { store, config, cleanup } = ctx();
  try {
    const url = createLoginToken({ config, store, email: "op@example.com" });
    const token = new URL(url).searchParams.get("token");

    const sessionId = consumeToken({ config, store, token });
    assert.ok(sessionId);
    // Second use fails.
    assert.equal(consumeToken({ config, store, token }), null);

    const cookie = sessionCookie(config, sessionId);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Secure/); // https baseUrl

    const session = sessionFromCookie({ store, cookieHeader: `st_session=${sessionId}` });
    assert.equal(session.email, "op@example.com");

    destroySession({ store, cookieHeader: `st_session=${sessionId}` });
    assert.equal(sessionFromCookie({ store, cookieHeader: `st_session=${sessionId}` }), null);
  } finally {
    cleanup();
  }
});

test("garbage, expired, and forged tokens are rejected", () => {
  const { store, config, cleanup } = ctx();
  try {
    assert.equal(consumeToken({ config, store, token: "" }), null);
    assert.equal(consumeToken({ config, store, token: "short" }), null);
    assert.equal(consumeToken({ config, store, token: "A".repeat(22) }), null);

    // Expired token: issue a real one, age it past its expiry, then try it.
    const url = createLoginToken({ config, store, email: "op@example.com" });
    const token = new URL(url).searchParams.get("token");
    const auth = store.readState("auth");
    for (const k of Object.keys(auth.tokens)) auth.tokens[k].expires = Date.now() - 1;
    store.writeState("auth", auth);
    assert.equal(consumeToken({ config, store, token }), null);
  } finally {
    cleanup();
  }
});

test("sessions expire", () => {
  const { store, config, cleanup } = ctx();
  try {
    const url = createLoginToken({ config, store, email: "op@example.com" });
    const sessionId = consumeToken({ config, store, token: new URL(url).searchParams.get("token") });
    const auth = store.readState("auth");
    for (const k of Object.keys(auth.sessions)) auth.sessions[k].expires = Date.now() - 1;
    store.writeState("auth", auth);
    assert.equal(sessionFromCookie({ store, cookieHeader: `st_session=${sessionId}` }), null);
  } finally {
    cleanup();
  }
});

test("sessions carry a CSRF token and csrfValid checks it", () => {
  const { store, config, cleanup } = ctx();
  try {
    const url = createLoginToken({ config, store, email: "op@example.com" });
    const sessionId = consumeToken({ config, store, token: new URL(url).searchParams.get("token") });
    const session = sessionFromCookie({ store, cookieHeader: `st_session=${sessionId}` });
    assert.ok(session.csrf && session.csrf.length >= 16);
    assert.ok(csrfValid(session, session.csrf));
    assert.ok(!csrfValid(session, "wrong-token"));
    assert.ok(!csrfValid(session, ""));
    assert.ok(!csrfValid({ email: "x" }, "anything")); // no csrf on session
  } finally {
    cleanup();
  }
});

test("sessions created before CSRF existed get one backfilled on read", () => {
  const { store, config, cleanup } = ctx();
  try {
    const url = createLoginToken({ config, store, email: "op@example.com" });
    const sessionId = consumeToken({ config, store, token: new URL(url).searchParams.get("token") });
    // Simulate a legacy session with no csrf field.
    const auth = store.readState("auth");
    for (const k of Object.keys(auth.sessions)) delete auth.sessions[k].csrf;
    store.writeState("auth", auth);
    const session = sessionFromCookie({ store, cookieHeader: `st_session=${sessionId}` });
    assert.ok(session.csrf);
    // And it persisted.
    const again = sessionFromCookie({ store, cookieHeader: `st_session=${sessionId}` });
    assert.equal(session.csrf, again.csrf);
  } finally {
    cleanup();
  }
});

test("rate limiter enforces the window", () => {
  const rl = new RateLimiter({ max: 3, windowMs: 60_000 });
  assert.ok(rl.allow("ip1"));
  assert.ok(rl.allow("ip1"));
  assert.ok(rl.allow("ip1"));
  assert.ok(!rl.allow("ip1"));
  assert.ok(rl.allow("ip2")); // independent keys
});
