// Seed/opponent selection and weighting for all three match modes. The core
// shape is a two-stage flow — pick a seed, then weigh candidates against it
// — split across `loadCandidatePool`/`selectOpponent`/`pickRunChallenger`,
// which Swiss (`selectWeightedPair`), Gauntlet (`startGauntletRun`,
// `selectGauntletPair`), and Champion (`selectChampionPair`) all build on
// rather than each hand-rolling their own candidate logic. Placement/reign
// math itself lives in gauntlet.js/champion.js, not here — this module only
// picks who plays, not what a result means. Also owns xenith_stats/
// xenith_record persistence (custom_fields read/write, legacy key fallback)
// and the session-scoped recency/cooldown state in state.js's `persisted`.
import {
  gql,
  FIND_PERFORMERS_CANDIDATES,
  FIND_SCENES_CANDIDATES,
  FIND_PERFORMERS_BY_IDS,
  FIND_SCENES_BY_IDS,
  COUNT_PERFORMERS,
  COUNT_SCENES,
} from "./api";
import { persisted } from "./state";
import { computeSystemConfig, DEFAULT_RATING, expectedScore, entropy, priorityScore, uncertainty } from "./elo";
import { getRankedItems } from "./rank-cache";
import { createRun, nextProbe, runStatus, MIN_LADDER } from "./gauntlet";
import { displayName } from "./format";

const STATS_KEY = "xenith_stats";
const RECORD_KEY = "xenith_record";
// Legacy HotOrNot-era keys, read-only. Written by versions before the
// "Migrate Legacy Field Names" task (backend/tasks.py's task_migrate)
// existed; read as a fallback so an un-migrated library keeps working,
// never written back.
const LEGACY_STATS_KEY = "hotornot_stats";
const LEGACY_RECORD_KEY = "performer_record";
const MAX_RECORD_ENTRIES = 50;

// Gates matchmaking's console.log calls behind a localStorage debug flag
// instead of always logging.
function isDebugEnabled() {
  return typeof localStorage !== "undefined" && localStorage.getItem("xenith:debug") === "true";
}
function debugLog(...args) {
  if (isDebugEnabled()) console.log(...args);
}

// Same 60s TTL src/rank-cache.js uses for the ranked-performer list — item
// counts don't change often enough to warrant refetching on every match.
const SYSTEM_CONFIG_CACHE_TTL_MS = 60000;

// Cached independently per content type — Performers and Scenes draw from
// differently-sized pools, so their K-factor bounds shouldn't share a cache
// entry.
/** @type {{ performers: { config: { kMin: number, kMax: number, mDecay: number }, timestamp: number } | null, scenes: { config: { kMin: number, kMax: number, mDecay: number }, timestamp: number } | null }} */
const systemConfigCache = { performers: null, scenes: null };

async function fetchItemCount(battleType) {
  if (battleType === "scenes") {
    const data = await gql(COUNT_SCENES, { filter: { per_page: 0 } });
    return data.findScenes.count;
  }
  const data = await gql(COUNT_PERFORMERS, { performer_filter: {}, filter: { per_page: 0 } });
  return data.findPerformers.count;
}

// Resolves the dynamic K-factor bounds for a battle type, caching the
// underlying item count (and derived config) for SYSTEM_CONFIG_CACHE_TTL_MS.
export async function getSystemConfig(battleType) {
  const key = battleType === "scenes" ? "scenes" : "performers";
  const cached = systemConfigCache[key];
  const now = Date.now();
  if (cached && now - cached.timestamp < SYSTEM_CONFIG_CACHE_TTL_MS) {
    return cached.config;
  }
  const count = await fetchItemCount(battleType);
  const config = computeSystemConfig(count);
  systemConfigCache[key] = { config, timestamp: now };
  return config;
}

const DEFAULT_STATS = {
  total_matches: 0,
  wins: 0,
  losses: 0,
  draws: 0,
  current_streak: 0,
  best_streak: 0,
  worst_streak: 0,
  last_match: null,
};

// Numeric fields coerced with Number() below — a hand-edited custom_fields
// value like {"total_matches":"abc"} parses fine as JSON (so the try/catch
// in parseXenithStats, further down, never fires) but produces a non-numeric
// field that later yields NaN via uncertainty()/weightedPick. `last_match`
// is intentionally excluded — it's not numeric.
const NUMERIC_STAT_KEYS = ["total_matches", "wins", "losses", "draws", "current_streak", "best_streak", "worst_streak"];

// A genuinely unparseable/malformed-shape xenith_stats blob must NOT
// be treated the same as a first-time/never-rated entity — both fall back
// to DEFAULT_STATS-shaped data so every existing caller keeps working
// unchanged, but a parse failure is additionally tagged with this
// non-enumerable marker. Non-enumerable means it's invisible to
// JSON.stringify (serializeStats) and to object spread (the `{...stats}` in
// updateStatsAfterMatch), so it can never leak into a write payload — it's
// only readable via statsParseFailed() by a caller holding the original
// object, which is exactly what the write path (usePair.js) does before
// deciding whether to include the stats field in a mutation at all.
const STATS_PARSE_FAILED = Symbol("xenith:statsParseFailed");

function markStatsParseFailed(stats) {
  Object.defineProperty(stats, STATS_PARSE_FAILED, { value: true, enumerable: false });
  return stats;
}

// Callers on the write path (usePair.js) check this before building a
// custom_fields mutation for the stats field — true means "don't write,
// this would permanently overwrite unparsed-but-possibly-recoverable data
// with defaults."
export function statsParseFailed(stats) {
  return !!(stats && stats[STATS_PARSE_FAILED]);
}

export function parseXenithStats(item) {
  if (!item) return { ...DEFAULT_STATS };
  if (item._stats) return item._stats;
  // New key wins if both are present (post-migration, pre-write); fall back
  // to the legacy key for un-migrated data. `??` not `||` — an empty-but-set
  // stats blob is never falsy here since it's always a non-empty JSON string.
  const raw = item.custom_fields?.[STATS_KEY] ?? item.custom_fields?.[LEGACY_STATS_KEY];
  if (!raw) return { ...DEFAULT_STATS }; // genuinely new/never-rated — legitimate defaults, safe to write
  try {
    const parsed = JSON.parse(raw);
    // Shape check: JSON.parse succeeds on non-object payloads too (a bare
    // number, string, array, or null all parse fine) — only a plain object
    // is a valid stats blob.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`xenith_stats parsed to a non-object (${typeof parsed})`);
    }
    const merged = { ...DEFAULT_STATS, ...parsed };
    for (const key of NUMERIC_STAT_KEYS) {
      const coerced = Number(merged[key]);
      merged[key] = Number.isFinite(coerced) ? coerced : DEFAULT_STATS[key];
    }
    return merged;
  } catch (e) {
    // Real error path, not a debug log — do NOT gate behind isDebugEnabled().
    console.error(
      `[Xenith] Failed to parse xenith_stats for item ${item?.id ?? "unknown"} — refusing to write defaults over it: ${/** @type {any} */(e).message}`
    );
    return markStatsParseFailed({ ...DEFAULT_STATS });
  }
}

export function serializeStats(stats) {
  return { [STATS_KEY]: JSON.stringify(stats) };
}

// xenith_record: append-only match log, capped to MAX_RECORD_ENTRIES. Both
// battle types — opponent is stored as "id:name" for a performer opponent,
// "id:title" (via displayName()) for a scene opponent.
export function parseRecord(item) {
  try {
    const raw = item.custom_fields?.[RECORD_KEY] ?? item.custom_fields?.[LEGACY_RECORD_KEY];
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function serializeRecord(record) {
  return { [RECORD_KEY]: JSON.stringify(record) };
}

export function appendRecordEntry(record, entry) {
  return [...record, entry].slice(-MAX_RECORD_ENTRIES);
}

export function updateStatsAfterMatch(stats, won) {
  const streak = won
    ? (stats.current_streak >= 0 ? stats.current_streak + 1 : 1)
    : (stats.current_streak <= 0 ? stats.current_streak - 1 : -1);

  return {
    ...stats,
    total_matches: stats.total_matches + 1,
    wins: won ? stats.wins + 1 : stats.wins,
    losses: won ? stats.losses : stats.losses + 1,
    current_streak: streak,
    best_streak: Math.max(stats.best_streak, streak),
    worst_streak: Math.min(stats.worst_streak, streak),
    last_match: new Date().toISOString(),
  };
}

// Draw: increments total_matches and draws; resets current_streak to 0
// (draws break streaks but don't count as a loss).
export function updateStatsAfterDraw(stats) {
  return {
    ...stats,
    total_matches: stats.total_matches + 1,
    draws: (stats.draws || 0) + 1,
    current_streak: 0,
    last_match: new Date().toISOString(),
  };
}

const MATCH_BUFFER_SIZE = 20;

// Pushes one match (both participant IDs) onto the session-scoped FIFO
// cooldown buffer for the given battle type, evicting the oldest entry once
// past MATCH_BUFFER_SIZE. One entry = one match, so MATCH_BUFFER_SIZE=20
// literally holds 20 matches of cooldown, per `XENITH.md` §3.7. Match-count
// -based (not wall-clock), so it can't collapse during a fast session the
// way the old 30-min blackout could. Kept per battle type since Stash IDs
// aren't namespaced by entity type — a performer and a scene can share the
// same numeric id.
export function pushToRecentMatchBuffer(battleType, ids) {
  if (!persisted.recentMatchBuffer) {
    persisted.recentMatchBuffer = { performers: [], scenes: [] };
  }
  const buffer = /** @type {any[][]} */ (persisted.recentMatchBuffer[battleType]);
  buffer.push(ids);
  if (buffer.length > MATCH_BUFFER_SIZE) {
    buffer.shift();
  }
}

// Binary eligibility check — true if `id` was a participant in any match
// still sitting in the cooldown buffer for `battleType` (i.e. ineligible
// for selection right now).
export function isInRecentMatchBuffer(battleType, id) {
  if (!persisted.recentMatchBuffer) return false;
  const buffer = /** @type {any[][]} */ (persisted.recentMatchBuffer[battleType]);
  return !!buffer && buffer.some((match) => match.includes(id));
}

function weightedPick(items, weightFn) {
  if (items.length === 0) return undefined;
  const weights = items.map(weightFn);
  const total = weights.reduce((a, b) => a + b, 0);
  // `NaN <= 0` is false, so a NaN total (a malformed weight slipping
  // through, e.g. a non-numeric stat field) would skip this guard entirely
  // — every `r <= 0` test below then also fails on NaN, silently falling
  // through to a deterministic last-item pick. Explicit finiteness check
  // falls back to uniform random selection instead.
  if (!Number.isFinite(total) || total <= 0) {
    return items[Math.floor(Math.random() * items.length)];
  }
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

// Exported so match-stats.js's win-rate qualifier can reuse the exact same
// floored-median baseline as the low-match boost above, instead of a second
// "enough matches" threshold drifting out of sync with this one.
export function getMedian(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const half = Math.floor(sorted.length / 2);
  if (sorted.length % 2 !== 0) {
    return sorted[half];
  }
  return (sorted[half - 1] + sorted[half]) / 2;
}

// Entropy-weighted base signal (`XENITH.md` §3.6). H(A,B)/P(A,B) are
// pairwise — they need a second candidate's rating to define E_A — but this
// function scores a SINGLE candidate for weighted-random selection, called
// from two different points in selectWeightedPair's two-stage seed->opponent
// flow. Entity-generic (performers or scenes) — `battleType` only threads
// through to the session-match-count lookup below, which is namespaced per
// battle type since Stash IDs aren't namespaced by entity type.
//
//  1. Seed selection (top-15 weighted pool): no opponent has been chosen
//     yet, so E_A/H aren't meaningful — there's no second rating to compare
//     against. `opponentContext` is omitted here. A candidate's OWN
//     uncertainty (sigma) is still meaningful on its own, though: it
//     reflects how little is known about that candidate specifically,
//     independent of who it eventually faces. Seed priority uses sigma
//     directly as the base signal, so undersampled performers float toward
//     the top of the weighted seed pool before a pairing even exists.
//  2. Opponent selection (candidates weighed against an already-chosen
//     seed): a real second rating exists at this point, so the full
//     pairwise H(A,B)/P(A,B) formula applies directly — `opponentContext`
//     carries the seed's rating and sigma, and this branch computes E_A via
//     elo.js's shared expectedScore, then entropy + priorityScore exactly
//     per §3.6.
/**
 * @param {string} battleType
 * @param {*} p
 * @param {number} medianMatches
 * @param {{ rating: number, sigma: number } | null} [opponentContext]
 */
function calculateCandidateWeight(battleType, p, medianMatches, opponentContext = null) {
  const stats = parseXenithStats(p);
  const rawMatches = stats.total_matches || 0;
  const sigmaP = uncertainty(rawMatches);

  let baseWeight;
  if (opponentContext) {
    const pRating = p.rating100 ?? DEFAULT_RATING;
    const eA = expectedScore(opponentContext.rating, pRating);
    const h = entropy(eA);
    baseWeight = priorityScore(h, opponentContext.sigma, sigmaP);
  } else {
    baseWeight = 1 + sigmaP;
  }

  let lowMatchBoost = 1.0;
  // Floor of 5 keeps thresholds sane when the pool's median match count is 0-4
  // (e.g. a library with few matches so far) instead of collapsing the boost bands to near-zero.
  const baseline = Math.max(5, medianMatches);
  if (rawMatches === 0) {
    lowMatchBoost = 2.0;
  } else if (rawMatches < baseline * 0.3) {
    lowMatchBoost = 1.5;
  } else if (rawMatches < baseline * 0.5) {
    lowMatchBoost = 1.2;
  }

  // Session match penalty — de-weights performers already seen earlier in this
  // session, on top of the recency list and match cooldown buffer above.
  let sessionPenalty = 1.0;
  const sessionCount = persisted.sessionMatchCounts[battleType][p.id] || 0;
  if (sessionCount > 2) {
    sessionPenalty = 0.1;
  } else if (sessionCount > 1) {
    sessionPenalty = 0.3;
  } else if (sessionCount > 0) {
    sessionPenalty = 0.6;
  }

  return baseWeight * lowMatchBoost * sessionPenalty;
}

export function trackSelection(battleType, id) {
  if (!persisted.sessionMatchCounts) {
    persisted.sessionMatchCounts = { performers: {}, scenes: {} };
  }
  const counts = persisted.sessionMatchCounts[battleType];
  counts[id] = (counts[id] || 0) + 1;
}

export function addToRecentlySelected(battleType, id) {
  if (!persisted.recentlySelected) {
    persisted.recentlySelected = { performers: [], scenes: [] };
  }
  const list = /** @type {any[]} */ (persisted.recentlySelected[battleType]);
  list.push(id);
  if (list.length > 8) {
    list.shift();
  }
}

export function isRecentlySelected(battleType, id) {
  if (!persisted.recentlySelected) return false;
  return /** @type {any[]} */ (persisted.recentlySelected[battleType]).includes(id);
}

// Does `item` still satisfy the live gender filter? Mirrors
// loadCandidatePool's `gender: { value_list, modifier: "INCLUDES" }` filter
// below: an empty selection is no filter at all, and scenes have no gender
// field for Stash to filter on (see Sidebar.jsx's genderFilterDisabled).
// Needed by the run modes (Gauntlet/Champion), whose incumbent is resolved
// by id via fetchById and so never passes through that pool filter.
export function matchesGenderFilter(battleType, item, selectedGenders) {
  if (battleType === "scenes") return true;
  if (!selectedGenders || selectedGenders.length === 0) return true;
  return !!item && selectedGenders.includes(item.gender);
}

// Fetches the candidate pool for a battle type, hydrates each entry's
// _stats, and computes the pool's median match count — the shared prologue
// every selection mode (Swiss, Gauntlet's challenger pick, Champion) starts
// from. Kept as one implementation so a future fourth mode doesn't need a
// fourth copy, and so this prologue can't drift out of sync with itself the
// way pickRunChallenger's inline copy briefly did (missing the seed
// weighting's tie-break jitter — see calculateCandidateWeight's caller
// below).
async function loadCandidatePool(battleType, selectedGenders) {
  const isScenes = battleType === "scenes";

  const data = isScenes
    ? await gql(FIND_SCENES_CANDIDATES, { filter: { per_page: 500, sort: "random" } })
    : await gql(FIND_PERFORMERS_CANDIDATES, {
      performer_filter: { gender: { value_list: selectedGenders, modifier: "INCLUDES" } },
      filter: { per_page: 500, sort: "random" },
    });

  const pool = isScenes ? data.findScenes.scenes : data.findPerformers.performers;
  if (pool.length < 2) throw new Error("Not enough items to compare — need at least 2.");

  for (let i = 0; i < pool.length; i++) {
    pool[i]._stats = parseXenithStats(pool[i]);
  }

  const matchCounts = pool.map((p) => parseXenithStats(p).total_matches || 0);
  const medianMatches = getMedian(matchCounts);

  return { pool, medianMatches, isScenes };
}

// Fetches a single item directly by id rather than hoping it turns up in
// loadCandidatePool's randomly-sampled pool. That pool is capped at 500
// (per_page in FIND_PERFORMERS_CANDIDATES/FIND_SCENES_CANDIDATES) and
// re-sampled fresh on every call — on a library bigger than 500, a specific
// id has only a small chance of landing in any given sample, so "look it up
// in this call's pool" would spuriously treat a perfectly valid id as gone
// almost every match. Used to re-fetch a run mode's incumbent (Gauntlet's
// challenger/probe via hydratePair, Champion's reigning champion) by id.
async function fetchById(isScenes, id) {
  const data = isScenes
    ? await gql(FIND_SCENES_BY_IDS, { ids: [id] })
    : await gql(FIND_PERFORMERS_BY_IDS, { ids: [id] });
  const found = (isScenes ? data.findScenes.scenes : data.findPerformers.performers)[0];
  if (!found) return null;
  found._stats = parseXenithStats(found);
  return found;
}

// Picks an opponent for an already-chosen seed: the full pairwise
// entropy/priority weighting (XENITH.md §3.6) plus the cross-tier / 15pt /
// 25pt / nearest-rating / pure-random failover chain. Shared by Swiss
// (seed = its own weighted pick) and Champion (seed = the reigning
// champion) — Gauntlet's probe selection is a different, ladder-based
// mechanism and lives in gauntlet.js's nextProbe instead.
function selectOpponent(battleType, pool, seed, medianMatches) {
  const seedRating = seed.rating100 ?? DEFAULT_RATING;
  const seedMatches = (seed._stats && seed._stats.total_matches) || 0;
  const opponentContext = { rating: seedRating, sigma: uncertainty(seedMatches) };

  let opponentCandidates = pool.filter((p) => p.id !== seed.id);
  const freshOpponents = opponentCandidates.filter((p) => !isRecentlySelected(battleType, p.id));
  if (freshOpponents.length >= 2) {
    opponentCandidates = freshOpponents;
  }
  const bufferEligibleOpponents = opponentCandidates.filter((p) => !isInRecentMatchBuffer(battleType, p.id));
  if (bufferEligibleOpponents.length >= 2) {
    opponentCandidates = bufferEligibleOpponents;
  }

  /** @type {any} */
  let opponent = null;

  const isCrossTier = Math.random() < 0.1;
  if (isCrossTier) {
    const crossTierCandidates = opponentCandidates.filter((p) => {
      const rating = p.rating100 ?? DEFAULT_RATING;
      return Math.abs(rating - seedRating) >= 20;
    });

    if (crossTierCandidates.length > 0) {
      opponent = weightedPick(crossTierCandidates, (p) =>
        calculateCandidateWeight(battleType, p, medianMatches, opponentContext)
      );
      debugLog(`[Xenith] CROSS-TIER MATCH: ${displayName(seed)} vs ${displayName(opponent)}`);
    }
  }

  if (!opponent) {
    const normalCandidates = opponentCandidates.filter((p) => {
      const rating = p.rating100 ?? DEFAULT_RATING;
      return Math.abs(rating - seedRating) <= 15;
    });

    if (normalCandidates.length > 0) {
      opponent = weightedPick(normalCandidates, (p) =>
        calculateCandidateWeight(battleType, p, medianMatches, opponentContext)
      );
    }
  }

  // Failover: 15-pt window -> this wider 25-pt window -> nearest-rating -> pure random.
  if (!opponent) {
    const looseCandidates = opponentCandidates.filter((p) => {
      const rating = p.rating100 ?? DEFAULT_RATING;
      return Math.abs(rating - seedRating) <= 25;
    });

    if (looseCandidates.length > 0) {
      opponent = weightedPick(looseCandidates, (p) =>
        calculateCandidateWeight(battleType, p, medianMatches, opponentContext)
      );
      debugLog(`[Xenith] Failover 1 (loose range): ${displayName(seed)} vs ${displayName(opponent)}`);
    }
  }

  if (!opponent) {
    let bestOpp = null;
    let minDiff = Infinity;
    for (const p of opponentCandidates) {
      const diff = Math.abs((p.rating100 ?? DEFAULT_RATING) - seedRating);
      if (diff < minDiff) {
        minDiff = diff;
        bestOpp = p;
      }
    }
    opponent = bestOpp;
    if (opponent) {
      debugLog(`[Xenith] Failover 2 (nearest rating): ${displayName(seed)} vs ${displayName(opponent)}`);
    }
  }

  if (!opponent) {
    opponent = opponentCandidates[Math.floor(Math.random() * opponentCandidates.length)];
    debugLog(`[Xenith] Failover 3 (pure random): ${displayName(seed)} vs ${displayName(opponent)}`);
  }

  return opponent;
}

// Matchmaking here is tier-agnostic, with no S-Tier eligibility gate — the
// cross-tier match logic (the 10% forced-pairing branch) lives in
// selectOpponent above.
export async function selectWeightedPair(battleType, selectedGenders) {
  const { pool, medianMatches, isScenes } = await loadCandidatePool(battleType, selectedGenders);

  let eligibleSeeds = pool.filter((p) => !isRecentlySelected(battleType, p.id));
  if (eligibleSeeds.length < 2) {
    eligibleSeeds = pool;
  }
  // Cooldown buffer narrows the pool further, filtering candidates out
  // entirely rather than down-weighting them — fall back if it leaves too
  // few to pick from.
  const bufferEligibleSeeds = eligibleSeeds.filter((p) => !isInRecentMatchBuffer(battleType, p.id));
  if (bufferEligibleSeeds.length >= 2) {
    eligibleSeeds = bufferEligibleSeeds;
  }

  const seedWeights = eligibleSeeds.map((p) => ({
    p,
    // Tie-break jitter: on a cold library every weight is identical, and
    // without this the top-15 slice below depends on the sort being stable
    // and on the query's `sort: "random"` ordering. Too small to perturb
    // any real weight ordering.
    weight: calculateCandidateWeight(battleType, p, medianMatches) * (1 + Math.random() * 0.001),
  }));

  seedWeights.sort((a, b) => b.weight - a.weight);
  const top15 = seedWeights.slice(0, 15);
  const seedItem = weightedPick(top15, (item) => item.weight);
  const seed = seedItem.p;

  const opponent = selectOpponent(battleType, pool, seed, medianMatches);

  return { pair: await hydratePair(isScenes, seed, opponent), ranks: [null, null] };
}

// The candidate pool above is fetched with slim fields (id/name/rating100/
// custom_fields) — enough for matchmaking weighting, not enough for the
// native StashApp cards the pair renders as (see native-loader.js). Once a
// seed/opponent is chosen, re-fetch just those 2 with the full field set.
async function hydratePair(isScenes, seed, opponent) {
  const ids = [seed.id, opponent.id];
  const data = isScenes
    ? await gql(FIND_SCENES_BY_IDS, { ids })
    : await gql(FIND_PERFORMERS_BY_IDS, { ids });
  const byId = new Map(
    (isScenes ? data.findScenes.scenes : data.findPerformers.performers).map((item) => [item.id, item])
  );
  return [byId.get(seed.id), byId.get(opponent.id)];
}

// Auto-picks a run mode's incumbent (Gauntlet's challenger, Champion's
// shuffled-in champion) by the same "own uncertainty" weighting
// selectWeightedPair's seed stage uses (calculateCandidateWeight with no
// opponentContext — undersampled candidates float to the top). `excludeIds`
// backs both Gauntlet's "Try another" re-roll and Champion's shuffle, so
// neither can just hand back the same candidate. Deliberately skips the
// recency list and cooldown buffer — the incumbent repeats every match of a
// run and would otherwise filter itself out after its first match.
export async function pickRunChallenger(battleType, selectedGenders, excludeIds = []) {
  const isScenes = battleType === "scenes";
  const { pool, medianMatches } = await loadCandidatePool(battleType, selectedGenders);
  const eligible = pool.filter((p) => !excludeIds.includes(p.id));
  if (eligible.length === 0) throw new Error(`No eligible ${isScenes ? "scenes" : "performers"} left to challenge with.`);

  const weighted = eligible
    .map((p) => ({
      p,
      weight: calculateCandidateWeight(battleType, p, medianMatches) * (1 + Math.random() * 0.001),
    }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 15);
  const picked = weightedPick(weighted, (item) => item.weight).p;

  return fetchById(isScenes, picked.id);
}

// ─── Gauntlet mode ───
// Both battle types. Placement math itself lives in gauntlet.js, pure and
// GraphQL-free; this section resolves the GraphQL-backed pieces (ladder
// snapshot, probe hydration) and hands plain data in.

// Builds a fresh gauntlet run for `challenger`: snapshots the ranked ladder
// (getRankedItems(battleType), sorted by composite — see rank-cache.js),
// excludes the challenger, filters to the live gender filter (previously
// ignored entirely), and copies out {id, rating,
// gender} per entry. Copying rather than retaining the cached row objects
// matters: commitMatch invalidates rank-cache.js's cache after every match,
// but nothing re-invalidates a value already copied out of it, so the run's
// ladder snapshot stays stable for its whole duration as intended.
//
// The filtered ladder is frozen for the run's whole duration, same as the
// unfiltered one always was — a filter change mid-run doesn't rebuild it
// (see selectGauntletPair's excludeIds below for how that's handled
// instead). `genderFilter` is stamped onto the returned run purely for
// display (PlacementScreen/GauntletBanner label which pool the run's rank
// is relative to) — it's never read back for selection logic, which always
// uses the live filter.
//
// MIN_LADDER (gauntlet.js) is checked here rather than left to createRun's
// internal `length < 2` guard: a run needs a distinct unfaced probe every
// match, so a ladder shorter than the match cap can dead-end mid-run, and a
// tiny ladder also makes the credible-interval termination rule's floor
// span the whole ladder — a "Placed!" screen over a near-uniform posterior.
export async function startGauntletRun(battleType, challenger, selectedGenders = []) {
  const ranked = await getRankedItems(battleType);
  const ladder = ranked
    .filter((p) => p.id !== challenger.id && matchesGenderFilter(battleType, p, selectedGenders))
    .map((p) => ({ id: p.id, rating: p.rating100 ?? DEFAULT_RATING, gender: p.gender }));
  if (ladder.length < MIN_LADDER) {
    throw new Error(
      selectedGenders && selectedGenders.length > 0
        ? `Only ${ladder.length} performers match the current gender filter — a Gauntlet run needs at least ${MIN_LADDER}.`
        : `Only ${ladder.length} items available — a Gauntlet run needs at least ${MIN_LADDER}.`
    );
  }
  return { ...createRun({ challengerId: challenger.id, ladder }), genderFilter: selectedGenders };
}

// Picks the run's next probe opponent (src/gauntlet.js's nextProbe) and
// hydrates both the challenger and the probe with full fields, same as
// Swiss's hydratePair. The challenger is re-fetched every probe rather than
// held from run start — usePair.js's choose() reads rating100/total_matches
// straight off the pair object, so a stale challenger object would apply
// every delta from the run's starting rating instead of its current one.
// Returns null once the run has no more probes (caller checks runStatus
// before calling this, per src/gauntlet.js). Reuses `run.currentProbe` when
// it's still valid (not yet faced, still at the ladder index it was picked
// from, and still in-filter — see below) so a remount mid-run (e.g. a round
// trip to the Leaderboard tab) re-shows the same probe instead of rolling a
// new one from nextProbe's candidate window; falls through to nextProbe
// otherwise.
//
// `selectedGenders` is the *live* filter, independent of run.genderFilter
// (the filter the ladder was built under — see startGauntletRun). The
// ladder itself stays frozen for the run's whole duration, but a filter
// narrowed mid-run must not keep serving now-excluded probes, so
// out-of-filter ladder entries are excluded from selection here rather than
// removed from the ladder — removing them would shift indices out from
// under the posterior, which is keyed positionally.
export async function selectGauntletPair(battleType, run, selectedGenders = []) {
  if (runStatus(run) !== "active") return null;
  const excludeIds = run.ladder
    .filter((entry) => !matchesGenderFilter(battleType, entry, selectedGenders))
    .map((entry) => entry.id);
  const cached = run.currentProbe;
  const cachedValid =
    cached &&
    run.ladder[cached.index]?.id === cached.id &&
    !run.facedIds.includes(cached.id) &&
    !excludeIds.includes(cached.id);
  const probe = cachedValid ? cached : nextProbe(run, { excludeIds });
  if (!probe) return null;
  const pair = await hydratePair(battleType === "scenes", { id: run.challengerId }, { id: probe.id });
  return { pair, probeIndex: probe.index, currentProbe: probe };
}

// ─── Champion mode ───
// Both battle types — Champion has no ladder dependency (unlike Gauntlet),
// so it needs only the candidate pool selectWeightedPair already serves for
// performers and scenes alike. Reign math lives in champion.js, pure and
// GraphQL-free; this resolves the champion's current rating/stats and picks
// its next challenger via the same selectOpponent stage-2 flow Swiss uses.

// Loads the opponent pool and pairs `championId` (fetched directly, see
// fetchById above) against a stage-2 opponent, same weighting/failover
// chain as Swiss's own opponent selection. If the champion can't be found
// at all (entity actually deleted, or no championId yet on a cold start),
// falls back to an ordinary selectWeightedPair result and signals the
// caller (via `freshSeedId`) that a new reign should be rooted at whatever
// seed that produced instead.
//
// `challengerId` (optional) pins the reign's current challenger — set by
// usePair.js after a fetch so a remount mid-reign (mode switch, tab round
// trip) re-shows the same challenger instead of rolling a new one. Tried
// before stage-2 selection; if the pinned id is missing/deleted, falls
// through to the normal opponent pick.
export async function selectChampionPair(battleType, selectedGenders, championId, challengerId = null) {
  const isScenes = battleType === "scenes";
  const champion = championId ? await fetchById(isScenes, championId) : null;

  if (!champion) {
    const fallback = await selectWeightedPair(battleType, selectedGenders);
    return { pair: fallback.pair, ranks: fallback.ranks, freshSeedId: fallback.pair[0].id };
  }

  const pinned = challengerId ? await fetchById(isScenes, challengerId) : null;
  if (pinned) {
    return { pair: [champion, pinned], ranks: [null, null], freshSeedId: null };
  }

  const { pool, medianMatches } = await loadCandidatePool(battleType, selectedGenders);

  const opponent = selectOpponent(battleType, pool, champion, medianMatches);

  return { pair: await hydratePair(isScenes, champion, opponent), ranks: [null, null], freshSeedId: null };
}
