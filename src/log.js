/**
 * Structured-ish logging to stdout/stderr. One line per event, prefixed with
 * an ISO timestamp and a component tag. Never log secrets; callers are
 * responsible for redaction, but `redact()` is provided for belt and braces.
 */
import { isoNow } from "./util.js";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold = LEVELS[process.env.LOG_LEVEL?.toLowerCase()] ?? LEVELS.info;

export function setLevel(level) {
  if (LEVELS[level]) threshold = LEVELS[level];
}

function emit(level, tag, msg, extra) {
  if (LEVELS[level] < threshold) return;
  const line = `${isoNow()} [${level.toUpperCase().padEnd(5)}] ${tag}: ${msg}${
    extra ? ` ${JSON.stringify(extra)}` : ""
  }`;
  (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line + "\n");
}

export function logger(tag) {
  return {
    debug: (msg, extra) => emit("debug", tag, msg, extra),
    info: (msg, extra) => emit("info", tag, msg, extra),
    warn: (msg, extra) => emit("warn", tag, msg, extra),
    error: (msg, extra) => emit("error", tag, msg, extra),
  };
}

/** Replace likely secret values in a string with a placeholder. */
export function redact(text, secrets = []) {
  let out = String(text);
  for (const s of secrets) {
    if (s && s.length >= 6) out = out.replaceAll(s, "[redacted]");
  }
  return out;
}
