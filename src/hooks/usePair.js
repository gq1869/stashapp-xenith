// Mode-dispatching hook backing all three battle UIs (HeadToHead, Gauntlet,
// Champion each hold their own usePair() instance). Dispatches pair
// selection on `matchMode` (Swiss/Gauntlet/Champion) and, for the two run
// modes, reads/writes `persisted.gauntletRun`/`championRun` through a
// mode-agnostic `getRun`/`setRun` adapter so the rest of the hook doesn't
// need mode-specific branches. `computeRunAdvance` builds the
// `{runBefore, runNext, cooldownIds}` triple `commitMatch` persists for
// either run mode, and undo restores from the same history entries.
const { React } = window.PluginApi;
import { gqlMutate, UPDATE_PERFORMER, UPDATE_SCENE } from "../api";
import { calculateMatchOutcome, calculateDrawOutcome, DEFAULT_RATING } from "../elo";
import { invalidateRankCache } from "../badge-injector";
import { invalidateSceneTooltipCache } from "../scene-tooltips";
import {
  selectWeightedPair,
  selectGauntletPair,
  selectChampionPair,
  parseXenithStats,
  statsParseFailed,
  serializeStats,
  updateStatsAfterMatch,
  updateStatsAfterDraw,
  parseRecord,
  serializeRecord,
  appendRecordEntry,
  trackSelection,
  addToRecentlySelected,
  pushToRecentMatchBuffer,
  getSystemConfig,
} from "../matchmaking";
import { applyResult, runStatus } from "../gauntlet";
import { createReign, applyReignResult } from "../champion";
import { getPersistedPairState, setPersistedPairState, persisted } from "../state";
import { displayName } from "../format";
import { appendSessionMatch, markSessionMatchUndone, formatMatchLine, formatUndoLine } from "../session-log";
import { queueStashLog } from "../stash-log";

// 15, not 10: a full gauntlet run is up to MAX_MATCHES (gauntlet.js) = 14
// matches (a full champion reign is MAX_DEFENSES (champion.js) = 10), and
// undo should be able to walk back an entire in-progress run.
const MAX_HISTORY = 15;
const RESULT_DELAY_MS = 1000;

function sameGenders(a, b) {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

export function usePair(battleType, selectedGenders, matchMode) {
  const isGauntlet = matchMode === "gauntlet";
  const isChampion = matchMode === "champion";
  const hasRun = isGauntlet || isChampion;

  // Neither run mode reuses the Swiss pairStates cache — their real
  // persisted state is persisted.gauntletRun / persisted.championRun, and
  // the cached entry under this battleType could belong to Swiss (or a
  // previous run's leftover pair) rather than the run currently in
  // progress.
  const cached = getPersistedPairState(battleType);
  const canReuse =
    !hasRun &&
    !!cached &&
    !!cached.pair &&
    cached.battleType === battleType &&
    sameGenders(cached.selectedGenders, selectedGenders);
  const canReuseOnMount = React.useRef(canReuse).current;

  // Seed state directly from `cached` in the initializer (not via an effect)
  // so a reusable remount renders the existing pair immediately instead of
  // flashing loading and fetching a new random one.
  const [pair, setPair] = React.useState(canReuseOnMount ? cached.pair : null);
  const [ranks, setRanks] = React.useState(canReuseOnMount ? cached.ranks : [null, null]);
  const [loading, setLoading] = React.useState(!canReuseOnMount);
  const [error, setError] = React.useState(null);
  const [history, setHistory] = React.useState(canReuseOnMount ? cached.history || [] : []);
  const [result, setResult] = React.useState(null); // { winnerId, loserId, winnerGain, loserLoss } | null

  const resultTimer = React.useRef(null);
  const clearResultTimer = React.useCallback(() => {
    if (resultTimer.current) {
      clearTimeout(resultTimer.current);
      resultTimer.current = null;
    }
  }, []);

  // `result` (a useState value) is only set a full network
  // round-trip after choose/drawMatch/undo start, so it can't guard against
  // concurrent calls fired within that window (OS key-repeat, rapid
  // double-clicks, or opposite-direction input like ArrowLeft then
  // ArrowRight before the first vote lands). A ref is read/written
  // synchronously, closing that window. Shared across all three functions
  // (not one ref each) because a vote and an undo must also be mutually
  // exclusive — an undo racing a still-in-flight choose is the same class
  // of bug as two votes racing each other.
  const submittingRef = React.useRef(false);

  // Generation counter so a superseded or post-unmount response can't
  // clobber state — bumped on every new loadPair() call (capturing the new
  // value locally) and again on unmount, so a stale in-flight fetch is
  // detected either way: a newer call already bumped it past what this one
  // captured, or the component is gone.
  const loadGenerationRef = React.useRef(0);

  // The ladder index of the currently-displayed gauntlet probe (pair[1]) —
  // needed at commit time to call gauntlet.js's applyResult, but not part
  // of the pair/ranks state React re-renders on. Unused outside gauntlet
  // mode; Champion needs no equivalent since its "probe" is just pair[1]
  // itself, not a ladder position.
  const gauntletProbeIndexRef = React.useRef(null);

  // Mode-agnostic access to whichever run store is live — both gauntletRun
  // and championRun are namespaced by battle type, since both modes play
  // performers and scenes. Kept as plain functions rather than state so
  // matchmaking.js-style direct persisted.* reads/writes stay in sync with
  // components (Gauntlet.jsx/Champion.jsx) that also touch these stores
  // outside React.
  const getRun = React.useCallback(() => {
    if (isGauntlet) return persisted.gauntletRun[battleType];
    if (isChampion) return persisted.championRun[battleType];
    return null;
  }, [isGauntlet, isChampion, battleType]);

  const setRun = React.useCallback((next) => {
    if (isGauntlet) persisted.gauntletRun[battleType] = next;
    else if (isChampion) persisted.championRun[battleType] = next;
  }, [isGauntlet, isChampion, battleType]);

  // Builds the {runBefore, runNext, cooldownIds} triple commitMatch persists,
  // for whichever run mode is active. `outcome` is relative to pair[0] (the
  // incumbent side — challenger for Gauntlet, champion for Champion), the
  // same convention both choose() and drawMatch() below use to compute it.
  // Returns {} for Swiss, which commitMatch reads as "no run to touch."
  const computeRunAdvance = React.useCallback((outcome) => {
    if (isGauntlet) {
      const runBefore = getRun();
      if (!runBefore) return {};
      const advanced = applyResult(runBefore, { probeIndex: gauntletProbeIndexRef.current, outcome });
      // currentProbe is cleared, not carried over from `advanced` — the
      // just-resolved probe shouldn't be re-displayed; the next loadPair()
      // call picks a fresh one via selectGauntletPair's nextProbe.
      return { runBefore, runNext: { ...advanced, currentProbe: null }, cooldownIds: [pair[1]?.id] };
    }
    if (isChampion) {
      const runBefore = getRun();
      if (!runBefore) return {};
      const advanced = applyReignResult(runBefore, { outcome, challengerId: pair[1]?.id });
      // currentChallengerId is cleared, not carried over — the just-faced
      // challenger shouldn't be re-served; the next loadPair() call picks a
      // fresh one via selectChampionPair's opponent selection. `advanced` is
      // null when the reign just retired at MAX_DEFENSES (see
      // applyReignResult) — commitMatch/undo treat a null runNext the same
      // as any other value, so pass it through as-is.
      const runNext = advanced && { ...advanced, currentChallengerId: null };
      // Whoever is NOT the champion of the next reign: the challenger on a
      // defense or draw, the deposed champion on a dethrone.
      const cooldownId = outcome === 0 ? pair[0]?.id : pair[1]?.id;
      return { runBefore, runNext, cooldownIds: [cooldownId] };
    }
    return {};
  }, [isGauntlet, isChampion, getRun, pair]);

  const loadPair = React.useCallback(async () => {
    const generation = ++loadGenerationRef.current;
    setLoading(true);
    setError(null);
    try {
      if (isGauntlet) {
        const run = getRun();
        // No run started yet, or the run just terminated (placed/capped) —
        // Gauntlet.jsx reads persisted.gauntletRun directly to decide
        // between the challenger picker and the placement screen; usePair
        // has nothing to fetch either way.
        if (!run || runStatus(run) !== "active") {
          setPair(null);
          setRanks([null, null]);
          return;
        }
        const fetched = await selectGauntletPair(battleType, run, selectedGenders);
        if (loadGenerationRef.current !== generation) return; // superseded or unmounted
        if (!fetched) {
          setPair(null);
          setRanks([null, null]);
          return;
        }
        gauntletProbeIndexRef.current = fetched.probeIndex;
        // Cache the chosen probe on the run itself so a remount (e.g. a
        // round trip to the Leaderboard tab) re-hydrates the same pairing
        // instead of re-rolling a different one from selectGauntletPair's
        // candidate window.
        setRun({ ...run, currentProbe: fetched.currentProbe });
        setPair(fetched.pair);
        setRanks([null, null]);
        return;
      }
      if (isChampion) {
        const run = getRun();
        // No reign yet (first visit, or the previous one retired at
        // MAX_DEFENSES) — root one at whatever seed selectChampionPair's
        // fallback produces. `championId: null` guarantees the fallback
        // path (no pool entry has a null id), so this reuses the exact same
        // "champion not found" branch a stale/deleted champion would hit.
        // `run.currentChallengerId` pins the challenger so a remount mid-reign
        // re-shows the same one instead of rolling a new one.
        const fetched = await selectChampionPair(
          battleType,
          selectedGenders,
          run ? run.championId : null,
          run ? run.currentChallengerId : null
        );
        if (loadGenerationRef.current !== generation) return; // superseded or unmounted
        const baseRun = fetched.freshSeedId ? createReign(fetched.freshSeedId) : run;
        // Cache the challenger on the run itself, same rationale as
        // Gauntlet's currentProbe caching above.
        setRun({ ...baseRun, currentChallengerId: fetched.pair[1]?.id ?? null });
        setPair(fetched.pair);
        setRanks(fetched.ranks);
        return;
      }
      const fetched = await selectWeightedPair(battleType, selectedGenders);
      if (loadGenerationRef.current !== generation) return; // superseded or unmounted
      setPair(fetched.pair);
      setRanks(fetched.ranks);
    } catch (e) {
      if (loadGenerationRef.current !== generation) return;
      setError(/** @type {any} */(e).message);
    } finally {
      if (loadGenerationRef.current === generation) setLoading(false);
    }
  }, [battleType, selectedGenders, isGauntlet, isChampion, getRun, setRun]);

  React.useEffect(() => clearResultTimer, [clearResultTimer]);

  React.useEffect(() => {
    return () => {
      loadGenerationRef.current += 1; // invalidate any in-flight loadPair on unmount
    };
  }, []);

  const applyRating = React.useCallback(
    async (item, newRating, stats, extraFields = {}) => {
      const mutation = battleType === "scenes" ? UPDATE_SCENE : UPDATE_PERFORMER;
      // `stats` is null when the caller already determined the parse
      // failed (statsParseFailed), or when it's flagged despite being
      // truthy (e.g. undo replaying a stored pre-match snapshot) — either
      // way, omit the stats key rather than write over possibly-recoverable
      // data.
      const statsFields = stats && !statsParseFailed(stats) ? serializeStats(stats) : {};
      await gqlMutate(mutation, {
        id: item.id,
        rating100: newRating,
        custom_fields: { partial: { ...statsFields, ...extraFields } },
      });
    },
    [battleType]
  );

  // Single source of truth for "should we fetch on mount / on battleType or
  // gender change". First mount: skip the fetch if we seeded from a reusable
  // cache above. Every mount/dep-change after that: always fetch fresh.
  const didInit = React.useRef(false);
  React.useEffect(() => {
    clearResultTimer();
    setResult(null);
    if (!didInit.current) {
      didInit.current = true;
      if (canReuseOnMount) return;
      loadPair();
      return;
    }
    loadPair();
  // canReuseOnMount is `React.useRef(canReuse).current`, frozen at
  // first render and read only inside the `!didInit.current` first-run
  // branch above — it can never change on a later render of this hook
  // instance, so listing it as a dependency would be inert: `didInit` flips
  // to true after the first run, so every subsequent effect invocation
  // takes the unconditional `loadPair()` branch above regardless of
  // canReuseOnMount's value. Benign false positive.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadPair, clearResultTimer]);

  // persist on every change so a later unmount/remount can reuse it. Skipped
  // for both run modes — their real persisted state is persisted.gauntletRun
  // / persisted.championRun, and writing here would let a Swiss remount pick
  // up a stray run pair (or vice versa) via the shared per-battleType cache.
  React.useEffect(() => {
    if (hasRun) return;
    setPersistedPairState(battleType, { battleType, selectedGenders, pair, ranks, history });
  }, [battleType, selectedGenders, pair, ranks, history, hasRun]);

  const commitMatch = React.useCallback(
    async ({
      mutations,
      itemAId,
      itemBId,
      historyWinner,
      historyLoser,
      resultState,
      logEntry,
      // Run-mode-only (Gauntlet or Champion): the run snapshot from before
      // this match (stored in history so undo can restore it), the
      // already-advanced run to persist, and which id(s) to push onto the
      // cooldown buffer instead of the default [itemAId, itemBId]. The
      // caller (choose/drawMatch) computes runNext itself via its own
      // mode's reducer — commitMatch only persists it. Undefined for Swiss
      // matches.
      runBefore,
      runNext,
      cooldownIds,
    }) => {
      try {
        await Promise.all(mutations);
      } catch (e) {
        setError(/** @type {any} */(e).message);
        return;
      }

      trackSelection(battleType, itemAId);
      trackSelection(battleType, itemBId);
      addToRecentlySelected(battleType, itemAId);
      addToRecentlySelected(battleType, itemBId);

      // Cooldown buffer applies to both battle types — performers and
      // scenes each go through selectWeightedPair's cooldown filtering, in
      // separate sub-buffers since Stash IDs aren't namespaced by entity type.
      // One entry per match (both participant IDs together), so the buffer
      // holds a true MATCH_BUFFER_SIZE matches of cooldown. Gauntlet and
      // Champion are the exception: they push only the non-incumbent id,
      // not the pair — the incumbent side repeats every match of a run, and
      // several near-identical entries would flush the 20-slot buffer for
      // nothing.
      pushToRecentMatchBuffer(battleType, cooldownIds || [itemAId, itemBId]);

      if (runBefore !== undefined) {
        setRun(runNext);
      }

      invalidateRankCache();
      invalidateSceneTooltipCache();
      const logSeq = appendSessionMatch(logEntry);
      queueStashLog(formatMatchLine(logEntry));

      setHistory((h) => [
        ...h.slice(-(MAX_HISTORY - 1)),
        {
          type: battleType,
          displayPair: pair,
          displayRanks: ranks,
          winner: historyWinner,
          loser: historyLoser,
          runBefore,
          logSeq,
        },
      ]);

      setResult(resultState);
      clearResultTimer();
      resultTimer.current = setTimeout(() => {
        resultTimer.current = null;
        setResult(null);
        loadPair();
      }, RESULT_DELAY_MS);
    },
    [battleType, loadPair, pair, ranks, clearResultTimer, setRun]
  );

  const choose = React.useCallback(
    async (winner, loser) => {
      if (result || submittingRef.current) return; // outcome already showing, or a vote/undo already in flight
      submittingRef.current = true;
      try {
        setError(null);

        const winnerStats = parseXenithStats(winner);
        const loserStats = parseXenithStats(loser);
        // `?? DEFAULT_RATING` guards missing/null/undefined rating100 (unset
        // entities) from reaching the Elo expected-score formula — 0 is a
        // legitimate floored rating and must NOT fall back here.
        const winnerRating = winner.rating100 ?? DEFAULT_RATING;
        const loserRating = loser.rating100 ?? DEFAULT_RATING;

        const winnerRecord = parseRecord(winner);
        const loserRecord = parseRecord(loser);

        let systemConfig;
        try {
          systemConfig = await getSystemConfig(battleType);
        } catch (e) {
          setError(/** @type {any} */(e).message);
          return;
        }
        const { winnerGain, loserLoss } = calculateMatchOutcome({
          winnerRating,
          loserRating,
          winnerMatches: winnerStats.total_matches,
          loserMatches: loserStats.total_matches,
          systemConfig,
        });

        const newWinnerRating = Math.min(100, winnerRating + winnerGain);
        const newLoserRating = Math.max(0, loserRating - loserLoss);

        const now = new Date().toISOString();
        const winnerExtra = serializeRecord(
          appendRecordEntry(winnerRecord, {
            date: now,
            opponent: `${loser.id}:${displayName(loser)}`,
            won: true,
            ratingAfter: newWinnerRating,
          })
        );
        const loserExtra = serializeRecord(
          appendRecordEntry(loserRecord, {
            date: now,
            opponent: `${winner.id}:${displayName(winner)}`,
            won: false,
            ratingAfter: newLoserRating,
          })
        );

        // A genuine stats parse failure is flagged by parseXenithStats
        // (see statsParseFailed) — refuse to write that field rather than
        // overwrite possibly-recoverable data with freshly-incremented
        // defaults. `null` tells applyRating to omit the stats key entirely.
        const winnerStatsUpdate = statsParseFailed(winnerStats) ? null : updateStatsAfterMatch(winnerStats, true);
        const loserStatsUpdate = statsParseFailed(loserStats) ? null : updateStatsAfterMatch(loserStats, false);

        // Gauntlet/Champion: pair[0] is always the incumbent (challenger or
        // champion — selectGauntletPair/selectChampionPair both return
        // [incumbent, other]) regardless of which side the user picked as
        // winner/loser. Outcome is relative to the incumbent, not to
        // "winner" — the incumbent winning is 1, losing is 0.
        const { runBefore, runNext, cooldownIds } = hasRun
          ? computeRunAdvance(winner.id === pair[0]?.id ? 1 : 0)
          : {};

        await commitMatch({
          mutations: [
            applyRating(winner, newWinnerRating, winnerStatsUpdate, winnerExtra),
            applyRating(loser, newLoserRating, loserStatsUpdate, loserExtra),
          ],
          itemAId: winner.id,
          itemBId: loser.id,
          historyWinner: { id: winner.id, rating100: winnerRating, stats: winnerStats, record: winnerRecord },
          historyLoser: { id: loser.id, rating100: loserRating, stats: loserStats, record: loserRecord },
          resultState: { winnerId: winner.id, loserId: loser.id, winnerGain, loserLoss },
          logEntry: {
            ts: now,
            battleType,
            kind: "win",
            a: { id: winner.id, name: displayName(winner), ratingBefore: winnerRating, ratingAfter: newWinnerRating },
            b: { id: loser.id, name: displayName(loser), ratingBefore: loserRating, ratingAfter: newLoserRating },
          },
          runBefore,
          runNext,
          cooldownIds,
        });
      } finally {
        submittingRef.current = false;
      }
    },
    [battleType, applyRating, result, commitMatch, hasRun, computeRunAdvance, pair]
  );

  // Skip is a draw: both players get partial ELO credit, match counts tick up,
  // and a brief result overlay is shown before advancing to the next pair.
  const drawMatch = React.useCallback(
    async () => {
      if (result || !pair || submittingRef.current) return; // outcome already showing, no pair, or a vote/undo already in flight
      submittingRef.current = true;
      try {
        setError(null);

        const [itemA, itemB] = pair;

        const statsA = parseXenithStats(itemA);
        const statsB = parseXenithStats(itemB);
        const ratingA = itemA.rating100 ?? DEFAULT_RATING;
        const ratingB = itemB.rating100 ?? DEFAULT_RATING;

        const recordA = parseRecord(itemA);
        const recordB = parseRecord(itemB);

        let systemConfig;
        try {
          systemConfig = await getSystemConfig(battleType);
        } catch (e) {
          setError(/** @type {any} */(e).message);
          return;
        }
        const { deltaA, deltaB } = calculateDrawOutcome({
          ratingA,
          ratingB,
          matchesA: statsA.total_matches,
          matchesB: statsB.total_matches,
          systemConfig,
        });

        const newRatingA = Math.min(100, Math.max(0, ratingA + deltaA));
        const newRatingB = Math.min(100, Math.max(0, ratingB + deltaB));

        const now = new Date().toISOString();
        const extraA = serializeRecord(
          appendRecordEntry(recordA, {
            date: now,
            opponent: `${itemB.id}:${displayName(itemB)}`,
            draw: true,
            ratingAfter: newRatingA,
          })
        );
        const extraB = serializeRecord(
          appendRecordEntry(recordB, {
            date: now,
            opponent: `${itemA.id}:${displayName(itemA)}`,
            draw: true,
            ratingAfter: newRatingB,
          })
        );

        // See the matching comment in choose() — refuse to write the
        // stats field back when the parse itself failed.
        const statsAUpdate = statsParseFailed(statsA) ? null : updateStatsAfterDraw(statsA);
        const statsBUpdate = statsParseFailed(statsB) ? null : updateStatsAfterDraw(statsB);

        // itemA is always the incumbent (challenger or champion) in a run
        // mode, itemB the other side — destructured straight from `pair`,
        // which selectGauntletPair/selectChampionPair both return as
        // [incumbent, other]. Draw carries no directional signal — outcome
        // 0.5 regardless of side.
        const { runBefore, runNext, cooldownIds } = hasRun ? computeRunAdvance(0.5) : {};

        await commitMatch({
          mutations: [
            applyRating(itemA, newRatingA, statsAUpdate, extraA),
            applyRating(itemB, newRatingB, statsBUpdate, extraB),
          ],
          itemAId: itemA.id,
          itemBId: itemB.id,
          historyWinner: { id: itemA.id, rating100: ratingA, stats: statsA, record: recordA },
          historyLoser: { id: itemB.id, rating100: ratingB, stats: statsB, record: recordB },
          resultState: { isDraw: true, idA: itemA.id, idB: itemB.id, deltaA, deltaB },
          logEntry: {
            ts: now,
            battleType,
            kind: "draw",
            a: { id: itemA.id, name: displayName(itemA), ratingBefore: ratingA, ratingAfter: newRatingA },
            b: { id: itemB.id, name: displayName(itemB), ratingBefore: ratingB, ratingAfter: newRatingB },
          },
          runBefore,
          runNext,
          cooldownIds,
        });
      } finally {
        submittingRef.current = false;
      }
    },
    [battleType, applyRating, pair, result, commitMatch, hasRun, computeRunAdvance]
  );

  const skip = drawMatch;

  const undo = React.useCallback(async () => {
    if (submittingRef.current) return; // a vote/undo already in flight
    submittingRef.current = true;
    try {
      // Dismiss the outcome overlay and cancel its queued auto-advance
      // up front, before any await. By the time `result` is set,
      // commitMatch's mutations have already landed server-side (see
      // commitMatch), so nothing here needs to wait for the overlay to
      // finish — but undo's own network round-trip can outlast whatever's
      // left of RESULT_DELAY_MS, and a queued loadPair() firing mid-undo
      // would immediately clobber the restored pair below.
      clearResultTimer();
      setResult(null);

      // Read `last` and pop it from history atomically, inside the
      // functional updater, instead of reading `history` from the outer
      // closure and popping separately at the end. Two near-simultaneous
      // undo calls closure-reading the same `last` (before either pop
      // landed) is what let one of them discard the wrong snapshot — the
      // submittingRef guard above already prevents true concurrent
      // invocation, but this closes the same hole at its root regardless of
      // guard state.
      let last;
      setHistory((prev) => {
        last = prev[prev.length - 1];
        return last ? prev.slice(0, -1) : prev;
      });
      if (!last) return;

      const winnerExtra = serializeRecord(last.winner.record);
      const loserExtra = serializeRecord(last.loser.record);

      try {
        await Promise.all([
          applyRating(last.winner, last.winner.rating100, last.winner.stats, winnerExtra),
          applyRating(last.loser, last.loser.rating100, last.loser.stats, loserExtra),
        ]);
      } catch (e) {
        // Every write here is an absolute value from a stale local
        // baseline (last.winner.rating100/stats), not a delta — a rejected
        // Promise.all does not mean neither write landed (a timeout or a
        // dropped connection can still have committed server-side). We
        // don't know which, if either, succeeded, so we don't attempt a
        // compensating rollback either way — the correct recovery is a
        // retry, which is safe precisely because these writes are
        // idempotent/absolute rather than incremental. Put the popped
        // entry back so that retry (another Ctrl+Z) has the same snapshot
        // to work from, and surface the error the same way loadPair() does.
        setHistory((prev) => [...prev, last]);
        setError(/** @type {any} */(e).message);
        return;
      }

      invalidateRankCache();
      invalidateSceneTooltipCache();
      const undone = markSessionMatchUndone(last.logSeq);
      if (undone) queueStashLog(formatUndoLine(undone));
      // Restore the run to exactly how it stood before this match, only
      // after the mutations above are confirmed to have landed — the error
      // path above already re-pushed `last` onto history, so restoring the
      // run before that catch would desync run state from undo history on
      // a failed retry.
      if (last.runBefore) {
        setRun(last.runBefore);
        // Only Gauntlet needs the ladder-index ref restored — Champion has
        // no equivalent (its "probe" is just pair[1], not a ladder index).
        if (isGauntlet) {
          gauntletProbeIndexRef.current = last.runBefore.currentProbe?.index ?? null;
        }
      }
      setPair(last.displayPair);
      setRanks(last.displayRanks);
    } finally {
      submittingRef.current = false;
    }
  }, [applyRating, clearResultTimer, setRun, isGauntlet]);

  // `reload` (loadPair itself) is exposed for Gauntlet.jsx/Champion.jsx:
  // starting or advancing a run mutates persisted.gauntletRun /
  // persisted.championRun directly (outside React), which isn't one of
  // loadPair's own effect dependencies — the caller has to ask for a
  // refetch explicitly.
  return { pair, ranks, loading, error, choose, skip, undo, canUndo: history.length > 0, result, reload: loadPair };
}
