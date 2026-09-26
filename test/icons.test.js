import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { ICON_NAMES, MARK_SVG, icon, markSvg } from "../src/web/icons.js";

test("the status icons are one family: 16px grid, currentColor, decorative", () => {
  assert.deepEqual([...ICON_NAMES].sort(), ["fail", "ok", "warn"]);
  for (const name of ICON_NAMES) {
    const svg = icon(name);
    assert.match(svg, /^<svg class="i" viewBox="0 0 16 16" aria-hidden="true" focusable="false">/, name);
    assert.ok(!/#[0-9a-f]{3,6}/i.test(svg), `${name} takes its color from the text, never a fixed one`);
    assert.match(svg, /currentColor/, name);
  }
  assert.throws(() => icon("nope"), /unknown icon/);
});

test("the mark inline follows the page colors; the file carries its own light and dark", () => {
  const inline = markSvg({ size: 20 });
  assert.match(inline, /width="20" height="20"/);
  assert.match(inline, /fill="currentColor"/);
  assert.match(inline, /fill="var\(--good\)"/);
  assert.match(MARK_SVG, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  assert.match(MARK_SVG, /prefers-color-scheme:dark/);
  assert.match(MARK_SVG, /fill-rule="evenodd"/, "the slots are holes, so any background shows through");
});

test("docs/icon.svg is the same mark the dashboard serves", () => {
  // Regenerate with: node --input-type=module -e 'import { MARK_SVG } from
  // "./src/web/icons.js"; import fs from "node:fs"; fs.writeFileSync("docs/icon.svg", MARK_SVG)'
  const file = fs.readFileSync(new URL("../docs/icon.svg", import.meta.url), "utf8");
  assert.equal(file, MARK_SVG);
});

test("the dashboard renders no text symbols as icons", () => {
  // One icon family: a stray glyph renders in whatever font the browser picks
  // and sits beside drawn icons at a different weight.
  const source = fs.readFileSync(new URL("../src/web/ui.js", import.meta.url), "utf8");
  assert.ok(!/[✓✕✗⚠]|&#(9888|10003|10007);/.test(source));
});
