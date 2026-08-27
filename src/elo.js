// Single source of truth for all rating math. Nothing else in this codebase
// computes K-factor, gain/loss, or composite score independently.

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

// Default rating assumed when an entity's rating100 is missing (null or
// undefined) for live comparison or display math (matchmaking weighting,
// Elo inputs, tier classification). A rating100 of 0 is NOT "missing" — it's
// a legitimate floored rating (see the 0.0 rating floor, `XENITH.md` §3.1) and must reach
// this math unmodified. Callers must use `??`, never `||`, when applying
// this fallback, or a floored 0 gets silently teleported to 50.
export const DEFAULT_RATING = 50;

// System-scaled K-factor bounds, computed from a content type's live item
// count (Performers/Scenes resolved independently — see matchmaking.js).
// Log-scaled so a bigger library gets a wider velocity range without
// hand-tuning per deployment. mDecay is computed here but not yet wired into
// kFactor's sigmoid — see kFactor's comment.
export function computeSystemConfig(nTotal) {
  const kMin = clamp(Math.floor(8 + 3 * Math.log10(nTotal / 100)), 8, 16);
  const kMax = clamp(Math.floor(24 + 6 * Math.log10(nTotal / 100)), 24, 40);
  const mDecay = clamp(Math.floor(15 + 15 * Math.log10(nTotal / 100)), 15, 50);
  return { kMin, kMax, mDecay };
}

// Floor is 1/3: kFactor computes k = kMax * experienceFactor, then clamps to
// [kMin, kMax]. computeSystemConfig's kMin/kMax bounds give a kMin/kMax
// ratio ranging from 8/24 = 1/3 (smallest N, e.g. 100) up to 16/40 = 2/5
// (largest N, e.g. 1,000,000) — 1/3 is the minimum across the documented N
// range, so kMax * floor is <= kMin for every N, guaranteeing the
// Math.max(kMin, ...) clamp below actually reaches kMin as matchCount grows
// (exactly at the smallest-N case, via the floor clamp for every larger N).
// A higher floor would make kMin unreachable at any library size. Sigmoid
// midpoint (18 matches) and slope (/6) are unchanged — only the asymptote.
function experienceFactor(matchCount) {
  const FLOOR = 1 / 3;
  return FLOOR + (1 - FLOOR) / (1 + Math.exp((matchCount - 18) / 6));
}

// Sigmoid endpoints are dynamic, sourced from systemConfig: kMax is the rate
// new entities move at, kMin is a real, reachable floor (see
// experienceFactor's comment). systemConfig.mDecay is computed but not
// consumed here yet — wiring it into the decay curve is a later concern. No
// rating-based dampening here by design: one dampening mechanism only (this
// experience decay plus D=35's own compression at small gaps), no second
// per-tier multiplier. `rating` is accepted but intentionally unused —
// kept in the signature so a future dampening mechanism (if one is ever
// added) doesn't require a call-site change to every caller.
export function kFactor(rating, matchCount, systemConfig) {
  const { kMin, kMax } = systemConfig;
  const k = kMax * experienceFactor(matchCount);
  return Math.min(kMax, Math.max(kMin, Math.round(k)));
}

// Non-linear, bounded, continuous attenuation factor for a wide-gap upset
// (`XENITH.md` §3.3/§4.2). Applied to BOTH the higher-rated loser's point
// loss and the lower-rated winner's point gain by the caller below — see the
// symmetric-attenuation rationale there. attenuation(15) = 1 exactly (no
// discontinuity at the trigger gap), decays smoothly toward a floor that
// keeps upsets meaningful without ever hitting zero. Floor 0.15 / scale 20
// are starting constants, not derived from `XENITH.md` — chosen for
// monotonic/bounded behavior, not a specified value.
const PROTECTION_FLOOR = 0.15;
const PROTECTION_SCALE = 20;
function lossAttenuation(gap) {
  if (gap <= 15) return 1;
  return PROTECTION_FLOOR + (1 - PROTECTION_FLOOR) * Math.exp(-(gap - 15) / PROTECTION_SCALE);
}

// D=35 logistic expected-score formula (`XENITH.md` §2.1/§3.1) — the single
// implementation both outcome functions below and the entropy weighting in
// `matchmaking.js` call, rather than each inlining the divisor separately.
export function expectedScore(ratingA, ratingB) {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 35));
}

export function calculateMatchOutcome({ winnerRating, loserRating, winnerMatches, loserMatches, systemConfig }) {
  const expectedWinner = expectedScore(winnerRating, loserRating);

  const winnerK = kFactor(winnerRating, winnerMatches, systemConfig);
  const loserK = kFactor(loserRating, loserMatches, systemConfig);

  let winnerGain = winnerK * (1 - expectedWinner);
  let loserLoss = loserK * (1 - expectedWinner);

  // loserLoss uses the loser's own expected score (1 - expectedWinner),
  // matching `XENITH.md` §3.1's R' = R + K(S-E) with S=0 for the loser (not
  // the winner's expected score — that would invert the direction,
  // destroying a full K from the loser on an expected win and gaining
  // nothing on an upset). Both sides below are exactly zero-sum at equal K.

  // Both sides get attenuated together on an upset (loser outrated the
  // winner, gap > 15) — the lower-rated winner's gain as well as the
  // higher-rated loser's loss. Attenuating only the loser's side let a
  // wide-gap upset inject undampened points into the winner while the loser
  // was protected, a one-directional pump that drives systemic upward drift
  // (see TIER_BOUNDS's comment for the Monte Carlo evidence). A favorite
  // (the higher-rated side) winning as expected is still not damped either
  // side, per `XENITH.md` §3.3 — only a genuine upset triggers attenuation.
  if (loserRating > winnerRating) {
    const gap = loserRating - winnerRating;
    const attenuation = lossAttenuation(gap);
    winnerGain *= attenuation;
    loserLoss *= attenuation;
  }

  return {
    winnerGain: Math.max(0, Math.round(winnerGain)),
    loserLoss: Math.max(0, Math.round(loserLoss)),
  };
}

// Draw outcome: both players use S = 0.5 (neither wins). Higher-rated player
// will typically lose a small number of points; lower-rated will gain.
// Deltas are signed integers — callers clamp ratings to [0, 100].
export function calculateDrawOutcome({ ratingA, ratingB, matchesA, matchesB, systemConfig }) {
  const expectedA = expectedScore(ratingA, ratingB);
  const expectedB = 1 - expectedA;

  const kA = kFactor(ratingA, matchesA, systemConfig);
  const kB = kFactor(ratingB, matchesB, systemConfig);

  return {
    deltaA: Math.round(kA * (0.5 - expectedA)),
    deltaB: Math.round(kB * (0.5 - expectedB)),
  };
}

// Match-count-derived uncertainty (`XENITH.md` §3.4, sigma_A). Exported as its
// own function since both compositeScore's display-rating discount and
// `matchmaking.js`'s entropy-weighted pairing priority need the same value
// — kept in one place so the magic number 15 isn't duplicated.
export function uncertainty(matchCount) {
  return 15 / Math.sqrt(matchCount + 1);
}

// THE composite score. Leaderboard sort, badge rank, and scene-tooltip rank
// all call this — never re-derive it locally.
//
// Display rating: raw rating discounted by a match-count-derived uncertainty
// buffer (`XENITH.md` §3.4/§4.3), so a lucky low-match win doesn't outrank an
// established veteran. `??` (not `||`) on rating100 — 0 is a legitimate rating
// under the 0.0 rating floor, only null/undefined should fall back to DEFAULT_RATING.
export function compositeScore({ rating100, matchCount }) {
  const rating = rating100 ?? DEFAULT_RATING;
  const displayRating = Math.max(0, rating - 1.645 * uncertainty(matchCount));
  return displayRating / 100;
}

// Shannon binary entropy of a match outcome (`XENITH.md` §3.6), given the
// expected score of one side (E_A from expectedScore above). Peaks at 1.0
// exactly when E_A = 0.5 (a coin-flip outcome carries the most information);
// approaches 0 as E_A approaches 0 or 1 (a near-certain outcome carries
// little). log2(0) is undefined, so E_A at or past the boundary is defined
// as zero entropy rather than NaN.
export function entropy(expected) {
  if (expected <= 0 || expected >= 1) return 0;
  return -expected * Math.log2(expected) - (1 - expected) * Math.log2(1 - expected);
}

// Entropy-weighted pairing priority (`XENITH.md` §3.6): scales a pair's
// outcome entropy by its combined uncertainty, so a pair involving an
// undersampled (high-sigma) candidate is prioritized even when the raw
// entropy is identical to a better-sampled pair.
//
// Sigma is normalized against its own max (15, at matchCount=0, same
// ceiling uncertainty() uses) before the 0.5 coefficient is applied — an
// unnormalized 0.5*(sigmaA+sigmaB) on this system's actual 0-15 scale would
// let uncertainty dominate entropy by up to 15x, making priority mostly a
// novelty score with an entropy tiebreaker instead of the intended
// entropy-led signal. Normalizing keeps entropy the dominant term while
// still letting uncertainty break ties in favor of undersampled candidates.
export function priorityScore(h, sigmaA, sigmaB) {
  return h * (1 + 0.5 * ((sigmaA + sigmaB) / 15));
}

// Calibrated via Monte Carlo simulation against the real
// kFactor/calculateMatchOutcome/computeSystemConfig formulas above — not
// hand-picked. See qa/scripts/simulate-tier-bounds.mjs; rerun it and update
// this block whenever those formulas change.
//
// Methodology: 2500 performers, DEFAULT_RATING start, real elo.js formulas,
// 15-pt anchor-window opponent selection with a 10% forced cross-tier match
// (min 20-pt gap, mirroring matchmaking.js's selectWeightedPair),
// systemConfig = computeSystemConfig(2500), Normal(50, 8) hidden true skill,
// run to 200 avg matches/performer. Percentiles confirmed stable across 5
// reruns, all agreeing within +/-1 point.
//
// Settled percentiles (linear-interpolation method) on raw rating100:
//   10th pct = 9    (D floor)
//   30th pct = 31   (C floor)
//   60th pct = 59   (B floor)
//   85th pct = 84   (A floor)
//   97th pct = 100  (S floor)
//
// Ceiling occupancy ~3.0-3.6% (avg ~3.3%), floor ~3.4-4.0% — both close to
// `XENITH.md` §5's 3% target. S is structurally [100, 100] (a single
// point — a flat rating100-keyed lookup can't split tied ceiling mass
// further). The cross-tier match matters here: without it, opponent
// selection anchored purely on current rating lets rating-drifted outliers
// near a boundary only ever face other similarly-drifted opponents, driving
// ceiling/floor occupancy toward ~6-7% instead — see XENITH.md §5's
// implementation note for the full writeup of that failure mode. Re-verified after removing the
// S-excludes-sub-B `canBattleByTier` gate from matchmaking — bounds
// held unchanged, since the gate barely bound production selection to
// begin with.
export const TIER_BOUNDS = {
  S: [100, 100],
  A: [84, 100],
  B: [59, 84],
  C: [31, 59],
  D: [9, 31],
  F: [0, 9],
};

// Explicit descending ladder rather than iterating Object.entries(TIER_BOUNDS)
// in insertion order — relying on TIER_BOUNDS happening to be declared
// S-A-B-C-D-F would let reordering the object literal silently break tier
// assignment. Number.isFinite guards non-finite input to the "F" default,
// same as this function's below-floor behavior; the above-ceiling case is
// checked explicitly rather than relying on S's lower bound (100) to catch
// out-of-range values incidentally.
export function getRatingTier(rating) {
  if (!Number.isFinite(rating)) return "F";
  if (rating > TIER_BOUNDS.S[1]) return "S";
  if (rating >= TIER_BOUNDS.S[0]) return "S";
  if (rating >= TIER_BOUNDS.A[0]) return "A";
  if (rating >= TIER_BOUNDS.B[0]) return "B";
  if (rating >= TIER_BOUNDS.C[0]) return "C";
  if (rating >= TIER_BOUNDS.D[0]) return "D";
  return "F";
}

export const TIER_COLORS = {
  S: "#ffb300",
  A: "#ff3366",
  B: "#9d4edd",
  C: "#00b4d8",
  D: "#70e000",
  F: "#8a95a5",
};

export const STREAK_EMOJIS = [
  { min: 2, max: 3, symbol: "⚡️" },
  { min: 4, max: 6, symbol: "🔥" },
  { min: 7, max: 10, symbol: "❤️‍🔥" },
  { min: 11, max: 15, symbol: "✨" },
  { min: 16, max: Infinity, symbol: "👑" },
];

export function streakEmoji(streak) {
  if (!streak || streak < 2) return "";
  const match = STREAK_EMOJIS.find((s) => streak >= s.min && streak <= s.max);
  return match ? match.symbol : "";
}
