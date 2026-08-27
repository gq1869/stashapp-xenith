import { test, describe } from "vitest";
import assert from "node:assert/strict";

import { computeMatchStats } from "../../src/match-stats.js";

function row(id, name, rating100, stats) {
  return {
    id,
    name,
    rating100,
    stats: {
      total_matches: 0,
      wins: 0,
      losses: 0,
      draws: 0,
      current_streak: 0,
      best_streak: 0,
      worst_streak: 0,
      last_match: null,
      ...stats,
    },
  };
}

describe("computeMatchStats", () => {
  test("returns null when no performer in the pool has a recorded match", () => {
    const rows = [row(1, "A", 50, {}), row(2, "B", 50, {})];
    assert.equal(computeMatchStats(rows), null);
  });

  test("matchesPlayed halves total participations, not raw total_matches sum", () => {
    // Two performers, one match each (they played each other): sum of
    // total_matches is 2 participations = 1 match played.
    const rows = [
      row(1, "A", 55, { total_matches: 1, wins: 1, losses: 0 }),
      row(2, "B", 45, { total_matches: 1, wins: 0, losses: 1 }),
    ];
    const stats = computeMatchStats(rows);
    assert.equal(stats.pool.participations, 2);
    assert.equal(stats.pool.matchesPlayed, 1);
  });

  test("medianMatches on an even-length pool averages the two middle values", () => {
    const rows = [
      row(1, "A", 50, { total_matches: 2 }),
      row(2, "B", 50, { total_matches: 4 }),
      row(3, "C", 50, { total_matches: 6 }),
      row(4, "D", 50, { total_matches: 8 }),
    ];
    const stats = computeMatchStats(rows);
    assert.equal(stats.pool.medianMatches, 5); // (4+6)/2
  });

  test("medianMatches on an odd-length pool takes the middle value", () => {
    const rows = [
      row(1, "A", 50, { total_matches: 2 }),
      row(2, "B", 50, { total_matches: 4 }),
      row(3, "C", 50, { total_matches: 6 }),
    ];
    const stats = computeMatchStats(rows);
    assert.equal(stats.pool.medianMatches, 4);
  });

  test("bestWinRate excludes a 1-0 newcomer under the floored-median qualifier", () => {
    const rows = [
      // Median of [1, 20, 20, 20, 20] is 20 -> minMatches = max(5, 20) = 20.
      row(1, "Newcomer", 90, { total_matches: 1, wins: 1 }), // 100% but unqualified
      row(2, "Veteran", 60, { total_matches: 20, wins: 15, losses: 5 }), // 75%, qualified
      row(3, "C", 50, { total_matches: 20, wins: 10, losses: 10 }),
      row(4, "D", 50, { total_matches: 20, wins: 10, losses: 10 }),
      row(5, "E", 50, { total_matches: 20, wins: 10, losses: 10 }),
    ];
    const stats = computeMatchStats(rows);
    assert.equal(stats.leaders.bestWinRate.id, 2);
    assert.equal(stats.leaders.bestWinRate.name, "Veteran");
  });

  test("all-draws pool does not crown a bogus 0% win-rate leader", () => {
    const rows = [
      row(1, "A", 50, { total_matches: 10, wins: 0, losses: 0, draws: 10 }),
      row(2, "B", 50, { total_matches: 10, wins: 0, losses: 0, draws: 10 }),
    ];
    const stats = computeMatchStats(rows);
    assert.equal(stats.leaders.bestWinRate, null);
  });

  test("ties resolve to the first row in input order (rank-cache.js's composite-desc sort)", () => {
    const rows = [
      row(1, "First", 50, { total_matches: 10, wins: 10 }),
      row(2, "Second", 50, { total_matches: 10, wins: 10 }),
    ];
    const stats = computeMatchStats(rows);
    assert.equal(stats.leaders.mostWins.id, 1);
    assert.equal(stats.leaders.mostPlayed.id, 1);
  });

  test("highest/lowest rated only consider rated (matched) performers", () => {
    const rows = [
      row(1, "Unrated", 99, {}), // never matched — must be excluded despite the high rating100
      row(2, "Rated", 40, { total_matches: 3 }),
    ];
    const stats = computeMatchStats(rows);
    assert.equal(stats.leaders.highestRated.id, 2);
    assert.equal(stats.leaders.lowestRated.id, 2);
  });

  test("streak leaders split active win/loss and all-time best/worst correctly", () => {
    const rows = [
      row(1, "OnAWinStreak", 60, { total_matches: 5, current_streak: 3, best_streak: 3, worst_streak: -1 }),
      row(2, "OnALossStreak", 40, { total_matches: 5, current_streak: -4, best_streak: 2, worst_streak: -4 }),
      row(3, "Cooled", 50, { total_matches: 5, current_streak: 0, best_streak: 6, worst_streak: -6 }),
    ];
    const stats = computeMatchStats(rows);
    assert.equal(stats.streaks.longestActiveWin.id, 1);
    assert.equal(stats.streaks.longestActiveWin.value, 3);
    assert.equal(stats.streaks.longestActiveLoss.id, 2);
    assert.equal(stats.streaks.longestActiveLoss.value, 4);
    assert.equal(stats.streaks.bestAllTime.id, 3);
    assert.equal(stats.streaks.bestAllTime.value, 6);
    assert.equal(stats.streaks.worstAllTime.id, 3);
    assert.equal(stats.streaks.worstAllTime.value, 6);
  });
});
