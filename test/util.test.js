import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseDuration,
  formatDuration,
  formatBytes,
  parseSchedule,
  msUntilNext,
  safeEqual,
  escapeHtml,
  dget,
} from "../src/util.js";

test("parseDuration handles units and rejects junk", () => {
  assert.equal(parseDuration("500ms"), 500);
  assert.equal(parseDuration("30s"), 30_000);
  assert.equal(parseDuration("5m"), 300_000);
  assert.equal(parseDuration("2h"), 7_200_000);
  assert.equal(parseDuration("1d"), 86_400_000);
  assert.equal(parseDuration("1w"), 604_800_000);
  assert.equal(parseDuration("1.5h"), 5_400_000);
  assert.equal(parseDuration(250), 250);
  assert.equal(parseDuration("nope"), null);
  assert.equal(parseDuration(""), null);
  assert.equal(parseDuration(null), null);
  assert.equal(parseDuration("-5s"), null);
});

test("formatDuration and formatBytes render sane strings", () => {
  assert.equal(formatDuration(250), "250ms");
  assert.equal(formatDuration(90_000), "1m 30s");
  assert.equal(formatDuration(3 * 86_400_000), "3d");
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1536), "1.5 KiB");
  assert.equal(formatBytes(3 * 1024 ** 3), "3.0 GiB");
});

test("parseSchedule accepts intervals, daily, weekly", () => {
  assert.deepEqual(parseSchedule("5m"), { kind: "interval", everyMs: 300_000 });
  assert.deepEqual(parseSchedule("03:30"), { kind: "daily", hour: 3, minute: 30 });
  assert.deepEqual(parseSchedule("sun 04:00"), { kind: "weekly", dow: 0, hour: 4, minute: 0 });
  assert.equal(parseSchedule("25:00"), null);
  assert.equal(parseSchedule("moo 04:00"), null);
  assert.equal(parseSchedule("500ms"), null); // sub-second intervals rejected
});

test("msUntilNext computes daily and weekly gaps", () => {
  const now = new Date(2026, 0, 5, 12, 0, 0); // Monday noon
  const daily = parseSchedule("13:30");
  assert.equal(msUntilNext(daily, now), 90 * 60_000);
  const dailyPast = parseSchedule("11:00");
  assert.equal(msUntilNext(dailyPast, now), 23 * 3_600_000);
  const weekly = parseSchedule("sun 12:00");
  assert.equal(msUntilNext(weekly, now), 6 * 86_400_000);
  const weeklySameDayLater = parseSchedule("mon 12:01");
  assert.equal(msUntilNext(weeklySameDayLater, now), 60_000);
});

test("safeEqual compares without throwing on length mismatch", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false);
  assert.equal(safeEqual("", ""), true);
});

test("escapeHtml neutralises markup", () => {
  assert.equal(escapeHtml(`<img src=x onerror="a('b')">`), "&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;");
});

test("dget walks dotted paths", () => {
  assert.equal(dget({ a: { b: { c: 3 } } }, "a.b.c"), 3);
  assert.equal(dget({ a: 1 }, "a.b.c"), undefined);
  assert.equal(dget(null, "a"), undefined);
});
