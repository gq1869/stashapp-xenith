const { React } = window.PluginApi;
import { usePair } from "../hooks/usePair";
import { MatchView } from "./HeadToHead";
import { pickRunChallenger, startGauntletRun, matchesGenderFilter } from "../matchmaking";
import { runStatus, runProgress } from "../gauntlet";
import { getRankedItems } from "../rank-cache";
import { persisted } from "../state";
import { getRatingTier, TIER_COLORS, DEFAULT_RATING } from "../elo";
import { formatGenderList } from "../format";
import { useNativeCard, handleNativeCardClick } from "../native-loader";
import { CardChips } from "./CardChips";
import { ShuffleIcon } from "./Icons";
import { useCardChips } from "../hooks/useCardChips";

// Gauntlet mode: one challenger gets placed against the ladder over a run
// of matches (see src/gauntlet.js for the placement math). Both battle
// types — persisted.gauntletRun is namespaced by battleType the same way
// Champion mode's persisted.championRun is.
export function Gauntlet({ battleType, selectedGenders }) {
  const pairApi = usePair(battleType, selectedGenders, "gauntlet");
  const { pair, loading, error, reload } = pairApi;
  const run = persisted.gauntletRun[battleType];

  // Seeded from persisted.gauntletPreview so a mode switch or tab round trip
  // (Leaderboard/Stats/Log and back) re-shows the same previewed challenger
  // instead of picking a new one — same rationale as gauntletRun surviving
  // unmount/remount.
  const [challenger, setChallenger] = React.useState(persisted.gauntletPreview[battleType]);
  const [challengerLoading, setChallengerLoading] = React.useState(false);
  const [challengerError, setChallengerError] = React.useState(null);

  const loadChallenger = React.useCallback(async (excludeIds) => {
    setChallengerLoading(true);
    setChallengerError(null);
    try {
      const picked = await pickRunChallenger(battleType, selectedGenders, excludeIds);
      persisted.gauntletPreview[battleType] = picked;
      setChallenger(picked);
    } catch (e) {
      setChallengerError(/** @type {any} */(e).message);
    } finally {
      setChallengerLoading(false);
    }
  }, [battleType, selectedGenders]);

  // Whenever there's neither a run in progress nor a previewed challenger
  // already stored, suggest one — covers first mount, right after a run
  // completes/is dropped, and right after the stale-preview reset below.
  // Self-guarding (bails once either exists), so it can't loop.
  React.useEffect(() => {
    if (run || persisted.gauntletPreview[battleType]) return;
    loadChallenger([]);
  }, [run, battleType, loadChallenger]);

  // A gender filter change can leave the run's challenger, or an
  // unstarted preview, outside the new filter — both are resolved by id
  // and so never pass through loadCandidatePool's own filter.
  // Membership-based, not change-based: broadening the filter shouldn't
  // disturb a run that still qualifies. Dropping an active run here is
  // correct — the posterior is entirely about that challenger's ladder
  // position, so there's nothing to carry over to a different one.
  React.useEffect(() => {
    if (run && pair && !matchesGenderFilter(battleType, pair[0], selectedGenders)) {
      persisted.gauntletRun[battleType] = null;
      reload();
      return;
    }
    if (!run) {
      const preview = persisted.gauntletPreview[battleType];
      if (preview && !matchesGenderFilter(battleType, preview, selectedGenders)) {
        persisted.gauntletPreview[battleType] = null;
        setChallenger(null);
      }
    }
  }, [battleType, selectedGenders, run, pair, reload]);

  async function handleStartRun() {
    // A gender filter narrow enough to leave a too-small ladder throws
    // (startGauntletRun's MIN_LADDER check, or — as a backstop —
    // src/gauntlet.js's createRun invariant) — surface it in the preview's
    // existing error slot rather than an unhandled rejection.
    try {
      const started = await startGauntletRun(battleType, challenger, selectedGenders);
      persisted.gauntletRun[battleType] = started;
      persisted.gauntletPreview[battleType] = null;
      setChallenger(null);
      reload();
    } catch (e) {
      setChallengerError(/** @type {any} */(e).message);
    }
  }

  function handleTryAnother() {
    loadChallenger(challenger ? [challenger.id] : []);
  }

  function handleNextChallenger() {
    persisted.gauntletRun[battleType] = null;
    reload();
  }

  const status = run ? runStatus(run) : null;

  if (run && status !== "active") {
    return <PlacementScreen battleType={battleType} run={run} onNext={handleNextChallenger} />;
  }

  if (run && status === "active") {
    // A gender filter narrowed mid-run can exhaust selectGauntletPair's
    // in-filter candidates before the run's own termination rule fires —
    // without this, `pair` stays null and MatchView renders
    // nothing, a silent dead end. Reuses handleNextChallenger; the run
    // itself is abandoned rather than resumed, same as the existing
    // stale-challenger drop just above.
    if (!pair && !loading && !error) {
      return (
        <div className="hon-run">
          <GauntletBanner progress={runProgress(run)} genderFilter={run.genderFilter} />
          <div className="hon-gauntlet-exhausted">
            <div className="hon-gauntlet-exhausted-message">No eligible opponents left under the current gender filter.</div>
            <button type="button" className="hon-choose-btn" onClick={handleNextChallenger}>Next Challenger</button>
          </div>
        </div>
      );
    }
    return (
      <div className="hon-run">
        <GauntletBanner progress={runProgress(run)} genderFilter={run.genderFilter} />
        <MatchView battleType={battleType} {...pairApi} />
      </div>
    );
  }

  return (
    <ChallengerPreview
      battleType={battleType}
      challenger={challenger}
      loading={challengerLoading}
      error={challengerError}
      onStart={handleStartRun}
      onTryAnother={handleTryAnother}
    />
  );
}

function GauntletBanner({ progress, genderFilter }) {
  const { matchesPlayed, maxMatches, intervalLo, intervalHi, ladderSize } = progress;
  const genderLabel = formatGenderList(genderFilter);
  return (
    <div className="hon-run-banner">
      <span className="hon-run-banner-count">Match {matchesPlayed + 1} of {maxMatches}</span>
      <span className="hon-run-banner-range">
        Narrowing to #{intervalLo + 1}–#{intervalHi + 1} of {ladderSize + 1}
        {genderLabel && ` (${genderLabel})`}
      </span>
    </div>
  );
}

function ChallengerPreview({ battleType, challenger, loading, error, onStart, onTryAnother }) {
  const isScenes = battleType === "scenes";
  const NativeCard = useNativeCard(isScenes ? "SceneCard" : "PerformerCard");
  const chips = useCardChips(challenger, isScenes ? "scenes" : "performers");

  return (
    <div className="hon-gauntlet-preview">
      <div className="hon-gauntlet-preview-heading">Gauntlet Challenger</div>
      {loading && <div className="hon-loading">Finding a challenger...</div>}
      {error && <div className="hon-error">{error}</div>}
      {!loading && !error && challenger && (
        <>
          <div className="hon-scene-card" data-side="left">
            <div className="hon-card-native-wrap" onClickCapture={handleNativeCardClick}>
              {NativeCard ? (
                isScenes ? <NativeCard scene={challenger} /> : <NativeCard performer={challenger} />
              ) : (
                <div className="hon-card-native-loading">Loading...</div>
              )}
            </div>
            <CardChips chips={chips} />
          </div>
          <div className="hon-gauntlet-preview-actions">
            <button type="button" className="hon-choose-btn" onClick={onStart}>Start Run</button>
            <button type="button" className="hon-action-btn" onClick={onTryAnother} title="Try another challenger" aria-label="Try another challenger">
              <ShuffleIcon />
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function PlacementScreen({ battleType, run, onNext }) {
  const { medianIndex, ladderSize } = runProgress(run);
  const placementRank = medianIndex + 1;
  const totalCount = ladderSize + 1;
  const placedRating = run.ladder[Math.min(medianIndex, run.ladder.length - 1)]?.rating ?? DEFAULT_RATING;
  const tier = getRatingTier(placedRating);

  // The placement rank above is by raw rating (what the run actually
  // searched on — see src/gauntlet.js and XENITH.md §3.8), and against the
  // ladder as filtered by run.genderFilter rather than the whole
  // pool — it won't match the Leaderboard's composite-sorted, pool-wide
  // rank, so both are shown with their basis labeled, rather than just one,
  // to avoid a placement rank like 12 reading like a bug next to a
  // different Leaderboard number.
  const genderLabel = formatGenderList(run.genderFilter);
  const [leaderboardRank, setLeaderboardRank] = React.useState(null);
  React.useEffect(() => {
    let cancelled = false;
    getRankedItems(battleType).then((ranked) => {
      if (cancelled) return;
      const entry = ranked.find((p) => p.id === run.challengerId);
      setLeaderboardRank(entry?.rank ?? null);
    });
    return () => { cancelled = true; };
  }, [battleType, run.challengerId]);

  return (
    <div className="hon-gauntlet-placement">
      <div className="hon-gauntlet-placement-heading">Placed!</div>
      <div className="hon-gauntlet-placement-rank" style={{ color: TIER_COLORS[tier] }}>
        #{placementRank} of {totalCount}{" "}
        <span className="hon-gauntlet-placement-basis">
          by rating{genderLabel && ` among ${genderLabel}`}
        </span>
      </div>
      <div className="hon-gauntlet-placement-tier">Tier {tier}</div>
      {leaderboardRank != null && (
        <div className="hon-gauntlet-placement-leaderboard">Leaderboard rank (all): #{leaderboardRank}</div>
      )}
      <button type="button" className="hon-choose-btn" onClick={onNext}>Next Challenger</button>
    </div>
  );
}
