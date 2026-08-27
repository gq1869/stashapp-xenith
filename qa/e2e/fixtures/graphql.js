/**
 * Deterministic performer/scene fixtures + a GraphQL route mocker.
 *
 * Xenith always POSTs to same-origin /graphql (src/api.js's execGraphQL).
 * We intercept that route but only mock Xenith's own queries/mutations plus
 * its one unnamed config query — everything else passes through untouched,
 * since this route also carries Stash's own core UI traffic.
 *
 * IMPORTANT: matching is done on the literal query TEXT, not the GraphQL
 * operation name. Stash's own core UI (performer list, performer detail's
 * related-scenes panel, etc.) issues its own queries that happen to be
 * named "FindPerformers" / "FindScenes" too — GraphQL operation names
 * aren't namespaced, so name collisions are real. Matching by name alone
 * previously caused this route to swallow Stash's own requests and hand
 * back Xenith's stripped-down fixture shape, which is missing fields
 * Stash's ListTable/SceneList components expect — that's what produced
 * the "Cannot read properties of undefined (reading 'map')" crash and
 * Stash's own error boundary ("Something went wrong.") on the performer
 * page. Matching the exact query body (imported directly from src/api.js
 * below) means a same-named-but-different Stash-core query is never
 * mistaken for one of ours.
 */
import {
  FIND_PERFORMERS_CANDIDATES,
  FIND_SCENES_CANDIDATES,
  FIND_PERFORMERS_BY_IDS,
  FIND_SCENES_BY_IDS,
  UPDATE_PERFORMER,
  UPDATE_SCENE,
  FIND_PERFORMERS_RANK,
  FIND_SCENES_RANK,
} from "../../../src/api.js";

function normalize(query) {
  return query.replace(/\s+/g, " ").trim();
}

// Maps a normalized query body -> the friendly operation label the rest of
// the test suite asserts on (gql.requests[].operation).
const XENITH_QUERIES = new Map([
  [normalize(FIND_PERFORMERS_CANDIDATES), "FindPerformersCandidates"],
  [normalize(FIND_SCENES_CANDIDATES), "FindScenesCandidates"],
  [normalize(FIND_PERFORMERS_BY_IDS), "FindPerformersByIds"],
  [normalize(FIND_SCENES_BY_IDS), "FindScenesByIds"],
  [normalize(UPDATE_PERFORMER), "UpdatePerformer"],
  [normalize(UPDATE_SCENE), "UpdateScene"],
  [normalize(FIND_PERFORMERS_RANK), "FindPerformersRank"],
  [normalize(FIND_SCENES_RANK), "FindScenesRank"],
]);

// Matches exactly badge-injector.js's `query { configuration { plugins } }`
// — not just any query that happens to mention "configuration" anywhere,
// which is loose enough to also catch Stash's own real config query.
const XENITH_CONFIG_QUERY = /^\s*query\s*\{\s*configuration\s*\{\s*plugins\s*\}\s*\}\s*$/;

function performer(id, overrides = {}) {
  // Default stats structure matching the real payload
  const defaultStats = JSON.stringify({
    total_matches: 0,
    wins: 0,
    losses: 0,
    current_streak: 0,
    last_match: new Date().toISOString()
  });

  return {
    id: String(id),
    name: `Performer ${id}`,
    disambiguation: null,
    image_path: null,
    rating100: 50,
    // Ensure custom_fields matches the expected real-world shape
    custom_fields: {
      xenith_stats: defaultStats,
      xenith_record: "[]"
    },
    gender: "FEMALE",
    country: "US",
    height_cm: 170,
    weight: 63,
    birthdate: null,
    death_date: null,
    favorite: false,
    urls: [],
    scene_count: 0,
    image_count: 0,
    gallery_count: 0,
    group_count: 0,
    o_counter: 0,
    tags: [],
    // fake_tits defaults to null (unset) so the default fixture exercises
    // card-chips.js's classifyBreasts *unrecognized* branch — no chip.
    ethnicity: null,
    eye_color: null,
    hair_color: null,
    measurements: null,
    fake_tits: null,
    tattoos: null,
    piercings: null,
    ...overrides,
  };
}

function scene(id, overrides = {}) {
  return {
    id: String(id),
    title: `Scene ${id}`,
    code: null,
    date: "2026-01-01",
    rating100: 50,
    // xenith_record only, no xenith_stats default here — unlike performer()
    // above, no existing test asserts on a scene's stats shape, and adding
    // one isn't part of this fixture's purpose.
    custom_fields: { xenith_record: "[]" },
    organized: false,
    o_counter: 0,
    play_count: 0,
    resume_time: 0,
    play_duration: 0,
    filesize: 1911195357, // Matches real data (number, not string)
    files: [{
      id: String(id), // Often required
      duration: 1443.95, // Matches your real data type
      filesize: 1911195357, // Matches real data (number, not string)
      size: 1911195357,
      video_codec: "h264",
      audio_codec: "ac3",
      width: 1920,
      height: 1080,
      frame_rate: 23.98,
      bit_rate: 10588728,
      fingerprints: [],
    }],
    paths: {
      screenshot: `http://localhost:9999/scene/${id}/screenshot`,
      preview: `http://localhost:9999/scene/${id}/preview`,
      stream: `http://localhost:9999/scene/${id}/stream`,
      webp: `http://localhost:9999/scene/${id}/webp`,
      vtt: null,
      sprite: null,
      funscript: null,
      interactive_heatmap: null,
      caption: null,
    },
    performers: [],
    studio: null,
    tags: [],
    groups: [],
    galleries: [],
    scene_markers: [],
    stash_ids: [],
    ...overrides,
  };
}

const PERFORMERS = Array.from({ length: 30 }, (_, i) => performer(i + 1, { rating100: 20 + i * 2 }));
const SCENES = Array.from({ length: 30 }, (_, i) => scene(i + 1, { rating100: 20 + i * 2 }));

// Every chip-eligible field set plus 40 tags, enough to overflow the fixed
// chip-row budget no matter which two performers get selected as a pair.
// Shared by xenith.spec.js's chip-height test and device-review.spec.js's
// mobile-portrait capture — the worst case for both.
function richPerformers(base = PERFORMERS) {
  const richTags = Array.from({ length: 40 }, (_, i) => ({ id: `t${i}`, name: `Tag ${i}`, performer_count: i }));
  return base.map((p) => ({
    ...p,
    favorite: true,
    ethnicity: "Caucasian",
    eye_color: "Blue",
    hair_color: "Blonde",
    measurements: "34C-24-36",
    fake_tits: "Yes",
    scene_count: 12,
    o_counter: 5,
    gallery_count: 3,
    tattoos: "Sleeve",
    piercings: "Navel",
    tags: richTags,
  }));
}

// Every chip-eligible field set plus 40 tags, enough to overflow the fixed
// chip-row budget no matter which two scenes get selected as a pair
// (same rationale as richPerformers above).
function richScenes(base = SCENES) {
  const richTags = Array.from({ length: 40 }, (_, i) => ({ id: `st${i}`, name: `Tag ${i}`, scene_count: i }));
  return base.map((s, i) => ({
    ...s,
    performers: [
      { id: `sp${i}a`, name: `Scene Performer ${i}a`, image_path: null, favorite: false, scene_count: 12 },
      { id: `sp${i}b`, name: `Scene Performer ${i}b`, image_path: null, favorite: false, scene_count: 3 },
    ],
    studio: { id: `studio${i}`, name: `Studio ${i}`, image_path: null },
    o_counter: 3,
    play_count: 2,
    groups: [{ group: { id: `g${i}`, name: `Group ${i}` } }],
    galleries: [{ id: `gal${i}` }],
    scene_markers: [{ id: `m${i}a` }, { id: `m${i}b` }],
    tags: richTags,
  }));
}

/**
 * Attaches a page.route handler for /graphql that serves the fixtures
 * above and records every request so tests can assert on the variables
 * Xenith actually sent (e.g. per_page for the scene-sampling check).
 *
 * Only requests whose query body exactly matches one of Xenith's own four
 * templates (or its config query) get mocked. Everything else — including
 * Stash's own core UI queries, even ones that happen to share an operation
 * name with Xenith's — passes straight through via route.continue().
 *
 * @param {import('@playwright/test').Page} page
 * @param {{ performers?: any[], scenes?: any[] }} [overrides] Substitute
 *   performer/scene pools for this test only, e.g. to inject a specific
 *   rating100 value deterministically. Defaults to the shared PERFORMERS/
 *   SCENES fixtures.
 * @returns {{ requests: Array<{operation: string, variables: any}> }}
 */
async function mockGraphQL(page, overrides = {}) {
  const state = { requests: [] };
  const performers = overrides.performers || PERFORMERS;
  const scenes = overrides.scenes || SCENES;

  await page.route("**/graphql", async (route) => {
    const req = route.request();
    const body = req.postDataJSON();
    const query = body?.query || "";
    const variables = body?.variables || {};

    const operation = XENITH_QUERIES.get(normalize(query));
    const isXenithConfigQuery = !operation && XENITH_CONFIG_QUERY.test(query);

    if (!operation && !isXenithConfigQuery) {
      // Not one of Xenith's own query bodies — even if it happens to share
      // an operation name with one of ours (Stash's core UI does), it's
      // not ours to answer. Let it hit the real server.
      await route.continue();
      return;
    }

    state.requests.push({ operation: operation || "XenithConfig", variables });

    let data = {};
    if (operation === "FindPerformersCandidates" || operation === "FindPerformersRank") {
      data = { findPerformers: { count: performers.length, performers } };
    } else if (operation === "FindPerformersByIds") {
      const ids = new Set((variables.ids || []).map(String));
      data = { findPerformers: { performers: performers.filter((p) => ids.has(String(p.id))) } };
    } else if (operation === "FindScenesCandidates" || operation === "FindScenesRank") {
      data = { findScenes: { count: scenes.length, scenes } };
    } else if (operation === "FindScenesByIds") {
      const ids = new Set((variables.ids || []).map(String));
      data = { findScenes: { scenes: scenes.filter((s) => ids.has(String(s.id))) } };
    } else if (operation === "UpdatePerformer") {
      data = { performerUpdate: { id: variables.id } };
    } else if (operation === "UpdateScene") {
      data = { sceneUpdate: { id: variables.id } };
    } else if (isXenithConfigQuery) {
      data = { configuration: { plugins: { xenith: { HideXenRankBadge: false } } } };
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data }),
    });
  });

  return state;
}

export { mockGraphQL, performer, scene, PERFORMERS, SCENES, richPerformers, richScenes };
