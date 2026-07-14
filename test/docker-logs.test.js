import { test } from "node:test";
import assert from "node:assert/strict";
import { demuxLogs } from "../src/docker.js";

function frame(type, text) {
  const payload = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = type;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

test("demuxLogs decodes multiplexed stdout/stderr frames in order", () => {
  const buf = Buffer.concat([frame(1, "line one\n"), frame(2, "an error\n"), frame(1, "line two\n")]);
  assert.equal(demuxLogs(buf), "line one\nan error\nline two\n");
});

test("demuxLogs falls back to raw for TTY output", () => {
  // TTY output has no frame header; first byte is a normal character.
  const raw = Buffer.from("plain tty output without framing\n");
  assert.equal(demuxLogs(raw), "plain tty output without framing\n");
});

test("demuxLogs handles empty input", () => {
  assert.equal(demuxLogs(Buffer.alloc(0)), "");
});
