// Gauntlet mode's placement engine: a Bayesian posterior over where a single
// challenger belongs in a frozen ladder snapshot, updated one probe match at
// a time. Pure and GraphQL-free, same contract as elo.js — nothing here
// touches the network or the DOM. src/matchmaking.js resolves the ladder
// (via rank-cache.js) and the challenger/probe candidates and passes plain
// data in.
//
// Why a posterior instead of a bracket binary search (the family's usual
// climb/fall or a hard-commit bisection): a single Elo outcome is
// stochastic, not a reliable comparator. A bracket's `hi = mid - 1` commits
// irreversibly on one coin-flip-odds result — an unlucky loss on the first
// probe permanently caps the final placement in the bottom half, with no way
// back. A posterior treats every probe as evidence rather than a commit:
// each update multiplies in a likelihood, so one surprising result shifts
// belief without discarding the rest of the ladder. See XENITH.md §3.8.
import { expectedScore, entropy } from "./elo";

export const MIN_MATCHES = 10;
export const MAX_MATCHES = 14;

// Smallest ladder a run can be started on. A run needs a distinct unfaced
// probe every match, so a ladder shorter than the match cap can dead-end by
// construction — matchmaking.js's startGauntletRun checks this before
// createRun even runs, on the (now filter-shrunk) ladder it
// builds. Also keeps the credible-interval floor below from producing a
// confident-looking "Placed!" over a near-uniform posterior: on a 5-entry
// ladder, targetIntervalWidth's floor of 5 covers the whole ladder.
export const MIN_LADDER = MAX_MATCHES;

// Narrowest 80% credible interval width (in ladder positions) that counts as
// "placed" once MIN_MATCHES has been played — floored so a tiny ladder still
// requires some real narrowing rather than trivially satisfying the bound.
function targetIntervalWidth(ladderSize) {
  return Math.max(5, Math.ceil(ladderSize * 0.02));
}

// Smallest index i such that the posterior's cumulative mass up to and
// including i is >= p. Used for both the median (p=0.5) and the credible
// interval bounds (p=0.1, p=0.9).
function cdfIndex(posterior, p) {
  let cumulative = 0;
  for (let i = 0; i < posterior.length; i++) {
    cumulative += posterior[i];
    if (cumulative >= p) return i;
  }
  return posterior.length - 1;
}

function weightedPick(items, weightFn) {
  const weights = items.map(weightFn);
  const total = weights.reduce((a, b) => a + b, 0);
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

// `ladder`: [{ id, rating }], sorted descending by rating, challenger
// excluded by the caller. One posterior hypothesis per ladder entry — the
// hypothesis "the challenger belongs at this ladder position" carries that
// position's rating as its own for likelihood purposes.
export function createRun({ challengerId, ladder }) {
  if (!Array.isArray(ladder) || ladder.length < 2) {
    throw new Error("Gauntlet requires a ladder of at least 2 items.");
  }
  const n = ladder.length;
  return {
    challengerId,
    ladder,
    posterior: new Array(n).fill(1 / n),
    matchesPlayed: 0,
    facedIds: [],
  };
}

export function runProgress(run) {
  const medianIndex = cdfIndex(run.posterior, 0.5);
  const intervalLo = cdfIndex(run.posterior, 0.1);
  const intervalHi = cdfIndex(run.posterior, 0.9);
  return {
    matchesPlayed: run.matchesPlayed,
    maxMatches: MAX_MATCHES,
    medianIndex,
    intervalLo,
    intervalHi,
    ladderSize: run.ladder.length,
  };
}

export function runStatus(run) {
  if (run.matchesPlayed >= MAX_MATCHES) return "capped";
  if (run.matchesPlayed < MIN_MATCHES) return "active";
  const { intervalLo, intervalHi, ladderSize } = runProgress(run);
  const width = intervalHi - intervalLo + 1;
  return width <= targetIntervalWidth(ladderSize) ? "placed" : "active";
}

// Next probe opponent: the 5 ladder entries nearest the posterior median,
// excluding anyone already faced this run, weighted by outcome entropy
// against the median hypothesis — the same max-information-gain principle
// XENITH.md §3.6 uses for Swiss pairing, applied to a single challenger's
// placement instead of a whole pool. Returns null once the run has
// terminated or no unfaced candidates remain.
//
// `excludeIds` (optional): ids to exclude beyond facedIds — matchmaking.js's
// selectGauntletPair passes the ladder entries that have fallen outside a
// gender filter narrowed mid-run. Applied at selection time rather
// than by rebuilding the ladder: hypotheses are positional
// (posterior[i] <-> ladder[i]), so the ladder itself must stay frozen for a
// run's whole duration, or every already-played probe's evidence would be
// invalidated. This function stays pure and gender-agnostic either way — it
// only ever sees ids.
/** @param {{ excludeIds?: string[] }} [options] */
export function nextProbe(run, options = {}) {
  if (runStatus(run) !== "active") return null;

  const { medianIndex } = runProgress(run);
  const medianRating = run.ladder[medianIndex].rating;
  const faced = new Set(run.facedIds);
  const excluded = options.excludeIds ? new Set(options.excludeIds) : null;

  const candidates = run.ladder
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => !faced.has(entry.id) && !(excluded && excluded.has(entry.id)))
    .sort((a, b) => Math.abs(a.index - medianIndex) - Math.abs(b.index - medianIndex))
    .slice(0, 5);

  if (candidates.length === 0) return null;

  const picked = weightedPick(candidates, ({ entry }) =>
    entropy(expectedScore(medianRating, entry.rating))
  );
  return { id: picked.entry.id, index: picked.index };
}

// Applies one probe's outcome and returns a new run (never mutates the
// input) — the caller (usePair.js) stores this in undo history, so a shared,
// mutated-in-place run object would corrupt earlier snapshots.
//
// Likelihood per hypothesis i, against a probe at ladder index `probeIndex`
// (rating r_j): e = expectedScore(r_i, r_j).
//   win  -> post[i] *= e
//   loss -> post[i] *= (1 - e)
//   draw -> post[i] *= sqrt(e * (1 - e))  (Bradley-Terry draw likelihood —
//     peaks where e ~= 0.5, i.e. a draw is most informative near a tie and
//     carries no directional signal, unlike a win/loss).
export function applyResult(run, { probeIndex, outcome }) {
  const probeRating = run.ladder[probeIndex].rating;
  const probeId = run.ladder[probeIndex].id;

  const updated = run.posterior.map((prior, i) => {
    const e = expectedScore(run.ladder[i].rating, probeRating);
    let likelihood;
    if (outcome === 1) likelihood = e;
    else if (outcome === 0) likelihood = 1 - e;
    else likelihood = Math.sqrt(e * (1 - e));
    return prior * likelihood;
  });

  const total = updated.reduce((a, b) => a + b, 0);
  const posterior = Number.isFinite(total) && total > 0
    ? updated.map((v) => v / total)
    : run.posterior; // degenerate update (e.g. all-zero likelihoods) — keep prior rather than divide by zero

  return {
    ...run,
    posterior,
    matchesPlayed: run.matchesPlayed + 1,
    facedIds: [...run.facedIds, probeId],
  };
}
