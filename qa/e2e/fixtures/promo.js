/**
 * Obfuscated performer/scene dataset for promo screenshots
 * (promo.spec.js) — invented names, generated placeholder art, and
 * realistic ratings/records/stats so the captured UI looks like a settled
 * library rather than an empty fixture pool. Never real library data.
 *
 * Builds on fixtures/graphql.js's performer()/scene() factories and
 * mockGraphQL rather than duplicating their field shapes, so this stays in
 * sync with whatever fields Xenith's own queries actually request.
 */
import { performer, scene, mockGraphQL } from "./graphql.js";
import { portraitSvg, stillSvg, svgDataUri } from "./placeholder-art.js";

// Zero overlap with real names by construction: invented first/last pairs,
// not drawn from any real-world name list.
const FIRST_NAMES = [
  "Wren", "Sable", "Marlowe", "Indigo", "Halcyon", "Vesper", "Juniper", "Cassian",
  "Odessa", "Thorne", "Marisol", "Amaranth", "Dashiell", "Solene", "Ravenna", "Corvin",
  "Wilder", "Seraphine", "Ambrose", "Talullah", "Fenwick", "Rosalind", "Zephyrine", "Orion",
  "Calder", "Meridian", "Briar", "Tamsin", "Alistair", "Nyssa", "Corliss", "Baxendale",
  "Winslow", "Delphine", "Rourke", "Isadora", "Kestrel", "Larkspur", "Sylvain", "Wrenna",
];
const LAST_NAMES = [
  "Ashford", "Vane", "Sorrel", "Crane", "Hollow", "Marsh", "Sterling", "Rook",
  "Thistlewood", "Farrow", "Blackwood", "Everhart", "Wren", "Calloway", "Fenn", "Dusk",
  "Halloway", "Vireo", "Corbin", "Larkin", "Sable", "Nightingale", "Wexford", "Bramwell",
  "Quill", "Ashby", "Solvig", "Merrick", "Talbot", "Fairweather", "Grovesnor", "Wintersby",
  "Cinder", "Halvard", "Osgood", "Rennick", "Vantage", "Wilmarth", "Yarrow", "Zephyr",
];
const STUDIOS = [
  "Lumen Reels", "Verdant Films", "Nightglass Studio", "Amberlight Pictures", "Cobalt Reel Co.",
  "Meridian Motion", "Driftwood Cinema", "Halcyon Frames", "Rook & Reel", "Solstice Pictures",
];
const TAG_POOL = [
  "Outdoor", "Roleplay", "Solo", "POV", "Vintage Style", "Cosplay", "Real Couple",
  "Massage", "Fitness", "Office", "Music Video", "Interview", "Behind the Scenes",
  "4K", "Amateur Style", "Storyline",
];
const VIDEO_CODECS = ["h264", "h265", "vp9"];
const AUDIO_CODECS = ["aac", "ac3", "opus"];

function nameFor(i) {
  const first = FIRST_NAMES[i % FIRST_NAMES.length];
  const last = LAST_NAMES[(i * 7) % LAST_NAMES.length];
  return `${first} ${last}`;
}

function titleFor(i) {
  const words = ["Afterglow", "Low Tide", "Neon Hour", "Static Bloom", "Quiet Static", "Velvet Dusk", "Paper Moon", "Ember Line"];
  return `${words[i % words.length]} ${((i % 12) + 1)}`;
}

// A tier-spread rating curve — S/A/B/C/D/F all populated so the leaderboard
// tier filter and TierDistribution accordion both have real bars to show,
// rather than one dominant bucket. See src/elo.js's TIER_BOUNDS for the
// bound values this walks across.
function ratingFor(i, n) {
  const t = i / (n - 1); // 0..1
  return Math.round(t * 100);
}

// Builds a plausible xenith_stats + xenith_record pair for one entity so
// MatchStats' records/streaks sections and BattleRankBadge's history
// drawer have real content instead of an empty state. Shapes match
// src/matchmaking.js's parseXenithStats/parseRecord contract.
function statsAndRecord(i, opponentIds, rating) {
  const totalMatches = 8 + (i % 40);
  const wins = Math.round(totalMatches * (0.35 + (rating / 100) * 0.4));
  const losses = totalMatches - wins;
  const currentStreak = (i % 5 === 0) ? -(2 + (i % 3)) : (i % 6);

  const xenith_stats = JSON.stringify({
    total_matches: totalMatches,
    wins,
    losses,
    current_streak: currentStreak,
    last_match: new Date(Date.now() - i * 3600_000).toISOString(),
  });

  const entries = Array.from({ length: Math.min(10, totalMatches) }, (_, j) => {
    const won = j % 3 !== 0;
    const opp = opponentIds[(i + j) % opponentIds.length];
    return {
      date: new Date(Date.now() - (j + 1) * 86_400_000).toISOString(),
      opponent: opp,
      won,
      ratingAfter: Math.max(0, Math.min(100, rating + (won ? 1 : -1) * (j + 1))),
    };
  });

  return { xenith_stats, xenith_record: JSON.stringify(entries) };
}

const N = 40;
const GENDER_CYCLE = ["FEMALE", "MALE", "NON_BINARY", "TRANSGENDER_FEMALE"];

const PERFORMER_NAMES = Array.from({ length: N }, (_, i) => `${i + 1}:${nameFor(i)}`);

const PROMO_PERFORMERS = Array.from({ length: N }, (_, i) => {
  const id = i + 1;
  const name = nameFor(i);
  const rating100 = ratingFor(i, N);
  const opponentIds = PERFORMER_NAMES.filter((_, j) => j !== i);
  const { xenith_stats, xenith_record } = statsAndRecord(i, opponentIds, rating100);
  return performer(id, {
    name,
    image_path: `/promo-art/p/${id}`,
    rating100,
    gender: GENDER_CYCLE[i % GENDER_CYCLE.length],
    custom_fields: { xenith_stats, xenith_record },
    favorite: i % 6 === 0,
    ethnicity: ["Caucasian", "Latina", "Asian", "Black", "Mixed"][i % 5],
    eye_color: ["Blue", "Brown", "Green", "Hazel"][i % 4],
    hair_color: ["Blonde", "Brunette", "Redhead", "Black"][i % 4],
    measurements: `${32 + (i % 6)}${["A", "B", "C", "D"][i % 4]}-${22 + (i % 5)}-${34 + (i % 6)}`,
    height_cm: 158 + (i % 20),
    weight: 50 + (i % 25),
    birthdate: `${1988 + (i % 15)}-0${(i % 9) + 1}-1${i % 9}`,
    scene_count: 4 + (i % 20),
    o_counter: i % 12,
    gallery_count: i % 4,
    tags: Array.from({ length: 3 + (i % 4) }, (_, k) => ({
      id: `pt${i}-${k}`,
      name: TAG_POOL[(i + k) % TAG_POOL.length],
      performer_count: 5 + ((i + k) % 40),
    })),
  });
});

const PROMO_SCENES = Array.from({ length: N }, (_, i) => {
  const id = 1000 + i;
  const title = titleFor(i);
  const rating100 = ratingFor((i + 5) % N, N);
  const opponentTitles = Array.from({ length: N }, (_, j) => `${1000 + j}:${titleFor(j)}`).filter((_, j) => j !== i);
  const { xenith_record } = statsAndRecord(i, opponentTitles, rating100);
  const studio = STUDIOS[i % STUDIOS.length];
  const performers = [
    { id: `sp${i}a`, name: nameFor(i), image_path: `/promo-art/p/sp${i}a`, favorite: i % 5 === 0, scene_count: 8 },
    { id: `sp${i}b`, name: nameFor(i + 17), image_path: `/promo-art/p/sp${i}b`, favorite: false, scene_count: 3 },
  ];
  return scene(id, {
    title,
    rating100,
    date: `2025-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 27) + 1).padStart(2, "0")}`,
    custom_fields: { xenith_record },
    paths: {
      screenshot: `/promo-art/s/${id}`,
      preview: `/promo-art/s/${id}`,
      stream: `/promo-art/s/${id}`,
      webp: null, vtt: null, sprite: null, funscript: null, interactive_heatmap: null, caption: null,
    },
    files: [{
      id: String(id),
      duration: 600 + (i % 40) * 60,
      filesize: 800_000_000 + i * 40_000_000,
      size: 800_000_000 + i * 40_000_000,
      video_codec: VIDEO_CODECS[i % VIDEO_CODECS.length],
      audio_codec: AUDIO_CODECS[i % AUDIO_CODECS.length],
      width: i % 3 === 0 ? 3840 : 1920,
      height: i % 3 === 0 ? 2160 : 1080,
      frame_rate: [23.98, 24, 25, 29.97, 30][i % 5],
      bit_rate: 6_000_000 + i * 250_000,
      fingerprints: [],
    }],
    performers,
    studio: { id: `studio-${studio}`, name: studio, image_path: null },
    o_counter: i % 10,
    play_count: i % 15,
    groups: i % 4 === 0 ? [{ group: { id: `g${i}`, name: `${studio} Collection` } }] : [],
    galleries: [],
    scene_markers: i % 3 === 0 ? [{ id: `m${i}a` }] : [],
    tags: Array.from({ length: 3 + (i % 4) }, (_, k) => ({
      id: `st${i}-${k}`,
      name: TAG_POOL[(i + k + 2) % TAG_POOL.length],
      scene_count: 5 + ((i + k) % 40),
    })),
  });
});

/**
 * Route handler for the synthetic /promo-art/{p,s}/{id} image URLs used by
 * PROMO_PERFORMERS/PROMO_SCENES — fulfills with a generated SVG rather than
 * a real image. Registered before mockGraphQL so ordering is unambiguous
 * (distinct route pattern, so order doesn't actually matter for matching,
 * but keeping images first mirrors how a page actually resolves image
 * requests before/alongside data).
 * @param {import('@playwright/test').Page} page
 */
async function mockPromoImages(page) {
  await page.route("**/promo-art/**", async (route) => {
    const url = new URL(route.request().url());
    const [, , kind, id] = url.pathname.split("/"); // "", "promo-art", "p"|"s", id
    const svg = kind === "p" ? portraitSvg(id) : stillSvg(id);
    await route.fulfill({ status: 200, contentType: "image/svg+xml", body: svg });
  });
}

/**
 * One-call setup for a promo capture: wires the image route plus
 * mockGraphQL with the full obfuscated performer/scene pool.
 * @param {import('@playwright/test').Page} page
 * @param {{ performers?: any[], scenes?: any[] }} [overrides] passed through
 *   to mockGraphQL, e.g. from withRealDetailId/withRealGridIds below.
 */
async function mockPromo(page, overrides = {}) {
  await mockPromoImages(page);
  return mockGraphQL(page, {
    performers: overrides.performers || PROMO_PERFORMERS,
    scenes: overrides.scenes || PROMO_SCENES,
  });
}

/**
 * Swaps PROMO_PERFORMERS[0]'s id for a real id from the live Stash
 * instance. Only needed for captures that navigate to a native Stash page
 * (e.g. /performers/:id) — Stash core's own detail-page query isn't
 * mocked (see fixtures/graphql.js's header comment) and 404s on a
 * synthetic id, so the promo pool needs to "be" a real performer for that
 * one test. Everything else about the entry (name, rating, stats, record)
 * stays the invented promo data; scrubNativePage still replaces the real
 * name/image Stash core itself renders.
 * @param {string} realId
 * @returns {any[]}
 */
function withRealDetailId(realId) {
  return [{ ...PROMO_PERFORMERS[0], id: realId }, ...PROMO_PERFORMERS.slice(1)];
}

/**
 * Maps the first N real ids (in whatever order the live grid actually
 * renders them) onto the first N PROMO_PERFORMERS entries. Needed for the
 * performer-grid capture: Xenith's .hon-compact-badge only overlays a card
 * whose real id is present in the mocked FindPerformersRank pool, and the
 * grid page is real, unmocked Stash-core content — without this, none of
 * the real ids on screen coincidentally match the synthetic 1..40 pool, so
 * no badge ever renders. Everything else about each entry (name, rating,
 * stats, record) stays the invented promo data.
 * @param {string[]} realIds ids in on-screen order, most-recent-first slice
 * @returns {any[]}
 */
function withRealGridIds(realIds) {
  return PROMO_PERFORMERS.map((p, i) => (realIds[i] ? { ...p, id: realIds[i] } : p));
}

/**
 * Same trick as withRealGridIds, for the /scenes grid (used by the
 * promo-mobile project's rank-badges capture — mobile can't fit a full 2:3
 * performer card on screen, so that capture uses 16:9 scene cards instead).
 * @param {string[]} realIds
 * @returns {any[]}
 */
function withRealSceneGridIds(realIds) {
  return PROMO_SCENES.map((s, i) => (realIds[i] ? { ...s, id: realIds[i] } : s));
}

export {
  PROMO_PERFORMERS,
  PROMO_SCENES,
  mockPromoImages,
  mockPromo,
  withRealDetailId,
  withRealGridIds,
  withRealSceneGridIds,
  nameFor,
  titleFor,
  svgDataUri,
};
