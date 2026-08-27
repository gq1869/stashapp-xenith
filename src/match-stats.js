// Pool-wide aggregation for the Match Stats page. Pure reduce
// over the rows getRankedItems() (rank-cache.js) already fetches and
// shapes — no separate GraphQL path. No React here either, so this stays
// unit-testable under qa/test:unit alongside elo.js/matchmaking.js.

import { getMedian } from "./matchmaking";

/**
 * @param {any[]} rows rank-cache.js rows: { id, name, rating100, stats, ... }
 * @returns {object | null} null when the pool has no recorded matches yet —
 *   drives MatchStats.jsx's empty state instead of a page full of zeros.
 */
export function computeMatchStats(rows) {
  const poolSize = rows.length;
  const ratedRows = rows.filter((r) => r.stats.total_matches > 0);
  if (ratedRows.length === 0) return null;

  const matchCounts = rows.map((r) => r.stats.total_matches);
  // Every match increments total_matches on both participants, so the raw
  // sum is participations, not matches — halve it for a matches-played count.
  const participations = matchCounts.reduce((a, b) => a + b, 0);
  const matchesPlayed = Math.floor(participations / 2);
  const meanMatches = participations / poolSize;
  const medianMatches = getMedian(matchCounts);

  const totals = rows.reduce(
    (acc, r) => {
      acc.wins += r.stats.wins;
      acc.losses += r.stats.losses;
      acc.draws += r.stats.draws;
      return acc;
    },
    { wins: 0, losses: 0, draws: 0 }
  );

  // Same floored-median baseline matchmaking.js's low-match boost uses
  // (calculateCandidateWeight's `Math.max(5, medianMatches)`), so a
  // "best win rate" leader can't be a 1-0 newcomer.
  const minMatches = Math.max(5, medianMatches);

  function leaderBy(pool, valueFn) {
    /** @type {any} */
    let best = null;
    let bestValue = -Infinity;
    for (const r of pool) {
      const v = valueFn(r);
      if (v > bestValue) {
        bestValue = v;
        best = r;
      }
    }
    return best ? { id: best.id, name: best.name, value: bestValue } : null;
  }

  const mostPlayed = leaderBy(rows, (r) => r.stats.total_matches);
  const mostWins = leaderBy(rows, (r) => r.stats.wins);
  // Excludes 0 wins too — an all-draws pool has every qualified candidate
  // tied at a 0% win rate, and crowning one of them "best" would be a bogus
  // leader rather than an honest "nobody has won a qualifying match yet".
  const qualifiedForWinRate = rows.filter((r) => r.stats.total_matches >= minMatches && r.stats.wins > 0);
  const bestWinRate = leaderBy(qualifiedForWinRate, (r) => r.stats.wins / r.stats.total_matches);
  const highestRated = leaderBy(ratedRows, (r) => r.rating100);
  const lowestRated = leaderBy(ratedRows, (r) => -r.rating100);
  if (lowestRated) lowestRated.value = -lowestRated.value;

  const activeWinStreaks = rows.filter((r) => r.stats.current_streak > 0);
  const activeLossStreaks = rows.filter((r) => r.stats.current_streak < 0);

  return {
    pool: {
      poolSize,
      ratedCount: ratedRows.length,
      ratedPercent: (ratedRows.length / poolSize) * 100,
      matchesPlayed,
      participations,
      meanMatches,
      medianMatches,
      wins: totals.wins,
      losses: totals.losses,
      draws: totals.draws,
    },
    leaders: {
      mostPlayed,
      mostWins,
      bestWinRate,
      minMatches,
      highestRated,
      lowestRated,
    },
    streaks: {
      longestActiveWin: leaderBy(activeWinStreaks, (r) => r.stats.current_streak),
      longestActiveLoss: leaderBy(activeLossStreaks, (r) => -r.stats.current_streak),
      bestAllTime: leaderBy(rows, (r) => r.stats.best_streak),
      worstAllTime: leaderBy(rows, (r) => -r.stats.worst_streak),
    },
  };
}
