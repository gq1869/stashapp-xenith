// Throwaway design-time tool for calibrating src/elo.js's TIER_BOUNDS. Not
// part of dist, not part of npm test, not part of CI. Rerun this whenever
// the rating-math formulas in src/elo.js change, and paste the new
// percentile output into TIER_BOUNDS's comment block + the constant itself.
//
// Methodology
// -----------
// - Population: 2500 performers, all starting at DEFAULT_RATING (50), which
//   mirrors a freshly-reset library (or an untouched one, since unrated
//   performers already resolve to DEFAULT_RATING everywhere).
// - Hidden "true skill": each performer gets a fixed Normal(50, 8) skill,
//   clamped to [0, 100], that the rating math never sees directly. Match
//   winners are drawn probabilistically using the same logistic form the
//   real expected-score formula uses (D=35), applied to true skill instead
//   of current rating. This is standard practice for Elo calibration: it
//   gives the population a stable skill hierarchy for the rating math to
//   converge toward. Only the *winner decision* is simulated this way —
//   every rating delta comes from the real elo.js functions
//   (calculateMatchOutcome / kFactor / computeSystemConfig), not
//   reimplemented here.
// - Opponent selection: NOT pure random pairing — see "Why not pure random
//   pairing" below for why that was tried and rejected. A candidate opponent is picked randomly and
//   accepted if within 15 rating points of the seed (reusing the same
//   15-point anchor window the real matchmaking system uses) — retried
//   up to 30 times, then
//   falls back to the next index. A 10% forced cross-tier match (>=20pt
//   gap — no tier-eligibility gate, matching production since the
//   S-excludes-sub-B `canBattleByTier` gate was removed) is attempted
//   first, falling through to the anchor-window pick on failure — omitting
//   this shifts p10 from 7->0 and p30 from 26->20 under the current
//   formulas, material enough that it's modeled here rather than left out. Weighting
//   (entropy priority, low-match boost, session penalty) and cooldown are
//   still not simulated — a deliberate scope call, not an oversight: they
//   mostly affect convergence speed rather than the settled equilibrium
//   this sim runs long enough to reach, and low-match boost in particular
//   would need weighted (not uniform-random) seed selection to matter.
//   Tier-focus is gone from this list entirely — the mechanism itself was
//   deleted from matchmaking.js, not just left unsimulated.
// - systemConfig is computed once via computeSystemConfig(2500) and reused
//   for every match, matching how the real system resolves K-bounds for a
//   2500-performer library.
// - Match volume: 200 average matches per performer (see "Follow-up: why 200
//   avg matches/performer" below for how this number was chosen). Checkpoints
//   at 25/50/100/150/200 avg matches/performer are printed below —
//   percentile values are confirmed stable within +/-1 point across reruns
//   by 200.
// - Percentiles: standard linear-interpolation method (numpy's default
//   'linear' / Excel PERCENTILE.INC) on the sorted, ascending rating100
//   array.
//
// Why not pure random pairing
// ----------------------------
// Pure random opponent pairing (no anchor window at all) was tried first and
// rejected. Both sides of an upset are attenuated symmetrically now
// (`winnerGain *= attenuation; loserLoss *= attenuation` in
// calculateMatchOutcome — see src/elo.js), so a single upset no longer
// injects one-directional mass on its own. But unconstrained random pairing
// still drifts: a performer who reaches a high rating early (routine given
// kMax=32 for new entities) then keeps facing average-rated opponents by
// pure chance wins a very favorable matchup most of the time for a small
// guaranteed gain each time, compounding over many matches even with
// symmetric per-match attenuation. The reverse holds at the bottom. This
// produces sustained one-directional drift into the rating clamps rather
// than a settled bell-shaped population: in testing, pure random pairing
// pinned 15-20%+ of the population at exactly rating 100 (and a smaller but
// still large share at 0) by any match volume otherwise long enough to have
// settled — which collapses the 85th and 97th percentiles to the same value
// (100) and makes TIER_BOUNDS's S and A floors identical, breaking
// getRatingTier's ability to distinguish them. Reusing just the anchor-15
// proximity rule (the most basic, load-bearing piece of real matchmaking,
// not any of its weighting/focus nuance) keeps matches competitive enough
// that this runaway doesn't dominate, while still leaving opponent
// selection otherwise unweighted and random.
//
// Follow-up: why 200 avg matches/performer, not 25
// --------------------------------------------------
// A later investigation (prompted by the winner-gain-floor / symmetric-
// upset-attenuation fix in calculateMatchOutcome not moving the ceiling
// pile-up at all) reran this simulation at 25/50/100/200/400 avg
// matches/performer to check whether the ~8% ceiling occupancy seen at 25
// was a premature/transient reading. It wasn't fully transient at first —
// occupancy dropped only modestly with more matches, and stayed well above
// the 3% target regardless of match volume. That pointed at a fidelity gap
// in the sim rather than a convergence-speed issue: the sim was missing the
// 10% forced cross-tier match production's selectWeightedPair performs (now
// modeled above via CROSS_TIER_CHANCE/CROSS_TIER_MIN_GAP), which is exactly
// the mechanism that pulls boundary-drifted candidates back into competition
// with the rest of the pool. Adding it dropped ceiling occupancy to the
// current ~3.0-3.6% (floor ~3.4-4.0%), without any change to the
// K-factor/D-scale/attenuation formulas. 200 avg matches/performer was kept
// as the default once that fix
// landed: long enough that percentiles are confirmed stable within +/-1
// point across reruns, without paying 400's runtime for no further
// precision. See the TIER_BOUNDS comment block in src/elo.js and `XENITH.md`
// §5's implementation note for the full writeup.
//
// Why these low-volume checkpoints were added
// ---------------------------------------------
// Ceiling/floor occupancy is not monotonic on the way to settling — it rises
// from a cold start, peaks somewhere in the first ~15-20 avg matches/
// performer, then declines toward the settled figure. TIER_BOUNDS is
// calibrated at 200 avg matches/performer, well past that peak, but the
// production library has never gotten anywhere close to 200 (max observed:
// ~17). The original 25-200 checkpoint
// schedule reported the settled tail of the curve without ever printing the
// transient peak a real, actively-used library sits in. These checkpoints
// exist so that peak is visible, not to suggest TIER_BOUNDS itself should
// track it — TIER_BOUNDS is a percentile mapping, and percentiles of a
// population are volume-invariant even while the population's absolute
// spread is not; the tier a given performer lands in stays consistent
// regardless of where the pool as a whole is on this curve.

import { calculateMatchOutcome, computeSystemConfig, DEFAULT_RATING } from "../../src/elo.js";

const POPULATION = 2500;
const AVG_MATCHES_PER_PERFORMER = 200;
// 5/10/15/20 added to cover the match volume the library has actually
// reached (max observed: ~17 avg matches/performer) — the original 25-200
// schedule skipped straight
// past the ceiling-occupancy peak documented below in "Why these low-volume
// checkpoints were added".
const CHECKPOINTS = [5, 10, 15, 20, 25, 50, 100, 150, 200];
const PERCENTILES = [10, 30, 60, 85, 97];
const TRUE_SKILL_SD = 8;
const ANCHOR_WINDOW = 15; // reuses XENITH.md's "anchor opponent within 15 rating points" rule
const ANCHOR_MAX_ATTEMPTS = 30;

// The original sim omitted the 10% forced cross-tier match (matchmaking.js's
// selectWeightedPair) entirely — omitting it shifts p10 from 7->0 and p30
// from 26->20 under the current formulas, material enough to model.
// Reproducing it here rather than reimplementing matchmaking.js's full opponent-
// selection cascade, since that file imports window.PluginApi-dependent
// modules (state.js) that can't load under plain Node.
const CROSS_TIER_CHANCE = 0.1;
const CROSS_TIER_MIN_GAP = 20;

function randInt(n) {
  return Math.floor(Math.random() * n);
}

function randNormal() {
  const u1 = Math.random() || 1e-9;
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function percentile(sortedAsc, p) {
  const idx = (p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  const frac = idx - lo;
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * frac;
}

function snapshotPercentiles(ratings, avgMatches) {
  const sorted = [...ratings].sort((a, b) => a - b);
  const values = PERCENTILES.map((p) => percentile(sorted, p));
  const ceilingPct = ((ratings.filter((r) => r === 100).length / ratings.length) * 100).toFixed(1);
  const floorPct = ((ratings.filter((r) => r === 0).length / ratings.length) * 100).toFixed(1);
  console.log(
    `avg ${avgMatches.toString().padStart(3)} matches/performer -> ` +
      PERCENTILES.map((p, i) => `p${p}=${values[i].toFixed(2)}`).join("  ") +
      `  | @100=${ceilingPct}%  @0=${floorPct}%`
  );
  return values;
}

const trueSkill = new Array(POPULATION)
  .fill(0)
  .map(() => Math.min(100, Math.max(0, 50 + TRUE_SKILL_SD * randNormal())));

const rating100 = new Array(POPULATION).fill(DEFAULT_RATING);
const matchCount = new Array(POPULATION).fill(0);

const systemConfig = computeSystemConfig(POPULATION);
console.log("systemConfig for N=%d:", POPULATION, systemConfig);

const totalPairwiseMatches = Math.round((POPULATION * AVG_MATCHES_PER_PERFORMER) / 2);
const checkpointMatches = new Set(CHECKPOINTS.map((avg) => Math.round((POPULATION * avg) / 2)));

let played = 0;
while (played < totalPairwiseMatches) {
  const i = randInt(POPULATION);
  let j = null;

  // 10% forced cross-tier match, mirroring selectWeightedPair: wide gap
  // (>=20). Falls through to the normal anchor-window pick below if no
  // eligible candidate turns up within the attempt budget — same cascade
  // shape as production's cross-tier -> 15pt anchor -> wider failovers.
  if (Math.random() < CROSS_TIER_CHANCE) {
    let attempts = 0;
    let candidate = randInt(POPULATION);
    while (
      attempts < ANCHOR_MAX_ATTEMPTS &&
      (candidate === i || Math.abs(rating100[candidate] - rating100[i]) < CROSS_TIER_MIN_GAP)
    ) {
      candidate = randInt(POPULATION);
      attempts += 1;
    }
    if (candidate !== i && Math.abs(rating100[candidate] - rating100[i]) >= CROSS_TIER_MIN_GAP) {
      j = candidate;
    }
  }

  if (j === null) {
    j = randInt(POPULATION);
    let attempts = 0;
    while ((j === i || Math.abs(rating100[j] - rating100[i]) > ANCHOR_WINDOW) && attempts < ANCHOR_MAX_ATTEMPTS) {
      j = randInt(POPULATION);
      attempts += 1;
    }
    if (j === i) j = (i + 1) % POPULATION;
  }

  // Winner decided by hidden true skill via the same logistic form (D=35)
  // the real expected-score formula uses — a probability model for the
  // simulation, not a reimplementation of the rating math itself.
  const expectedI = 1 / (1 + Math.pow(10, (trueSkill[j] - trueSkill[i]) / 35));
  const iWins = Math.random() < expectedI;
  const winnerIdx = iWins ? i : j;
  const loserIdx = iWins ? j : i;

  const { winnerGain, loserLoss } = calculateMatchOutcome({
    winnerRating: rating100[winnerIdx],
    loserRating: rating100[loserIdx],
    winnerMatches: matchCount[winnerIdx],
    loserMatches: matchCount[loserIdx],
    systemConfig,
  });

  rating100[winnerIdx] = Math.min(100, Math.max(0, rating100[winnerIdx] + winnerGain));
  rating100[loserIdx] = Math.min(100, Math.max(0, rating100[loserIdx] - loserLoss));
  matchCount[winnerIdx] += 1;
  matchCount[loserIdx] += 1;

  played += 1;

  if (checkpointMatches.has(played)) {
    const avg = (played * 2) / POPULATION;
    snapshotPercentiles(rating100, avg);
  }
}

console.log("\nFinal settled distribution (N=%d, %d avg matches/performer):", POPULATION, AVG_MATCHES_PER_PERFORMER);
const finalValues = snapshotPercentiles(rating100, AVG_MATCHES_PER_PERFORMER);

const atCeiling = rating100.filter((r) => r === 100).length;
const atFloor = rating100.filter((r) => r === 0).length;
console.log(`\n${atCeiling} of ${POPULATION} (${((atCeiling / POPULATION) * 100).toFixed(1)}%) settled at the rating ceiling (100).`);
console.log(`${atFloor} of ${POPULATION} (${((atFloor / POPULATION) * 100).toFixed(1)}%) settled at the rating floor (0).`);

console.log("\nTier boundary mapping (percentile -> tier floor):");
console.log(`  10th pct = ${finalValues[0].toFixed(2)}  (D floor)`);
console.log(`  30th pct = ${finalValues[1].toFixed(2)}  (C floor)`);
console.log(`  60th pct = ${finalValues[2].toFixed(2)}  (B floor)`);
console.log(`  85th pct = ${finalValues[3].toFixed(2)}  (A floor)`);
console.log(`  97th pct = ${finalValues[4].toFixed(2)}  (S floor)`);
