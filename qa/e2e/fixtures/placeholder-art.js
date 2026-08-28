/**
 * Deterministic, dependency-free placeholder art for promo screenshots
 * (promo.spec.js / promo.js). Pure string generation — no canvas, no
 * external image, no network fetch — so it works the same in CI and on a
 * dev machine, and never depends on real library images being present.
 *
 * Two shapes: portraitSvg (2:3, performer cards) and stillSvg (16:9, scene
 * cards). Both are abstract gradient/geometry compositions, deliberately
 * not a silhouette or a printed label — they need to read as "placeholder
 * art," not as a stand-in photo, in what's ultimately a public forum post.
 */

// Small fixed hue palette walked by index (not a raw hash-mod), so two
// seeds that hash close together still land on visually distinct hues
// rather than near-identical swatches next to each other in a leaderboard
// or h2h pair.
const PALETTE = [210, 265, 320, 15, 45, 165, 190, 285, 350, 130];

function hashSeed(seed) {
  let h = 0;
  const s = String(seed);
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function huesFor(seed) {
  const h = hashSeed(seed);
  const a = PALETTE[h % PALETTE.length];
  const b = PALETTE[(h + 3 + (h % 4)) % PALETTE.length];
  return [a, b];
}

/**
 * 2:3 portrait placeholder (400x600) — gradient + radial vignette + two
 * soft overlapping forms. Deterministic per `seed`.
 * @param {string|number} seed
 * @returns {string} SVG markup
 */
function portraitSvg(seed) {
  const [h1, h2] = huesFor(seed);
  const n = hashSeed(seed);
  const cx = 140 + (n % 120);
  const cy = 180 + ((n >> 4) % 160);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600" viewBox="0 0 400 600">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="hsl(${h1},55%,32%)"/>
      <stop offset="100%" stop-color="hsl(${h2},50%,20%)"/>
    </linearGradient>
    <radialGradient id="v" cx="50%" cy="38%" r="65%">
      <stop offset="0%" stop-color="hsl(${h1},60%,55%)" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="hsl(${h1},60%,55%)" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="400" height="600" fill="url(#g)"/>
  <circle cx="${cx}" cy="${cy}" r="150" fill="url(#v)"/>
  <path d="M -50 420 L 450 300 L 450 600 L -50 600 Z" fill="hsl(${h2},45%,18%)" fill-opacity="0.4"/>
  <circle cx="${400 - cx / 3}" cy="${cy / 2}" r="60" fill="hsl(${h1},60%,60%)" fill-opacity="0.15"/>
</svg>`;
}

/**
 * 16:9 scene-still placeholder (960x540) — same generator family but
 * horizontal banding instead of a centered vignette, so it reads distinct
 * from a portrait at a glance.
 * @param {string|number} seed
 * @returns {string} SVG markup
 */
function stillSvg(seed) {
  const [h1, h2] = huesFor(seed);
  const n = hashSeed(seed);
  const bandY = 180 + (n % 180);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="hsl(${h1},50%,22%)"/>
      <stop offset="100%" stop-color="hsl(${h2},45%,14%)"/>
    </linearGradient>
  </defs>
  <rect width="960" height="540" fill="url(#g)"/>
  <rect x="0" y="${bandY}" width="960" height="70" fill="hsl(${h1},55%,45%)" fill-opacity="0.18"/>
  <rect x="0" y="${bandY + 90}" width="960" height="24" fill="hsl(${h2},55%,55%)" fill-opacity="0.12"/>
  <circle cx="${120 + (n % 700)}" cy="${bandY - 60}" r="90" fill="hsl(${h1},60%,60%)" fill-opacity="0.12"/>
</svg>`;
}

/**
 * Wraps SVG markup as a data: URI for use as an image_path/screenshot path
 * in a promo fixture.
 * @param {string} svg
 * @returns {string}
 */
function svgDataUri(svg) {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

export { portraitSvg, stillSvg, svgDataUri };
