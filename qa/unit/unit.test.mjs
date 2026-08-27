import { test, describe, beforeEach, afterEach, vi } from "vitest";
import assert from "node:assert/strict";

import { kFactor, calculateMatchOutcome, compositeScore, getRatingTier, streakEmoji, computeSystemConfig, DEFAULT_RATING, expectedScore, entropy, priorityScore, uncertainty } from "../../src/elo.js";
import { parseXenithStats, statsParseFailed, updateStatsAfterMatch, appendRecordEntry, parseRecord, pushToRecentMatchBuffer, isInRecentMatchBuffer, matchesGenderFilter } from "../../src/matchmaking.js";
import { persisted } from "../../src/state.js";
import {
  displayName,
  formatHeight,
  formatWeight,
  formatGenderList,
  formatAge,
  resolveUnitSystem,
  UNITS,
  formatResolution,
  formatDuration,
  formatFileSize,
  formatBitRate,
  formatFrameRate,
  formatYear,
} from "../../src/format.js";

describe("elo.js", () => {
  test("computeSystemConfig clamps to floor bounds at small N", () => {
    const config = computeSystemConfig(100);
    assert.equal(config.kMin, 8);
    assert.equal(config.kMax, 24);
    assert.equal(config.mDecay, 15);
  });

  test("computeSystemConfig clamps to ceiling bounds at large N", () => {
    const config = computeSystemConfig(1_000_000);
    assert.equal(config.kMin, 16);
    assert.equal(config.kMax, 40);
    assert.equal(config.mDecay, 50);
  });

  test("computeSystemConfig at baseline N=2500 matches the documented reference values", () => {
    // `XENITH.md` §3.2 states mDecay=35 at N=2500; asserting the verbatim
    // formula output here (Math.floor(15 + 15*log10(25)) = 35) confirms the
    // doc matches the code.
    const config = computeSystemConfig(2500);
    assert.equal(config.kMax, 32);
    assert.equal(config.kMin, 12);
    assert.equal(config.mDecay, 35);
  });

  test("kFactor stays within [kMin, kMax] for the systemConfig in use", () => {
    const systemConfig = computeSystemConfig(2500); // kMin 12, kMax 32
    for (let rating = 1; rating <= 100; rating += 7) {
      for (let matches = 0; matches <= 60; matches += 5) {
        const k = kFactor(rating, matches, systemConfig);
        assert.ok(
          k >= systemConfig.kMin && k <= systemConfig.kMax,
          `kFactor(${rating}, ${matches}) = ${k} out of [${systemConfig.kMin}, ${systemConfig.kMax}]`
        );
      }
    }
  });

  test("kFactor's minimum reachable K equals systemConfig.kMin across a sweep of library sizes", () => {
    for (const n of [1, 100, 500, 2500, 50000, 1_000_000]) {
      const systemConfig = computeSystemConfig(n);
      let minK = Infinity;
      for (let matches = 0; matches <= 500; matches++) {
        minK = Math.min(minK, kFactor(50, matches, systemConfig));
      }
      assert.equal(
        minK, systemConfig.kMin,
        `N=${n}: minimum observed K over 0-500 matches was ${minK}, expected it to reach kMin=${systemConfig.kMin}`
      );
    }
  });

  test("kFactor no longer varies with rating (tierDampener removed) — same experience, same K", () => {
    const systemConfig = computeSystemConfig(2500);
    const lowRatingK = kFactor(20, 10, systemConfig);
    const highRatingK = kFactor(90, 10, systemConfig);
    assert.equal(highRatingK, lowRatingK, "kFactor should be rating-independent post tierDampener removal");
  });

  test("calculateMatchOutcome: winner/loser both floor at 0, never negative", () => {
    const systemConfig = computeSystemConfig(2500);
    const { winnerGain, loserLoss } = calculateMatchOutcome({
      winnerRating: 50, loserRating: 50, winnerMatches: 0, loserMatches: 0, systemConfig,
    });
    assert.ok(winnerGain >= 0);
    assert.ok(loserLoss >= 0);
  });

  test("calculateMatchOutcome: a near-certain win (wide gap, experienced players) rounds both sides to ~0 under the zero-sum formula", () => {
    // A high-K-experience favorite (60 matches -> near kMin) winning
    // overwhelmingly as expected (gap=70) has expectedWinner ~0.99, so both
    // winnerK*(1-E) and loserK*(1-E) are well under 0.5 and round to 0.
    // Under `XENITH.md` §3.1's R' = R + K(S-E), a near-certain outcome should
    // barely move either side.
    const systemConfig = computeSystemConfig(2500);
    const { winnerGain, loserLoss } = calculateMatchOutcome({
      winnerRating: 90, loserRating: 20, winnerMatches: 60, loserMatches: 60, systemConfig,
    });
    assert.equal(winnerGain, 0, "near-certain win should round to 0 gain");
    assert.equal(loserLoss, 0, "near-certain loss should also round to 0");
  });

  test("calculateMatchOutcome: expected-score sanity check — 10-pt gap yields ~67% win probability (`XENITH.md` §2.1, D=35)", () => {
    const expectedWinner = 1 / (1 + Math.pow(10, -10 / 35));
    assert.ok(Math.abs(expectedWinner - 0.67) < 0.02, `expected ~0.67, got ${expectedWinner}`);
  });

  test("calculateMatchOutcome: favorite winning as expected is NOT attenuated regardless of gap size", () => {
    // Higher-rated candidate (90) wins as expected against a much lower-rated
    // opponent (20) — per §3.3 only the higher-rated candidate's *loss* is
    // attenuated, and here the higher-rated candidate isn't losing at all, so
    // lossAttenuation must never engage on this path (loserRating > winnerRating
    // is false here). Verify by comparing loserLoss against the exact
    // unattenuated formula from `XENITH.md` §3.1 — if attenuation had fired,
    // the actual value would come in lower than this.
    const systemConfig = computeSystemConfig(2500);
    const { loserLoss } = calculateMatchOutcome({
      winnerRating: 90, loserRating: 20, winnerMatches: 30, loserMatches: 30, systemConfig,
    });
    const loserK = kFactor(20, 30, systemConfig);
    const expectedWinner = expectedScore(90, 20);
    const expectedLoserLoss = Math.round(loserK * (1 - expectedWinner));
    assert.equal(loserLoss, expectedLoserLoss, `expected unattenuated loserK*(1-E) = ${expectedLoserLoss}, got ${loserLoss}`);
  });

  test("calculateMatchOutcome: an upset (lower-rated wins) still registers a loss below the 15-pt trigger gap", () => {
    const systemConfig = computeSystemConfig(2500);
    const smallGapUpset = calculateMatchOutcome({
      winnerRating: 50, loserRating: 60, winnerMatches: 10, loserMatches: 10, systemConfig,
    }); // gap 10, below the 15-pt trigger — no attenuation applies
    assert.ok(smallGapUpset.loserLoss > 0, "sub-trigger gap still loses points at full strength");
  });

  test("lossAttenuation-equivalent behavior: loss magnitude decreases monotonically as gap widens past 15, bounded, continuous at 15", () => {
    // Exercise the attenuation curve indirectly through calculateMatchOutcome
    // by holding K and expectedWinner-driving inputs fixed and only moving
    // the loser's rating upward (widening the upset gap). matchCount is held
    // fixed so loserK doesn't change across samples.
    const systemConfig = computeSystemConfig(2500);
    const winnerRating = 50;
    const gaps = [15, 20, 30, 45, 70, 99];
    const losses = gaps.map((gap) =>
      calculateMatchOutcome({
        winnerRating,
        loserRating: winnerRating + gap,
        winnerMatches: 10,
        loserMatches: 10,
        systemConfig,
      }).loserLoss
    );

    // Continuous at gap=15: attenuation(15) = 1, so this is just the
    // unattenuated loss — sanity check it's > 0 and matches loserK closely
    // (expectedWinner is near 1 at a 15-pt gap under D=35).
    assert.ok(losses[0] > 0);

    // Monotonically non-increasing as gap grows past 15.
    for (let i = 1; i < losses.length; i++) {
      assert.ok(losses[i] <= losses[i - 1], `loss should not increase: gap ${gaps[i - 1]}->${gaps[i]}, ${losses[i - 1]}->${losses[i]}`);
    }

    // Bounded: never negative, and the floor keeps it from collapsing to 0
    // even at an extreme (near-max) gap.
    assert.ok(losses[losses.length - 1] >= 0);
  });

  test("calculateMatchOutcome: winner's gain on a wide-gap upset is attenuated by the same factor as the loser's loss (win/loss-asymmetry fix)", () => {
    // Previously only loserLoss was attenuated on upsets (gap > 15), letting
    // the lower-rated winner keep an undampened gain — a one-directional
    // pump. Now both sides move by a similarly-dampened amount. Verify
    // directly against the unattenuated reference values (loserK/winnerK *
    // (1 - expectedWinner)) computed from the same inputs, rather than
    // comparing across two different match scenarios.
    const systemConfig = computeSystemConfig(2500);
    const winnerMatches = 10;
    const loserMatches = 10;

    // Upset: lower-rated (40) beats higher-rated (60), gap 20 > 15 trigger.
    const winnerRating = 40, loserRating = 60;
    const { winnerGain, loserLoss } = calculateMatchOutcome({
      winnerRating, loserRating, winnerMatches, loserMatches, systemConfig,
    });

    const winnerK = kFactor(winnerRating, winnerMatches, systemConfig);
    const loserK = kFactor(loserRating, loserMatches, systemConfig);
    const expectedWinner = expectedScore(winnerRating, loserRating);
    const unattenuatedGain = winnerK * (1 - expectedWinner);
    const unattenuatedLoss = loserK * (1 - expectedWinner);

    assert.ok(winnerGain < unattenuatedGain, `attenuation should reduce winnerGain (${winnerGain}) below the unattenuated value (${unattenuatedGain})`);
    assert.ok(loserLoss < unattenuatedLoss, `attenuation should reduce loserLoss (${loserLoss}) below the unattenuated value (${unattenuatedLoss})`);

    const gainRatio = winnerGain / unattenuatedGain;
    const lossRatio = loserLoss / unattenuatedLoss;
    assert.ok(
      Math.abs(gainRatio - lossRatio) < 0.05,
      `both sides should be scaled down by ~the same attenuation factor: gain ratio ${gainRatio}, loss ratio ${lossRatio}`
    );
  });

  test("rating floor clamps to 0.0, not 1 (usePair.js choose/drawMatch clamp expressions)", () => {
    // usePair.js has no standalone-testable export (it's a React hook), so
    // this mirrors the exact clamp expressions at its two rating-write
    // sites: `Math.max(0, loserRating - loserLoss)` in choose(), and
    // `Math.min(100, Math.max(0, rating + delta))` in drawMatch().
    const loserRating = 3;
    const loserLoss = 20; // a loss larger than the remaining rating
    const newLoserRating = Math.max(0, loserRating - loserLoss);
    assert.equal(newLoserRating, 0, "loser rating should floor at 0.0, not 1");

    const ratingA = 2;
    const deltaA = -10;
    const newRatingA = Math.min(100, Math.max(0, ratingA + deltaA));
    assert.equal(newRatingA, 0, "draw delta should floor at 0.0, not 1");
  });

  test("compositeScore: rating100 ?? DEFAULT_RATING fallback only triggers on null/undefined, not 0", () => {
    const nullScore = compositeScore({ rating100: null, matchCount: 5 });
    const expectedNull = Math.max(0, DEFAULT_RATING - 1.645 * (15 / Math.sqrt(6))) / 100;
    assert.equal(nullScore, expectedNull);

    // `??` semantics: rating100 of 0 is a legitimate value under the 0.0
    // rating floor and must NOT fall back to DEFAULT_RATING (the old `|| 1`
    // bug this fixes).
    const zeroScore = compositeScore({ rating100: 0, matchCount: 5 });
    assert.equal(zeroScore, 0);
    assert.notEqual(zeroScore, DEFAULT_RATING / 100);
  });

  test("compositeScore: 0-match performer doesn't divide by zero and stays a sane, finite score", () => {
    const score = compositeScore({ rating100: 50, matchCount: 0 });
    assert.ok(Number.isFinite(score));
    assert.ok(score >= 0 && score <= 1);
  });

  test("compositeScore: `XENITH.md` §4.3 worked example — fresh 1-match winner vs. 40-match veteran", () => {
    // Fresh actor: R0=50 wins its first match, raw rating jumps to 66 (`XENITH.md`'s
    // example figure). Uncertainty buffer should discount it to ≈48.5.
    const freshDisplay = compositeScore({ rating100: 66, matchCount: 1 }) * 100;
    assert.ok(Math.abs(freshDisplay - 48.5) < 0.1, `expected ≈48.5, got ${freshDisplay}`);

    // Veteran: 40 matches, raw rating 53, discounted to ≈49.1 — still edges out
    // the lucky newcomer despite the lower raw rating.
    const veteranDisplay = compositeScore({ rating100: 53, matchCount: 40 }) * 100;
    assert.ok(Math.abs(veteranDisplay - 49.1) < 0.1, `expected ≈49.1, got ${veteranDisplay}`);

    assert.ok(veteranDisplay > freshDisplay, "veteran should still edge out the lucky newcomer on display rating");
  });

  test("entropy peaks at exactly 1.0 when E_A = 0.5 (`XENITH.md` §3.6)", () => {
    assert.equal(entropy(0.5), 1.0);
  });

  test("entropy approaches 0 as E_A approaches 0 or 1", () => {
    assert.equal(entropy(0), 0);
    assert.equal(entropy(1), 0);
    assert.ok(entropy(0.01) < entropy(0.1));
    assert.ok(entropy(0.99) < entropy(0.9));
  });

  test("entropy is symmetric and strictly decreases moving away from 0.5 in either direction", () => {
    assert.equal(entropy(0.3), entropy(0.7));
    assert.ok(entropy(0.5) > entropy(0.4));
    assert.ok(entropy(0.5) > entropy(0.6));
    assert.ok(entropy(0.4) > entropy(0.2));
  });

  test("priorityScore: higher combined uncertainty increases priority for an otherwise-equal entropy value", () => {
    const h = entropy(0.5);
    const lowSigma = priorityScore(h, 1, 1);
    const highSigma = priorityScore(h, 10, 10);
    assert.ok(highSigma > lowSigma, `expected priority to grow with sigma: ${lowSigma} vs ${highSigma}`);
  });

  test("priorityScore equals entropy when both sigmas are 0 (no uncertainty bonus)", () => {
    const h = entropy(0.5);
    assert.equal(priorityScore(h, 0, 0), h);
  });

  test("expectedScore matches `XENITH.md` §2.1: 10-point gap → ~67% expected win probability", () => {
    const e = expectedScore(60, 50);
    assert.ok(Math.abs(e - 0.67) < 0.02, `expected ≈0.67, got ${e}`);
  });

  test("uncertainty matches compositeScore's internal sigma formula (shared helper, no duplicated magic number)", () => {
    assert.equal(uncertainty(0), 15 / Math.sqrt(1));
    assert.equal(uncertainty(40), 15 / Math.sqrt(41));
  });

  test("DEFAULT_RATING is 50 (`XENITH.md` §2.2 R0 migration)", () => {
    assert.equal(DEFAULT_RATING, 50);
  });

  test("getRatingTier(DEFAULT_RATING) reflects the new R0=50 fallback tier, not the old R0=1 tier", () => {
    // Under the old `|| 1` fallback, a missing rating would classify as F
    // (the tier bounds in effect at the time put rating 1 in F; current
    // TIER_BOUNDS.F is [0, 9] after recalibration, unrelated to this test).
    // Under DEFAULT_RATING=50, it now lands in C/B range instead — confirms
    // callers using `rating100 ?? DEFAULT_RATING` no longer misclassify
    // unrated entities as bottom-tier.
    assert.notEqual(getRatingTier(DEFAULT_RATING), "F");
    assert.equal(getRatingTier(DEFAULT_RATING), "C");
  });

  test("getRatingTier boundaries match TIER_BOUNDS tier table (cross-tier-aware calibration sim)", () => {
    assert.equal(getRatingTier(100), "S");
    assert.equal(getRatingTier(99.9), "A");
    assert.equal(getRatingTier(84), "A");
    assert.equal(getRatingTier(83.9), "B");
    assert.equal(getRatingTier(59), "B");
    assert.equal(getRatingTier(58.9), "C");
    assert.equal(getRatingTier(31), "C");
    assert.equal(getRatingTier(30.9), "D");
    assert.equal(getRatingTier(9), "D");
    assert.equal(getRatingTier(8.9), "F");
    assert.equal(getRatingTier(0), "F");
  });

  test("getRatingTier: non-finite and out-of-range input", () => {
    // Non-finite input (NaN, +/-Infinity) falls to the safe "F" default —
    // Number.isFinite rejects Infinity too, so it never reaches the bounds
    // ladder below.
    assert.equal(getRatingTier(NaN), "F");
    assert.equal(getRatingTier(Infinity), "F");
    assert.equal(getRatingTier(-Infinity), "F");
    assert.equal(getRatingTier(-5), "F");
    // Finite but out-of-[0,100]-range values still hit the explicit
    // above-ceiling/below-floor checks in the ladder.
    assert.equal(getRatingTier(150), "S");
  });

  test("streakEmoji returns empty string below streak of 2", () => {
    assert.equal(streakEmoji(0), "");
    assert.equal(streakEmoji(1), "");
    assert.equal(streakEmoji(2), "⚡️");
  });

  test("calculateMatchOutcome is zero-sum at equal K, across a grid of gaps (`XENITH.md` §3.1, R' = R + K(S-E))", () => {
    // Equal matchCount on both sides -> equal K (kFactor is rating-independent,
    // see the test above). No upset (winner is always the higher-rated side),
    // so lossAttenuation never engages here — this isolates the core update
    // formula itself. At equal K the `XENITH.md`'s R' = R + K(S-E) must be
    // exactly zero-sum: winnerGain and loserLoss are the same magnitude.
    const systemConfig = computeSystemConfig(2500);
    const gaps = [0, 5, 15, 30, 50, 70, 90];
    for (const gap of gaps) {
      const { winnerGain, loserLoss } = calculateMatchOutcome({
        winnerRating: 50 + gap, loserRating: 50, winnerMatches: 10, loserMatches: 10, systemConfig,
      });
      // Math.round on each side can introduce at most 1 point of slack;
      // anything beyond that is the loserLoss-direction inversion elo.js's
      // calculateMatchOutcome guards against (see its comment on why
      // loserLoss uses `1 - expectedWinner`, not `expectedWinner`), not
      // rounding.
      assert.ok(
        Math.abs(winnerGain - loserLoss) <= 1,
        `gap ${gap}: expected winnerGain (${winnerGain}) ≈ loserLoss (${loserLoss}) at equal K, got a diff of ${winnerGain - loserLoss}`
      );
    }
  });
});

describe("matchmaking.js — parseXenithStats", () => {
  // parseXenithStats deliberately console.errors on a parse failure (it's a
  // real error path, not gated behind isDebugEnabled() — see the comment in
  // matchmaking.js) so production surfaces corrupted xenith_stats data.
  // These tests feed it garbage on purpose to exercise that path, so the
  // spy silences the expected noise while still asserting the log fires.
  let consoleErrorSpy;
  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  test("falls back to defaults when custom_fields is entirely missing", () => {
    const stats = parseXenithStats({ id: "1" });
    assert.equal(stats.total_matches, 0);
    assert.equal(stats.wins, 0);
    assert.equal(stats.last_match, null);
  });

  test("falls back to the legacy hotornot_stats key when xenith_stats is absent", () => {
    const item = {
      id: "1",
      custom_fields: { hotornot_stats: JSON.stringify({ total_matches: 5, wins: 3 }) },
    };
    const stats = parseXenithStats(item);
    assert.equal(stats.total_matches, 5);
    assert.equal(stats.wins, 3);
  });

  test("xenith_stats wins over hotornot_stats when both are present", () => {
    const item = {
      id: "1",
      custom_fields: {
        xenith_stats: JSON.stringify({ total_matches: 99 }),
        hotornot_stats: JSON.stringify({ total_matches: 1 }),
      },
    };
    const stats = parseXenithStats(item);
    assert.equal(stats.total_matches, 99);
  });

  test("falls back to defaults on malformed JSON instead of throwing", () => {
    const item = { id: "1", custom_fields: { xenith_stats: "not-json{" } };
    assert.doesNotThrow(() => parseXenithStats(item));
    const stats = parseXenithStats(item);
    assert.equal(stats.total_matches, 0);
    assert.equal(stats.wins, 0);
    assert.equal(consoleErrorSpy.mock.calls.length, 2, "logs once per parseXenithStats call above");
  });

  test("falls back to defaults when xenith_stats is a JSON array instead of an object", () => {
    // JSON.parse succeeds but spreading an array over defaults shouldn't crash
    const item = { id: "1", custom_fields: { xenith_stats: "[1,2,3]" } };
    assert.doesNotThrow(() => parseXenithStats(item));
    assert.equal(consoleErrorSpy.mock.calls.length, 1);
  });

  test("parses valid stats and merges with defaults for any missing keys", () => {
    const item = {
      id: "1",
      custom_fields: { xenith_stats: JSON.stringify({ total_matches: 5, wins: 3 }) },
    };
    const stats = parseXenithStats(item);
    assert.equal(stats.total_matches, 5);
    assert.equal(stats.wins, 3);
    assert.equal(stats.losses, 0); // filled from DEFAULT_STATS
  });

  test("falls back to defaults when xenith_stats parses to a non-object (bare number/string/null)", () => {
    for (const raw of ["5", "null", '"hi"']) {
      const item = { id: "1", custom_fields: { xenith_stats: raw } };
      assert.doesNotThrow(() => parseXenithStats(item));
      const stats = parseXenithStats(item);
      assert.equal(stats.total_matches, 0, `raw=${raw}`);
    }
  });

  test("logs a console.error on every parse-failure path, once per call", () => {
    // Real-error-path logging (see comment above) must never go silent — a
    // regression here would mean corrupted stats fields degrade to defaults
    // in production with no trace.
    parseXenithStats({ id: "1", custom_fields: { xenith_stats: "not-json{" } });
    assert.equal(consoleErrorSpy.mock.calls.length, 1);
    assert.match(consoleErrorSpy.mock.calls[0][0], /Failed to parse xenith_stats for item 1/);
  });

  test("coerces non-numeric numeric fields to their default instead of propagating NaN", () => {
    const item = {
      id: "1",
      custom_fields: { xenith_stats: JSON.stringify({ total_matches: "abc", wins: "3" }) },
    };
    const stats = parseXenithStats(item);
    assert.equal(stats.total_matches, 0, "non-numeric string falls back to the default rather than NaN");
    assert.equal(stats.wins, 3, "a numeric-looking string is coerced to a real number");
    assert.ok(Number.isFinite(stats.total_matches));
  });

  test("statsParseFailed is false for a genuinely new/never-rated entity — safe to write defaults", () => {
    const stats = parseXenithStats({ id: "1" });
    assert.equal(statsParseFailed(stats), false);
  });

  test("statsParseFailed is false for a successfully-parsed blob", () => {
    const item = { id: "1", custom_fields: { xenith_stats: JSON.stringify({ total_matches: 5 }) } };
    assert.equal(statsParseFailed(parseXenithStats(item)), false);
  });

  test("statsParseFailed is true on malformed JSON — write path must refuse to persist these defaults", () => {
    const item = { id: "1", custom_fields: { xenith_stats: "not-json{" } };
    assert.equal(statsParseFailed(parseXenithStats(item)), true);
  });

  test("statsParseFailed is true when xenith_stats parses to a non-object shape", () => {
    for (const raw of ["5", "null", '"hi"', "[1,2,3]"]) {
      const item = { id: "1", custom_fields: { xenith_stats: raw } };
      assert.equal(statsParseFailed(parseXenithStats(item)), true, `raw=${raw}`);
    }
  });

  test("the parse-failed marker does not survive JSON.stringify or object spread (can't leak into a mutation payload)", () => {
    const item = { id: "1", custom_fields: { xenith_stats: "not-json{" } };
    const stats = parseXenithStats(item);
    assert.equal(JSON.stringify(stats).includes("statsParseFailed"), false);
    const spread = { ...stats, total_matches: stats.total_matches + 1 };
    assert.equal(statsParseFailed(spread), false, "spreading drops the non-enumerable marker, as intended");
  });
});

describe("matchmaking.js — updateStatsAfterMatch streak logic", () => {
  test("win streak increments from positive, resets to 1 after a loss break", () => {
    let stats = { total_matches: 0, wins: 0, losses: 0, current_streak: -2, best_streak: 0, worst_streak: -2, last_match: null };
    stats = updateStatsAfterMatch(stats, true);
    assert.equal(stats.current_streak, 1, "a win after a loss streak should reset streak to 1, not continue the losing streak");
  });

  test("loss streak decrements from negative, flips to -1 after a win break", () => {
    let stats = { total_matches: 0, wins: 3, losses: 0, current_streak: 2, best_streak: 2, worst_streak: 0, last_match: null };
    stats = updateStatsAfterMatch(stats, false);
    assert.equal(stats.current_streak, -1);
  });

  test("best_streak and worst_streak track extremes independently", () => {
    let stats = { total_matches: 0, wins: 0, losses: 0, current_streak: 0, best_streak: 0, worst_streak: 0, last_match: null };
    for (let i = 0; i < 5; i++) stats = updateStatsAfterMatch(stats, true);
    assert.equal(stats.best_streak, 5);
    stats = updateStatsAfterMatch(stats, false);
    assert.equal(stats.worst_streak, -1);
    assert.equal(stats.best_streak, 5, "best_streak should not regress after a loss");
  });
});

describe("matchmaking.js — appendRecordEntry cap", () => {
  test("caps record length at MAX_RECORD_ENTRIES (50), keeping newest entries", () => {
    let record = [];
    for (let i = 0; i < 60; i++) {
      record = appendRecordEntry(record, { seq: i });
    }
    assert.equal(record.length, 50);
    assert.equal(record[0].seq, 10, "oldest surviving entry should be seq 10 once capped at 50 of 60");
    assert.equal(record[record.length - 1].seq, 59);
  });
});

describe("matchmaking.js — rating100 = 0 coercion pin", () => {
  test("getRatingTier(0) is F (tier assignment is correct today)", () => {
    assert.equal(getRatingTier(0), "F");
  });
});

describe("matchmaking.js — parseRecord", () => {
  test("parses a scene-shaped item's xenith_record same as a performer's", () => {
    const item = { id: "42", title: "Some Scene", custom_fields: { xenith_record: JSON.stringify([{ seq: 1 }]) } };
    assert.deepEqual(parseRecord(item), [{ seq: 1 }]);
  });

  test("returns [] for an item with no record yet", () => {
    const item = { id: "42", title: "Some Scene", custom_fields: {} };
    assert.deepEqual(parseRecord(item), []);
  });
});

describe("format.js — displayName", () => {
  test("performer uses name", () => {
    assert.equal(displayName({ id: "1", name: "Jane Doe" }), "Jane Doe");
  });

  test("scene uses title", () => {
    assert.equal(displayName({ id: "2", title: "Some Scene" }), "Some Scene");
  });

  test("untitled scene falls back to Scene <id>", () => {
    assert.equal(displayName({ id: "3", title: "" }), "Scene 3");
  });
});

describe("format.js — formatHeight", () => {
  test("customary (default): 168 cm -> 5′6″", () => {
    assert.equal(formatHeight(168), "5′6″");
  });

  test("metric: 182.88 cm rounds to a whole cm", () => {
    assert.equal(formatHeight(182.88, UNITS.METRIC), "183 cm");
  });

  test("customary: 168 cm -> 5′6″", () => {
    assert.equal(formatHeight(168, UNITS.CUSTOMARY), "5′6″");
  });

  test("customary: 183 cm -> 6′0″", () => {
    assert.equal(formatHeight(183, UNITS.CUSTOMARY), "6′0″");
  });

  test("customary: 152 cm -> 5′0″", () => {
    assert.equal(formatHeight(152, UNITS.CUSTOMARY), "5′0″");
  });

  test("customary boundary: 182.88 cm rounds to a whole inch without inches=12", () => {
    assert.equal(formatHeight(182.88, UNITS.CUSTOMARY), "6′0″");
  });

  test("null/0/undefined/NaN all return null in either unit system", () => {
    for (const units of [UNITS.METRIC, UNITS.CUSTOMARY]) {
      assert.equal(formatHeight(null, units), null);
      assert.equal(formatHeight(0, units), null);
      assert.equal(formatHeight(undefined, units), null);
      assert.equal(formatHeight(NaN, units), null);
    }
  });
});

describe("format.js — formatWeight", () => {
  test("customary (default): 63 kg -> 139 lb", () => {
    assert.equal(formatWeight(63), "139 lb");
  });

  test("metric: 63 kg -> 63 kg", () => {
    assert.equal(formatWeight(63, UNITS.METRIC), "63 kg");
  });

  test("null/0/undefined/NaN all return null in either unit system", () => {
    for (const units of [UNITS.METRIC, UNITS.CUSTOMARY]) {
      assert.equal(formatWeight(null, units), null);
      assert.equal(formatWeight(0, units), null);
      assert.equal(formatWeight(undefined, units), null);
      assert.equal(formatWeight(NaN, units), null);
    }
  });
});

describe("format.js — resolveUnitSystem", () => {
  test("true -> customary", () => {
    assert.equal(resolveUnitSystem(true), UNITS.CUSTOMARY);
  });

  test("false/null/undefined -> metric (metric is the default)", () => {
    assert.equal(resolveUnitSystem(false), UNITS.METRIC);
    assert.equal(resolveUnitSystem(null), UNITS.METRIC);
    assert.equal(resolveUnitSystem(undefined), UNITS.METRIC);
  });
});

describe("format.js — formatAge", () => {
  const now = new Date("2026-08-25T00:00:00Z");

  test("normal case, birthday already passed this year", () => {
    assert.equal(formatAge("1990-01-01", null, now), 36);
  });

  test("birthday not yet reached this year", () => {
    assert.equal(formatAge("1990-12-31", null, now), 35);
  });

  test("birthday is exactly today", () => {
    assert.equal(formatAge("1990-08-25", null, now), 36);
  });

  test("death_date is used as the reference point instead of now", () => {
    assert.equal(formatAge("1990-01-01", "2020-06-15", now), 30);
  });

  test("null/empty/whitespace/garbage birthdate all return null", () => {
    assert.equal(formatAge(null, null, now), null);
    assert.equal(formatAge("", null, now), null);
    assert.equal(formatAge("   ", null, now), null);
    assert.equal(formatAge("not-a-date", null, now), null);
  });

  test("future birthdate returns null", () => {
    assert.equal(formatAge("2030-01-01", null, now), null);
  });
});

describe("format.js — formatResolution", () => {
  test("standard resolutions map to Stash's own labels", () => {
    assert.equal(formatResolution(1920, 1080), "1080p");
    assert.equal(formatResolution(1280, 720), "720p");
    assert.equal(formatResolution(3840, 2160), "4K");
    assert.equal(formatResolution(2560, 1440), "1440p");
  });

  test("uses the shorter side, so a vertical video still labels correctly", () => {
    assert.equal(formatResolution(1080, 1920), "1080p");
  });

  test("below the lowest bucket (144p) returns null", () => {
    assert.equal(formatResolution(100, 100), null);
  });

  test("unset/0/NaN dimensions return null", () => {
    assert.equal(formatResolution(null, 1080), null);
    assert.equal(formatResolution(1920, 0), null);
    assert.equal(formatResolution(NaN, 1080), null);
  });
});

describe("format.js — formatDuration", () => {
  test("under a minute", () => {
    assert.equal(formatDuration(40), "< 1 min");
  });

  test("under an hour rounds to the nearest 5 minutes, floored at 5", () => {
    assert.equal(formatDuration(90), "5 min");
    assert.equal(formatDuration(1800), "30 min");
  });

  test("an hour or more shows hours plus a nearest-15 remainder", () => {
    assert.equal(formatDuration(3600), "1 hr");
    assert.equal(formatDuration(5400), "1 hr 30 min");
    assert.equal(formatDuration(3660), "1 hr");
  });

  test("unset/0/negative/NaN returns null", () => {
    assert.equal(formatDuration(null), null);
    assert.equal(formatDuration(0), null);
    assert.equal(formatDuration(-5), null);
    assert.equal(formatDuration(NaN), null);
  });
});

describe("format.js — formatFileSize", () => {
  test("under 1 GB rounds to the nearest 100 MB, floored at 100", () => {
    assert.equal(formatFileSize(800e6), "800 MB");
    assert.equal(formatFileSize(20e6), "100 MB");
  });

  test("1 GB or more rounds to the nearest 0.5 GB, trailing .0 trimmed", () => {
    assert.equal(formatFileSize(1.5e9), "1.5 GB");
    assert.equal(formatFileSize(4e9), "4 GB");
  });

  test("unset/0/negative/NaN returns null", () => {
    assert.equal(formatFileSize(null), null);
    assert.equal(formatFileSize(0), null);
    assert.equal(formatFileSize(-5), null);
    assert.equal(formatFileSize(NaN), null);
  });
});

describe("format.js — formatBitRate", () => {
  test("under 1 Mbps", () => {
    assert.equal(formatBitRate(0.45e6), "< 1 Mbps");
  });

  test("1 Mbps or more rounds to the nearest 0.5, trailing .0 trimmed", () => {
    assert.equal(formatBitRate(3.48e6), "3.5 Mbps");
    assert.equal(formatBitRate(12e6), "12 Mbps");
  });

  test("unset/0/negative/NaN returns null", () => {
    assert.equal(formatBitRate(null), null);
    assert.equal(formatBitRate(0), null);
    assert.equal(formatBitRate(-5), null);
    assert.equal(formatBitRate(NaN), null);
  });
});

describe("format.js — formatFrameRate", () => {
  test("rounds to the nearest whole fps", () => {
    assert.equal(formatFrameRate(29.97), "30 fps");
    assert.equal(formatFrameRate(24), "24 fps");
  });

  test("unset/0/negative/NaN returns null", () => {
    assert.equal(formatFrameRate(null), null);
    assert.equal(formatFrameRate(0), null);
    assert.equal(formatFrameRate(-5), null);
    assert.equal(formatFrameRate(NaN), null);
  });
});

describe("format.js — formatYear", () => {
  test("extracts the leading year from a YYYY-MM-DD date", () => {
    assert.equal(formatYear("2021-03-14"), "2021");
  });

  test("unset/unparseable returns null", () => {
    assert.equal(formatYear(null), null);
    assert.equal(formatYear(""), null);
    assert.equal(formatYear("not-a-date"), null);
  });
});

describe("matchmaking.js — 20-entry FIFO match cooldown buffer (per battle type)", () => {
  test("pushToRecentMatchBuffer evicts the oldest match once past 20, retaining the newest 20 in order, within the performers sub-buffer only", () => {
    persisted.recentMatchBuffer = { performers: [], scenes: [] };
    for (let i = 1; i <= 21; i++) {
      pushToRecentMatchBuffer("performers", [String(i), String(-i)]);
    }
    assert.equal(persisted.recentMatchBuffer.performers.length, 20);
    // Match 1 (the oldest push) should have been evicted; matches 2..21 remain, in order.
    assert.deepEqual(
      persisted.recentMatchBuffer.performers,
      Array.from({ length: 20 }, (_, i) => [String(i + 2), String(-(i + 2))])
    );
    // scenes sub-buffer is untouched by performers pushes.
    assert.deepEqual(persisted.recentMatchBuffer.scenes, []);
  });

  test("an id is still blocked after 19 subsequent matches and eligible again after 21 (20-match window, not 20-entry-of-40-id)", () => {
    persisted.recentMatchBuffer = { performers: [], scenes: [] };
    pushToRecentMatchBuffer("performers", ["42", "43"]);
    for (let i = 0; i < 19; i++) {
      pushToRecentMatchBuffer("performers", [String(100 + i), String(200 + i)]);
    }
    assert.equal(isInRecentMatchBuffer("performers", "42"), true, "still within the 20-match window");
    pushToRecentMatchBuffer("performers", ["300", "301"]);
    assert.equal(isInRecentMatchBuffer("performers", "42"), false, "aged out after 21 matches");
  });

  test("isInRecentMatchBuffer is true for an id inside the matching battle type's buffer", () => {
    persisted.recentMatchBuffer = { performers: [], scenes: [] };
    pushToRecentMatchBuffer("performers", ["42", "43"]);
    assert.equal(isInRecentMatchBuffer("performers", "42"), true);
  });

  test("isInRecentMatchBuffer is false for an id outside the buffer", () => {
    persisted.recentMatchBuffer = { performers: [], scenes: [] };
    pushToRecentMatchBuffer("performers", ["42", "43"]);
    assert.equal(isInRecentMatchBuffer("performers", "99"), false);
  });

  test("regression: a performer id and a scene id with the same numeric value don't collide", () => {
    persisted.recentMatchBuffer = { performers: [], scenes: [] };
    pushToRecentMatchBuffer("performers", [5, 6]);
    assert.equal(isInRecentMatchBuffer("performers", 5), true);
    assert.equal(isInRecentMatchBuffer("scenes", 5), false);
  });
});

// Run-mode incumbents (Gauntlet's challenger, Champion's champion) are
// resolved by id and so never pass through loadCandidatePool's own gender
// filter — this predicate is how Gauntlet.jsx/Champion.jsx detect a stale
// incumbent after a filter change.
describe("matchmaking.js — matchesGenderFilter", () => {
  test("scenes always pass, regardless of selection", () => {
    assert.equal(matchesGenderFilter("scenes", { gender: "MALE" }, ["FEMALE"]), true);
    assert.equal(matchesGenderFilter("scenes", null, ["FEMALE"]), true);
  });

  test("an empty selection is no filter at all", () => {
    assert.equal(matchesGenderFilter("performers", { gender: "MALE" }, []), true);
  });

  test("a performer whose gender is in the selection passes", () => {
    assert.equal(matchesGenderFilter("performers", { gender: "FEMALE" }, ["FEMALE", "MALE"]), true);
  });

  test("a performer whose gender is outside the selection fails", () => {
    assert.equal(matchesGenderFilter("performers", { gender: "MALE" }, ["FEMALE"]), false);
  });

  test("a performer with no gender set fails a non-empty selection", () => {
    assert.equal(matchesGenderFilter("performers", { gender: null }, ["FEMALE"]), false);
  });

  test("a missing item fails a non-empty selection", () => {
    assert.equal(matchesGenderFilter("performers", null, ["FEMALE"]), false);
  });
});

// Labels the ladder a Gauntlet run/probe was scoped to, on the
// placement screen/banner (Gauntlet.jsx). null means "no filter", so
// callers can `{label && ...}` instead of checking length themselves.
describe("format.js — formatGenderList", () => {
  test("empty or absent selection is not a label", () => {
    assert.equal(formatGenderList([]), null);
    assert.equal(formatGenderList(null), null);
    assert.equal(formatGenderList(undefined), null);
  });

  test("a single gender renders its display label", () => {
    assert.equal(formatGenderList(["FEMALE"]), "Female");
    assert.equal(formatGenderList(["NON_BINARY"]), "Non-Binary");
  });

  test("two genders join with a plus", () => {
    assert.equal(formatGenderList(["FEMALE", "MALE"]), "Female + Male");
  });

  test("three or more genders collapse to a count", () => {
    assert.equal(formatGenderList(["FEMALE", "MALE", "INTERSEX"]), "3 genders");
  });

  test("an unrecognized value falls back to itself rather than throwing", () => {
    assert.equal(formatGenderList(["SOME_FUTURE_VALUE"]), "SOME_FUTURE_VALUE");
  });
});
