/**
 * The project mark and the dashboard's status icons.
 *
 * One family, drawn here as inline SVG so the dashboard keeps its rule of no
 * external assets: the strict CSP allows nothing to be fetched, and none of
 * this needs to be.
 *
 * The mark is a two-unit server box with one green status light: a single
 * box, and it is up. The slots are holes (even-odd fill), so the mark sits on
 * any background without a second color to keep in step with it.
 *
 * Status icons share a 16px grid, a 2px round-capped stroke and
 * currentColor, so they take the pill's own status color. They are always
 * shown beside the status word and hidden from screen readers: status is
 * never carried by an icon or a color alone.
 */

// Geometry on a 32px grid. Each unit is a rounded rectangle with its slot cut
// out; the light sits on the upper unit only, and is sized to stay a visible
// dot at 16px.
const UNITS =
  "M6 3.5h20a3 3 0 0 1 3 3v5.5a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6.5a3 3 0 0 1 3-3Z" +
  "M8.5 8.25h7a1 1 0 0 1 0 2h-7a1 1 0 0 1 0-2Z" +
  "M6 17h20a3 3 0 0 1 3 3v5.5a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V20a3 3 0 0 1 3-3Z" +
  "M8.5 21.75h7a1 1 0 0 1 0 2h-7a1 1 0 0 1 0-2Z";
const LIGHT = { cx: 23.25, cy: 9.25, r: 2.75 };
const GOOD = "#0ca30c";

/**
 * The mark as a standalone file: the favicon, and docs/icon.svg in the repo.
 * It carries its own light/dark rule because a browser tab does not share the
 * page's stylesheet.
 */
export const MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
<style>.box{fill:#0b0b0b}@media (prefers-color-scheme:dark){.box{fill:#fff}}</style>
<path class="box" fill-rule="evenodd" d="${UNITS}"/>
<circle cx="${LIGHT.cx}" cy="${LIGHT.cy}" r="${LIGHT.r}" fill="${GOOD}"/>
</svg>
`;

/** The mark inline in a page, in the surrounding text color. */
export function markSvg({ size = 20 } = {}) {
  return `<svg class="mark" width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path fill="currentColor" fill-rule="evenodd" d="${UNITS}"/><circle cx="${LIGHT.cx}" cy="${LIGHT.cy}" r="${LIGHT.r}" fill="var(--good)"/></svg>`;
}

const STROKE = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';

const ICONS = {
  ok: `<path ${STROKE} d="M3.25 8.5l3 3 6.5-7"/>`,
  warn: `<path ${STROKE} stroke-width="1.75" d="M8 2.75 14.25 13.25H1.75Z"/><path ${STROKE} stroke-width="1.75" d="M8 6.75v2.75"/><circle cx="8" cy="11.4" r="1" fill="currentColor"/>`,
  fail: `<path ${STROKE} d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>`,
};

/** Names in the status icon set. */
export const ICON_NAMES = Object.freeze(Object.keys(ICONS));

/** One status icon, inline, 1em square, decorative. */
export function icon(name) {
  const body = ICONS[name];
  if (!body) throw new Error(`unknown icon "${name}"`);
  return `<svg class="i" viewBox="0 0 16 16" aria-hidden="true" focusable="false">${body}</svg>`;
}
