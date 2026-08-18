import { test } from "node:test";
import assert from "node:assert/strict";
import { demuxLogs, pickVolumeMount, safeRef } from "../src/docker.js";

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

test("pickVolumeMount finds a container that mounts the volume, running or not", () => {
  const containers = [
    { Id: "a", Names: ["/other-1"], State: "running", Mounts: [{ Type: "volume", Name: "other", Destination: "/x" }] },
    { Id: "b", Names: ["/app-1"], State: "exited", Mounts: [{ Type: "volume", Name: "app_media", Destination: "/app/storage" }] },
  ];
  // A stopped stack is exactly when someone reaches for a backup, so a
  // stopped container is still a way in.
  assert.deepEqual(pickVolumeMount(containers, "app_media"), {
    id: "b",
    name: "app-1",
    destination: "/app/storage",
  });
  assert.equal(pickVolumeMount(containers, "nothing"), null);
  assert.equal(pickVolumeMount([], "app_media"), null);
});

test("pickVolumeMount prefers a running container and ignores bind mounts", () => {
  const containers = [
    { Id: "b", Names: ["/app-old"], State: "exited", Mounts: [{ Type: "volume", Name: "m", Destination: "/old" }] },
    { Id: "c", Names: ["/app-1"], State: "running", Mounts: [{ Type: "volume", Name: "m", Destination: "/app/storage" }] },
    { Id: "d", Names: ["/decoy"], State: "running", Mounts: [{ Type: "bind", Name: "m", Destination: "/nope" }] },
  ];
  assert.equal(pickVolumeMount(containers, "m").id, "c");
});

test("safeRef rejects references that could change the meaning of a request", () => {
  assert.equal(safeRef("ghcr.io/owner/app:v1.2.3"), "ghcr.io/owner/app:v1.2.3");
  assert.throws(() => safeRef("app:v1 --privileged"), /unsafe docker reference/);
  assert.throws(() => safeRef("../../etc/passwd"), /unsafe docker reference/);
});
