import { test } from "node:test";
import assert from "node:assert/strict";
import { planRetention, dateFromArtifactName } from "../src/backup/retention.js";

function art(key, iso) {
  return { key, date: new Date(iso) };
}

test("keeps newest N dailies", () => {
  const artifacts = [];
  for (let d = 1; d <= 20; d++) {
    const dd = String(d).padStart(2, "0");
    artifacts.push(art(`a-202601${dd}`, `2026-01-${dd}T03:00:00`));
  }
  const { keep, drop } = planRetention(artifacts, { daily: 7, weekly: 0, monthly: 0 });
  assert.equal(keep.size, 7);
  assert.ok(keep.has("a-20260120"));
  assert.ok(keep.has("a-20260114"));
  assert.ok(!keep.has("a-20260113"));
  assert.equal(drop.length, 13);
});

test("weekly slots are filled by Sunday backups", () => {
  // Jan 2026: Sundays are the 4th, 11th, 18th, 25th.
  const artifacts = [];
  for (let d = 1; d <= 31; d++) {
    artifacts.push(art(`a-${d}`, `2026-01-${String(d).padStart(2, "0")}T03:00:00`));
  }
  const { keep } = planRetention(artifacts, { daily: 2, weekly: 3, monthly: 0 });
  assert.ok(keep.has("a-31")); // daily
  assert.ok(keep.has("a-30")); // daily
  assert.ok(keep.has("a-25")); // Sunday
  assert.ok(keep.has("a-18")); // Sunday
  assert.ok(keep.has("a-11")); // Sunday
  assert.ok(!keep.has("a-4")); // 4th Sunday, beyond weekly=3
});

test("monthly slots are filled by 1st-of-month backups; one artifact can satisfy multiple classes", () => {
  const artifacts = [
    art("feb1", "2026-02-01T03:00:00"), // Sunday AND the 1st
    art("jan1", "2026-01-01T03:00:00"),
    art("dec1", "2025-12-01T03:00:00"),
  ];
  const { keep, drop } = planRetention(artifacts, { daily: 1, weekly: 1, monthly: 2 });
  assert.ok(keep.has("feb1")); // daily + weekly + monthly all at once
  assert.ok(keep.has("jan1")); // second monthly
  assert.deepEqual(drop, ["dec1"]);
});

test("zero policy drops everything but is never negative", () => {
  const artifacts = [art("x", "2026-01-02T03:00:00")];
  const { keep, drop } = planRetention(artifacts, { daily: 0, weekly: 0, monthly: 0 });
  assert.equal(keep.size, 0);
  assert.deepEqual(drop, ["x"]);
});

test("dateFromArtifactName parses toolkit filenames", () => {
  const d = dateFromArtifactName("app-db-20260113-033000.sql.gz.enc");
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 0);
  assert.equal(d.getDate(), 13);
  assert.equal(d.getHours(), 3);
  assert.equal(d.getMinutes(), 30);
  assert.equal(dateFromArtifactName("nonsense.txt"), null);
});
