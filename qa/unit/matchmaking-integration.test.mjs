// Integration-style coverage for the hands-on checks in qa/README.md that
// only show up across an extended session of real selectWeightedPair()
// calls — not exercisable by matchmaking.js's already-unit-tested pure
// helpers alone. Mocks src/api.js's gql() so selectWeightedPair runs its
// full seed/opponent weighting and cooldown logic against an in-memory
// pool instead of a live Stash GraphQL endpoint.
import { vi, test, describe, beforeEach } from "vitest";
import assert from "node:assert/strict";

import { getRatingTier } from "../../src/elo.js";
import { MIN_MATCHES, MIN_LADDER, applyResult } from "../../src/gauntlet.js";
import { invalidateRankCache } from "../../src/rank-cache.js";

vi.mock("../../src/api.js", () => ({
  gql: async (query, variables) => mockGql(query, variables),
  gqlMutate: async () => ({}),
  FIND_PERFORMERS_CANDIDATES: "FIND_PERFORMERS_CANDIDATES",
  FIND_SCENES_CANDIDATES: "FIND_SCENES_CANDIDATES",
  FIND_PERFORMERS_BY_IDS: "FIND_PERFORMERS_BY_IDS",
  FIND_SCENES_BY_IDS: "FIND_SCENES_BY_IDS",
  COUNT_PERFORMERS: "COUNT_PERFORMERS",
  COUNT_SCENES: "COUNT_SCENES",
  FIND_PERFORMERS_RANK: "FIND_PERFORMERS_RANK",
  FIND_SCENES_RANK: "FIND_SCENES_RANK",
  PERFORMER_FIELDS: "",
  SCENE_FIELDS: "",
}));

const {
  selectWeightedPair,
  trackSelection,
  addToRecentlySelected,
  isRecentlySelected,
  pushToRecentMatchBuffer,
  isInRecentMatchBuffer,
  updateStatsAfterMatch,
  serializeStats,
  startGauntletRun,
  selectGauntletPair,
  selectChampionPair,
} = await import("../../src/matchmaking.js");
const { persisted } = await import("../../src/state.js");

let performerPool = [];
let scenePool = [];
// Simulates a library bigger than FIND_*_CANDIDATES's 500-item cap: ids
// listed here are excluded from the *_CANDIDATES responses (as if they
// simply didn't land in this call's random sample) but still resolve via
// FIND_*_BY_IDS, same as a real oversized library would behave. Reset in
// each describe block's beforeEach.
let candidatesExcludeIds = [];

function mockGql(query, variables) {
  if (query === "FIND_PERFORMERS_CANDIDATES") {
    const performers = performerPool.filter((p) => !candidatesExcludeIds.includes(p.id));
    return { findPerformers: { count: performers.length, performers } };
  }
  if (query === "FIND_PERFORMERS_BY_IDS") {
    const ids = new Set(variables.ids);
    return { findPerformers: { performers: performerPool.filter((p) => ids.has(p.id)) } };
  }
  if (query === "COUNT_PERFORMERS") {
    return { findPerformers: { count: performerPool.length } };
  }
  if (query === "FIND_SCENES_CANDIDATES") {
    return { findScenes: { count: scenePool.length, scenes: scenePool } };
  }
  if (query === "FIND_SCENES_BY_IDS") {
    const ids = new Set(variables.ids);
    return { findScenes: { scenes: scenePool.filter((s) => ids.has(s.id)) } };
  }
  if (query === "COUNT_SCENES") {
    return { findScenes: { count: scenePool.length } };
  }
  if (query === "FIND_PERFORMERS_RANK") {
    return { findPerformers: { count: performerPool.length, performers: performerPool } };
  }
  if (query === "FIND_SCENES_RANK") {
    return { findScenes: { count: scenePool.length, scenes: scenePool } };
  }
  throw new Error(`unexpected query in mockGql: ${query}`);
}

// Tier-heavy pool: 70 C/D performers vs. a handful of S/A/B/F, mirroring
// the checklist's "mostly C/D" extended-session scenario. Minority tiers are
// kept small on purpose — this isolates entropy weighting + cross-tier
// events as the surfacing mechanism, now that matchmaking is tier-agnostic
// with no tier-rotation gate steering selection.
function makePerformer(id, rating, gender) {
  return { id: String(id), name: `P${id}`, rating100: rating, gender, custom_fields: {} };
}

// A gendered pool for Gauntlet ladder-filtering coverage. 20 FEMALE,
// 20 MALE, 8 NON_BINARY (kept above MIN_LADDER individually so a
// single-gender filter still yields a startable ladder once the challenger
// is excluded), plus a handful with no gender set at all (mirrors a
// poorly-tagged library — matchesGenderFilter excludes these under any
// active filter, same as Stash's own server-side INCLUDES modifier).
function buildGenderedPool() {
  const pool = [];
  let id = 2001; // disjoint from buildTierHeavyPool/buildTierHeavyScenePool's ranges
  for (let i = 0; i < 20; i++) pool.push(makePerformer(id++, 30 + i, "FEMALE"));
  for (let i = 0; i < 20; i++) pool.push(makePerformer(id++, 30 + i, "MALE"));
  for (let i = 0; i < 8; i++) pool.push(makePerformer(id++, 30 + i, "NON_BINARY"));
  for (let i = 0; i < 3; i++) pool.push(makePerformer(id++, 30 + i, undefined));
  return pool;
}

function buildTierHeavyPool() {
  const pool = [];
  let id = 1;
  for (let i = 0; i < 40; i++) pool.push(makePerformer(id++, 26 + (i % 32))); // C
  for (let i = 0; i < 30; i++) pool.push(makePerformer(id++, 7 + (i % 19))); // D
  for (let i = 0; i < 4; i++) pool.push(makePerformer(id++, 90)); // A
  for (let i = 0; i < 4; i++) pool.push(makePerformer(id++, 100)); // S
  for (let i = 0; i < 4; i++) pool.push(makePerformer(id++, 65)); // B
  for (let i = 0; i < 4; i++) pool.push(makePerformer(id++, 3)); // F
  return pool;
}

// Scene equivalent of makePerformer/buildTierHeavyPool above — same shape
// (id/rating/tier distribution), but with `title` instead of `name`, since
// that's the only field selectWeightedPair's scene branch reads differently.
function makeScene(id, rating) {
  return { id: String(id), title: `Scene ${id}`, rating100: rating, custom_fields: {} };
}

function buildTierHeavyScenePool() {
  const pool = [];
  let id = 1001; // disjoint id range from buildTierHeavyPool, so the two pools never collide by accident
  for (let i = 0; i < 40; i++) pool.push(makeScene(id++, 26 + (i % 32))); // C
  for (let i = 0; i < 30; i++) pool.push(makeScene(id++, 7 + (i % 19))); // D
  for (let i = 0; i < 4; i++) pool.push(makeScene(id++, 90)); // A
  for (let i = 0; i < 4; i++) pool.push(makeScene(id++, 100)); // S
  for (let i = 0; i < 4; i++) pool.push(makeScene(id++, 65)); // B
  for (let i = 0; i < 4; i++) pool.push(makeScene(id++, 3)); // F
  return pool;
}

function resetPersisted() {
  persisted.sessionMatchCounts = { performers: {}, scenes: {} };
  persisted.recentlySelected = { performers: [], scenes: [] };
  persisted.recentMatchBuffer = { performers: [], scenes: [] };
}

// Mirrors usePair.js's commitMatch: records the match against both the
// live in-memory pool item (so match counts/uncertainty evolve) and the
// session trackers matchmaking.js reads from `persisted`.
function commitMatch(battleType, itemA, itemB) {
  trackSelection(battleType, itemA.id);
  trackSelection(battleType, itemB.id);
  addToRecentlySelected(battleType, itemA.id);
  addToRecentlySelected(battleType, itemB.id);
  pushToRecentMatchBuffer(battleType, [itemA.id, itemB.id]);

  for (const item of [itemA, itemB]) {
    const stats = JSON.parse(item.custom_fields.xenith_stats || "{}");
    const updated = updateStatsAfterMatch(
      { total_matches: 0, wins: 0, losses: 0, current_streak: 0, best_streak: 0, worst_streak: 0, last_match: null, ...stats },
      true
    );
    item.custom_fields = { ...item.custom_fields, ...serializeStats(updated) };
  }
}

describe("selectWeightedPair — extended session behavior", () => {
  beforeEach(() => {
    performerPool = buildTierHeavyPool();
    scenePool = [];
    candidatesExcludeIds = [];
    resetPersisted();
  });

  test("a performer just matched doesn't reappear as a candidate until it ages out of the 20-match cooldown buffer", async () => {
    for (let i = 0; i < 40; i++) {
      const bufferBeforeThisMatch = new Set(persisted.recentMatchBuffer.performers.flat());
      const { pair } = await selectWeightedPair("performers", []);
      const [seed, opponent] = pair;

      assert.notEqual(seed.id, opponent.id, "seed and opponent must be distinct");
      // Neither side of a freshly-selected pair should have been sitting in
      // the cooldown buffer at selection time — selectWeightedPair filters
      // cooldown-buffered candidates out before it can pick them, and the
      // pool (86 performers) is large enough that fallback-to-full-pool
      // never has to kick in.
      assert.ok(!bufferBeforeThisMatch.has(seed.id), `seed ${seed.id} was selected while still in cooldown`);
      assert.ok(!bufferBeforeThisMatch.has(opponent.id), `opponent ${opponent.id} was selected while still in cooldown`);

      commitMatch("performers", seed, opponent);
    }

    assert.equal(persisted.recentMatchBuffer.performers.length, 20, "cooldown buffer caps at 20 entries");
  });

  test("extended session in a C/D-heavy pool occasionally surfaces performers from other tiers (entropy weighting + cross-tier events)", async () => {
    // 150 matches, not 40: cross-tier events are only a 10% per-match roll
    // (XENITH.md's match-selection section), so a 40-match run has a ~1.5% chance of
    // rolling zero even when the mechanism is working correctly — a real
    // but not CI-safe flake rate. 150 matches drops that false-negative
    // chance to statistically negligible while still being well within the
    // checklist's "30+ matches" extended-session scope.
    const seenTiers = new Set();
    for (let i = 0; i < 150; i++) {
      const { pair } = await selectWeightedPair("performers", []);
      for (const p of pair) seenTiers.add(getRatingTier(p.rating100));
      commitMatch("performers", pair[0], pair[1]);
    }

    // Pool is deliberately C/D-heavy (70 of 86 performers) — a healthy
    // matchmaking session should still touch at least one minority tier
    // (S/A/B/F) instead of getting stuck exclusively on the dominant tiers.
    const minorityTiersSeen = ["S", "A", "B", "F"].filter((t) => seenTiers.has(t));
    assert.ok(
      minorityTiersSeen.length > 0,
      `expected at least one minority tier to surface across an extended session, saw only: ${[...seenTiers].join(", ")}`
    );
  });

  test("extended session doesn't get stuck repeating the same few faces — a reasonable fraction of the pool gets touched", async () => {
    const seenIds = new Set();
    for (let i = 0; i < 40; i++) {
      const { pair } = await selectWeightedPair("performers", []);
      seenIds.add(pair[0].id);
      seenIds.add(pair[1].id);
      commitMatch("performers", pair[0], pair[1]);
    }

    // 40 matches touch up to 80 slots; with the session repeat-opponent
    // penalty and cooldown buffer both discouraging reselection, this
    // should spread across a healthy chunk of the 86-performer pool rather
    // than looping over a tiny clique.
    assert.ok(
      seenIds.size >= 30,
      `expected a broad spread of distinct performers over 40 matches, got only ${seenIds.size}`
    );
  });

  test("scenes: extended session in a C/D-heavy pool occasionally surfaces scenes from other tiers (entropy weighting + cross-tier events)", async () => {
    scenePool = buildTierHeavyScenePool();
    const seenTiers = new Set();
    for (let i = 0; i < 150; i++) {
      const { pair } = await selectWeightedPair("scenes", []);
      for (const s of pair) seenTiers.add(getRatingTier(s.rating100));
      commitMatch("scenes", pair[0], pair[1]);
    }

    const minorityTiersSeen = ["S", "A", "B", "F"].filter((t) => seenTiers.has(t));
    assert.ok(
      minorityTiersSeen.length > 0,
      `expected at least one minority tier to surface across an extended scene session, saw only: ${[...seenTiers].join(", ")}`
    );
  });

  test("scenes: extended session doesn't get stuck repeating the same few titles — a reasonable fraction of the pool gets touched", async () => {
    scenePool = buildTierHeavyScenePool();
    const seenIds = new Set();
    for (let i = 0; i < 40; i++) {
      const { pair } = await selectWeightedPair("scenes", []);
      seenIds.add(pair[0].id);
      seenIds.add(pair[1].id);
      commitMatch("scenes", pair[0], pair[1]);
    }

    assert.ok(
      seenIds.size >= 30,
      `expected a broad spread of distinct scenes over 40 matches, got only ${seenIds.size}`
    );
  });

  test("switching Performers <-> Scenes mid-session doesn't cross-contaminate the cooldown buffer, even with colliding numeric ids", async () => {
    // Scene pool intentionally reuses the same numeric ids as the performer
    // pool — Stash ids aren't namespaced by entity type, so this is the
    // exact collision scenario the per-battle-type sub-buffers guard against.
    scenePool = performerPool.map((p) => ({ id: p.id, title: `Scene ${p.id}`, rating100: p.rating100, custom_fields: {} }));

    const { pair: performerPair } = await selectWeightedPair("performers", []);
    commitMatch("performers", performerPair[0], performerPair[1]);

    // Pick a scene pair guaranteed disjoint (by id) from the performer pair
    // just committed, so any leakage between sub-buffers is unambiguous.
    const excludedIds = new Set(performerPair.map((p) => p.id));
    const disjointScenePool = scenePool.filter((s) => !excludedIds.has(s.id));
    const sceneItemA = disjointScenePool[0];
    const sceneItemB = disjointScenePool[1];
    commitMatch("scenes", sceneItemA, sceneItemB);

    assert.ok(
      isInRecentMatchBuffer("performers", performerPair[0].id),
      "performer cooldown buffer should hold the performer id"
    );
    assert.ok(
      !isInRecentMatchBuffer("scenes", performerPair[0].id),
      "a performer-only match must not leak into the scenes cooldown buffer, even though a scene shares that numeric id"
    );
    assert.ok(
      isInRecentMatchBuffer("scenes", sceneItemA.id),
      "scene cooldown buffer should hold the scene id"
    );
    assert.ok(
      !isInRecentMatchBuffer("performers", sceneItemA.id),
      "a scene-only match must not leak into the performers cooldown buffer"
    );

    // Same collision scenario, for the other two session-scoped stores.
    assert.equal(
      persisted.sessionMatchCounts.performers[performerPair[0].id],
      1,
      "performer session match count should be tracked under performers"
    );
    assert.equal(
      persisted.sessionMatchCounts.scenes[performerPair[0].id] || 0,
      0,
      "a performer-only match must not leak into the scenes session match counts, even though a scene shares that numeric id"
    );
    assert.ok(
      isRecentlySelected("performers", performerPair[0].id),
      "performer recency list should hold the performer id"
    );
    assert.ok(
      !isRecentlySelected("scenes", performerPair[0].id),
      "a performer-only match must not leak into the scenes recency list, even though a scene shares that numeric id"
    );
    assert.equal(
      persisted.sessionMatchCounts.scenes[sceneItemA.id],
      1,
      "scene session match count should be tracked under scenes"
    );
    assert.equal(
      persisted.sessionMatchCounts.performers[sceneItemA.id] || 0,
      0,
      "a scene-only match must not leak into the performers session match counts"
    );
  });
});

describe("gauntlet selection — extended run behavior", () => {
  beforeEach(() => {
    performerPool = buildTierHeavyPool();
    scenePool = buildTierHeavyScenePool();
    candidatesExcludeIds = [];
    resetPersisted();
    invalidateRankCache(); // rank-cache.js's own 60s-TTL cache, separate from the mocked-api pools above
  });

  test("never self-matches and never repeats a faced opponent within one run", async () => {
    const challenger = performerPool[0];
    let run = await startGauntletRun("performers", challenger, []);
    const faced = new Set();
    let guard = 0;

    while (guard < MIN_MATCHES) {
      const result = await selectGauntletPair("performers", run);
      assert.ok(result, "expected a probe while the run is still short of MIN_MATCHES");
      const [challengerHydrated, probeHydrated] = result.pair;

      assert.notEqual(challengerHydrated.id, probeHydrated.id, "challenger must not face itself");
      assert.ok(!faced.has(probeHydrated.id), `probe ${probeHydrated.id} was already faced this run`);
      faced.add(probeHydrated.id);

      run = applyResult(run, { probeIndex: result.probeIndex, outcome: guard % 2 === 0 ? 1 : 0 });
      guard++;
    }
  });

  test("the challenger is re-fetched from the pool on every probe, not held from run start", async () => {
    const challenger = performerPool[0];
    const run = await startGauntletRun("performers", challenger, []);

    const { pair: firstPair } = await selectGauntletPair("performers", run);
    assert.equal(firstPair[0].rating100, challenger.rating100);

    // Simulate a rating write landing between two probes of the same run —
    // selectGauntletPair must reflect it, unlike holding one challenger
    // object constant for the whole run.
    challenger.rating100 = (challenger.rating100 ?? 50) + 7;
    const { pair: secondPair } = await selectGauntletPair("performers", run);
    assert.equal(secondPair[0].rating100, challenger.rating100, "challenger rating should be re-fetched, not stale");
  });

  test("the ladder excludes the challenger itself", async () => {
    const challenger = performerPool[0];
    const run = await startGauntletRun("performers", challenger, []);
    assert.ok(
      !run.ladder.some((entry) => entry.id === challenger.id),
      "challenger must not appear in its own ladder"
    );
  });

  test("works for scenes too, on the scenes ladder", async () => {
    const challenger = scenePool[0];
    const run = await startGauntletRun("scenes", challenger, []);
    assert.ok(
      !run.ladder.some((entry) => entry.id === challenger.id),
      "challenger must not appear in its own ladder"
    );

    const result = await selectGauntletPair("scenes", run);
    assert.ok(result, "expected a probe for a fresh scenes run");
    const [challengerHydrated, probeHydrated] = result.pair;
    assert.equal(challengerHydrated.id, challenger.id);
    assert.notEqual(probeHydrated.id, challenger.id);
  });

  test("a valid run.currentProbe is reused instead of rolling a new probe", async () => {
    const challenger = performerPool[0];
    const run = await startGauntletRun("performers", challenger, []);
    const first = await selectGauntletPair("performers", run);

    // Simulate usePair.js caching the chosen probe on the run, then a
    // remount (mode switch, tab round trip) calling selectGauntletPair again
    // with the same run — before the fix this always re-rolled via
    // nextProbe's weighted pick over the candidate window.
    const runWithCachedProbe = { ...run, currentProbe: first.currentProbe };
    const second = await selectGauntletPair("performers", runWithCachedProbe);
    assert.equal(second.probeIndex, first.probeIndex, "cached probe should be reused, not re-rolled");
    assert.equal(second.pair[1].id, first.pair[1].id);
  });

  test("a stale run.currentProbe (already faced) falls through to a fresh probe", async () => {
    const challenger = performerPool[0];
    let run = await startGauntletRun("performers", challenger, []);
    const first = await selectGauntletPair("performers", run);
    run = applyResult(run, { probeIndex: first.probeIndex, outcome: 1 });

    // The run advanced past the cached probe (it's now in facedIds), but the
    // stale currentProbe object from before the match is still attached —
    // selectGauntletPair must not re-serve an already-faced opponent.
    const staleRun = { ...run, currentProbe: first.currentProbe };
    const next = await selectGauntletPair("performers", staleRun);
    assert.ok(next, "expected a fresh probe while still short of MIN_MATCHES");
    assert.notEqual(next.pair[1].id, first.pair[1].id, "a faced probe must not be re-served from a stale cache");
  });
});

// The Gauntlet ladder previously ignored the gender filter entirely
// (startGauntletRun didn't even take selectedGenders). Coverage for the
// ladder-build-time filter, the size guard, the run's descriptive
// genderFilter stamp, and selectGauntletPair's live-filter probe exclusion
// for a filter narrowed mid-run.
describe("gauntlet selection — gender filtering", () => {
  beforeEach(() => {
    performerPool = buildGenderedPool();
    scenePool = buildTierHeavyScenePool();
    candidatesExcludeIds = [];
    resetPersisted();
    invalidateRankCache();
  });

  test("the ladder contains only in-filter performers", async () => {
    const challenger = performerPool.find((p) => p.gender === "FEMALE");
    const run = await startGauntletRun("performers", challenger, ["FEMALE"]);

    const femaleCount = performerPool.filter((p) => p.gender === "FEMALE").length;
    assert.equal(run.ladder.length, femaleCount - 1, "ladder should be every FEMALE performer minus the challenger");
    assert.ok(run.ladder.every((entry) => entry.gender === "FEMALE"), "every ladder entry must be FEMALE");
  });

  test("an empty selectedGenders yields the full, unfiltered ladder", async () => {
    const challenger = performerPool[0];
    const run = await startGauntletRun("performers", challenger, []);
    assert.equal(run.ladder.length, performerPool.length - 1);
  });

  test("scenes ignore the filter entirely (no gender field to filter on)", async () => {
    const challenger = scenePool[0];
    const run = await startGauntletRun("scenes", challenger, ["FEMALE"]);
    assert.equal(run.ladder.length, scenePool.length - 1, "scenes ladder must stay full regardless of the filter");
  });

  test("performers with no gender set are excluded under an active filter, included under no filter", async () => {
    const challenger = performerPool.find((p) => p.gender === "FEMALE");
    const ungenderedCount = performerPool.filter((p) => p.gender === undefined).length;
    assert.ok(ungenderedCount > 0, "fixture sanity check");

    const filtered = await startGauntletRun("performers", challenger, ["FEMALE"]);
    assert.ok(filtered.ladder.every((entry) => entry.gender != null), "no ungendered entries under an active filter");

    const unfiltered = await startGauntletRun("performers", challenger, []);
    assert.ok(
      unfiltered.ladder.some((entry) => entry.gender == null),
      "ungendered entries should be present again once the filter is cleared"
    );
  });

  test("run.genderFilter is stamped and survives an applyResult round trip", async () => {
    const challenger = performerPool.find((p) => p.gender === "FEMALE");
    let run = await startGauntletRun("performers", challenger, ["FEMALE"]);
    assert.deepEqual(run.genderFilter, ["FEMALE"]);

    const probe = await selectGauntletPair("performers", run, ["FEMALE"]);
    run = applyResult(run, { probeIndex: probe.probeIndex, outcome: 1 });
    assert.deepEqual(run.genderFilter, ["FEMALE"], "genderFilter must survive the immutable applyResult update");
  });

  test("a filter too narrow for MIN_LADDER rejects with a filter-aware message, not createRun's internal one", async () => {
    // NON_BINARY has only 8 in the fixture, below MIN_LADDER (14) even
    // before excluding the challenger.
    const challenger = performerPool.find((p) => p.gender === "NON_BINARY");
    await assert.rejects(
      () => startGauntletRun("performers", challenger, ["NON_BINARY"]),
      (err) => {
        assert.match(err.message, /gender filter/i);
        assert.ok(!/at least 2/.test(err.message), "should not leak createRun's internal invariant message");
        return true;
      }
    );
  });

  test("mid-run filter narrowing: every subsequent probe is in-filter, and the ladder stays frozen", async () => {
    // Start unfiltered so the ladder holds every gender.
    const challenger = performerPool.find((p) => p.gender === "FEMALE");
    let run = await startGauntletRun("performers", challenger, []);
    assert.ok(run.ladder.some((e) => e.gender === "MALE"), "fixture sanity check — ladder should be mixed-gender");

    // Narrow to FEMALE mid-run (matching pickRunChallenger's live filter
    // param, independent of run.genderFilter) and play several probes.
    for (let i = 0; i < MIN_MATCHES; i++) {
      const result = await selectGauntletPair("performers", run, ["FEMALE"]);
      assert.ok(result, "expected a probe while narrowed to FEMALE");
      const [, probeHydrated] = result.pair;
      assert.equal(probeHydrated.gender, "FEMALE", "every probe after narrowing must be FEMALE");
      // The ladder itself must stay frozen — the probe's index still maps
      // to the same ladder entry id, not a rebuilt/reindexed ladder.
      assert.equal(run.ladder[result.probeIndex].id, probeHydrated.id);
      run = applyResult(run, { probeIndex: result.probeIndex, outcome: i % 2 === 0 ? 1 : 0 });
    }
  });

  test("a cached currentProbe that fell out of a narrowed filter is not re-served", async () => {
    const challenger = performerPool.find((p) => p.gender === "FEMALE");
    const run = await startGauntletRun("performers", challenger, []);
    const first = await selectGauntletPair("performers", run, []);
    const [, probeHydrated] = first.pair;

    // If the cached probe happens to already be FEMALE, force the scenario
    // by asserting against its actual gender instead.
    const runWithCachedProbe = { ...run, currentProbe: first.currentProbe };
    const narrowedTo = probeHydrated.gender === "FEMALE" ? "MALE" : "FEMALE";
    const second = await selectGauntletPair("performers", runWithCachedProbe, [narrowedTo]);
    assert.ok(second, "expected a fresh in-filter probe");
    assert.notEqual(second.pair[1].id, probeHydrated.id, "the stale out-of-filter cached probe must not be reused");
    assert.equal(second.pair[1].gender, narrowedTo);
  });

  test("selectGauntletPair returns null once a filter excludes every remaining unfaced entry", async () => {
    // A ladder of exactly the challenger's own gender's minimum footprint —
    // narrow to a different gender with zero ladder members.
    const challenger = performerPool.find((p) => p.gender === "FEMALE");
    const run = await startGauntletRun("performers", challenger, []);
    // NON_BINARY has 8 in the fixture, but none of them are the challenger,
    // so this narrows to a real, small, fully-excludable subset by instead
    // filtering to a gender absent from the pool entirely.
    const result = await selectGauntletPair("performers", run, ["INTERSEX"]);
    assert.equal(result, null, "no INTERSEX performers exist in the fixture, so nothing should be servable");
  });
});

describe("champion selection — selectChampionPair", () => {
  beforeEach(() => {
    performerPool = buildTierHeavyPool();
    scenePool = [];
    candidatesExcludeIds = [];
    resetPersisted();
  });

  test("a champion absent from the (randomly-sampled) candidates pool is still resolved by direct id fetch", async () => {
    // Regression for a real bug: selectChampionPair used to look the
    // champion up via pool.find() against loadCandidatePool's own
    // randomly-sampled (capped at 500) pool. On a library bigger than that
    // cap, a valid reigning champion has only a small chance of landing in
    // any single sample, so it would be spuriously treated as "gone" and
    // fall back to a fresh random seed almost every match. The fix fetches
    // the champion directly by id instead of depending on pool membership.
    const champion = performerPool[0];
    candidatesExcludeIds = [champion.id];

    const { pair, freshSeedId } = await selectChampionPair("performers", [], champion.id);
    assert.equal(freshSeedId, null, "a champion missing only from the candidates sample must not trigger fallback");
    assert.equal(pair[0].id, champion.id);
    assert.notEqual(pair[1].id, champion.id);
  });

  test("champion is always index 0 and never its own opponent", async () => {
    const champion = performerPool[0];
    const { pair } = await selectChampionPair("performers", [], champion.id);
    assert.equal(pair[0].id, champion.id);
    assert.notEqual(pair[1].id, champion.id);
  });

  test("an absent championId falls back to selectWeightedPair and reports a fresh seed", async () => {
    const { pair, freshSeedId } = await selectChampionPair("performers", [], "not-in-pool");
    assert.ok(pair[0] && pair[1], "fallback should still produce a full pair");
    assert.equal(freshSeedId, pair[0].id);
  });

  test("freshSeedId is null on the normal (champion-found) path", async () => {
    const champion = performerPool[0];
    const { freshSeedId } = await selectChampionPair("performers", [], champion.id);
    assert.equal(freshSeedId, null);
  });

  test("the champion can be selected as seed while sitting in the recency list and cooldown buffer", async () => {
    const champion = performerPool[0];
    // Simulate the champion having just been in the previous match, as it
    // would be after every defense — Champion's seed bypasses both filters
    // the same way Gauntlet's challenger does.
    addToRecentlySelected("performers", champion.id);
    pushToRecentMatchBuffer("performers", [champion.id, performerPool[1].id]);

    const { pair } = await selectChampionPair("performers", [], champion.id);
    assert.equal(pair[0].id, champion.id);
  });

  test("works for scenes too, since Champion has no ladder dependency", async () => {
    scenePool = buildTierHeavyScenePool();
    const champion = scenePool[0];
    const { pair } = await selectChampionPair("scenes", [], champion.id);
    assert.equal(pair[0].id, champion.id);
    assert.notEqual(pair[1].id, champion.id);
  });

  test("a pinned challengerId is reused instead of picking a new opponent", async () => {
    const champion = performerPool[0];
    const first = await selectChampionPair("performers", [], champion.id);
    const pinnedId = first.pair[1].id;

    // Simulate a remount (mode switch, tab round trip) calling
    // selectChampionPair again with the same reign — before the fix this
    // always ran full stage-2 opponent selection and could pick someone
    // else.
    const second = await selectChampionPair("performers", [], champion.id, pinnedId);
    assert.equal(second.pair[1].id, pinnedId, "pinned challenger should be reused, not re-selected");
    assert.equal(second.freshSeedId, null);
  });

  test("an unknown pinned challengerId falls back to normal opponent selection", async () => {
    const champion = performerPool[0];
    const { pair, freshSeedId } = await selectChampionPair("performers", [], champion.id, "not-in-pool");
    assert.equal(pair[0].id, champion.id);
    assert.ok(pair[1], "should still produce an opponent via the normal selection path");
    assert.equal(freshSeedId, null);
  });
});
