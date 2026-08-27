const { React } = window.PluginApi;
import { usePair } from "../hooks/usePair";
import { MatchView } from "./HeadToHead";
import { reignStatus, createReign } from "../champion";
import { streakEmoji } from "../elo";
import { persisted } from "../state";
import { pickRunChallenger, matchesGenderFilter } from "../matchmaking";
import { ShuffleIcon } from "./Icons";

const RETIRED_NOTICE_MS = 4000;

// Champion mode: an incumbent stays on the stage defending against a stream
// of new challengers as long as it keeps winning (see src/champion.js for
// the reign reducer). Both battle types — unlike Gauntlet, Champion has no
// ladder dependency, so there's no preview/placement screen split the way
// Gauntlet.jsx has: the banner and MatchView render unconditionally, same
// as HeadToHeadInner, and a reign just keeps rolling forward (or
// resetting) under it.
export function Champion({ battleType, selectedGenders }) {
  const pairApi = usePair(battleType, selectedGenders, "champion");
  const { pair, reload } = pairApi;
  const run = persisted.championRun[battleType];

  // Shuffles in a different starting champion before the reign has defended
  // anything — the equivalent of Gauntlet's "Try another" re-roll on its
  // challenger preview. Champion has
  // no preview screen to host that button on, so it lives in the banner
  // instead, gated to defenses === 0 since there's nothing to reroll away
  // from once a defense is on the board.
  const [shuffling, setShuffling] = React.useState(false);
  const [shuffleError, setShuffleError] = React.useState(null);

  async function handleShuffle() {
    if (!run) return;
    setShuffling(true);
    setShuffleError(null);
    try {
      const picked = await pickRunChallenger(battleType, selectedGenders, [run.championId]);
      persisted.championRun[battleType] = createReign(picked.id);
      prevRef.current = null; // manual swap, not a retirement — suppress the "previous reign" notice
      reload();
    } catch (e) {
      setShuffleError(/** @type {any} */(e).message);
    } finally {
      setShuffling(false);
    }
  }

  // Detects a reign transition to show a one-shot "previous reign" notice
  // when a champion retires at MAX_DEFENSES (src/champion.js) — a dethrone
  // (the challenger we just fought becomes the new champion) needs no
  // notice, since the loss itself is the story the outcome overlay already
  // tells.
  const prevRef = React.useRef(null);
  const [retiredNotice, setRetiredNotice] = React.useState(null);
  const noticeTimerRef = React.useRef(null);

  React.useEffect(() => {
    return () => {
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    };
  }, []);

  React.useEffect(() => {
    if (!run || !pair) return;
    const prev = prevRef.current;
    if (prev && prev.championId !== run.championId) {
      if (run.championId === prev.challengerId) {
        setRetiredNotice(null);
      } else {
        setRetiredNotice(`Previous reign: ${prev.championName} — ${prev.defenses} defended`);
        if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
        noticeTimerRef.current = setTimeout(() => setRetiredNotice(null), RETIRED_NOTICE_MS);
      }
    }
    prevRef.current = {
      championId: run.championId,
      championName: pair[0]?.name ?? pair[0]?.title,
      challengerId: pair[1]?.id,
      defenses: run.defenses,
    };
  }, [run, pair]);

  // A gender filter change can leave the reign's champion or pinned
  // challenger outside the new filter — both are resolved by id
  // (fetchById in selectChampionPair) and so never pass through
  // loadCandidatePool's own filter. Membership-based, not
  // change-based: broadening the filter shouldn't disturb a reign that
  // still qualifies.
  React.useEffect(() => {
    if (!run || !pair) return;
    if (!matchesGenderFilter(battleType, pair[0], selectedGenders)) {
      // Champion itself is stale — drop the reign; loadPair's cold-start
      // branch (championId: null) roots a fresh one via selectChampionPair's
      // fallback. Not a retirement, so suppress the "previous reign" notice.
      persisted.championRun[battleType] = null;
      prevRef.current = null;
      reload();
      return;
    }
    if (!matchesGenderFilter(battleType, pair[1], selectedGenders)) {
      // Champion still qualifies, only the pinned challenger doesn't —
      // clear the pin so the next loadPair rolls a fresh one from the
      // newly-filtered pool.
      persisted.championRun[battleType] = { ...run, currentChallengerId: null };
      reload();
    }
  }, [battleType, selectedGenders, run, pair, reload]);

  return (
    <div className="hon-run">
      <ChampionBanner
        run={run}
        pair={pair}
        retiredNotice={retiredNotice}
        onShuffle={handleShuffle}
        shuffling={shuffling}
      />
      {shuffleError && <div className="hon-error">{shuffleError}</div>}
      <MatchView battleType={battleType} {...pairApi} />
    </div>
  );
}

function ChampionBanner({ run, pair, retiredNotice, onShuffle, shuffling }) {
  if (!run || !pair) return null;
  const { defenses, remaining } = reignStatus(run);
  const championName = pair[0]?.name ?? pair[0]?.title;
  return (
    <div className="hon-run-banner">
      <span className="hon-run-banner-count">
        👑 {championName} · {defenses} defended {streakEmoji(defenses)}
      </span>
      <span className="hon-run-banner-range">
        {retiredNotice ?? `${remaining} to retirement`}
        {defenses === 0 && (
          <button
            type="button"
            className="hon-run-banner-shuffle"
            onClick={onShuffle}
            disabled={shuffling}
            title="Shuffle in a different champion"
            aria-label="Shuffle in a different champion"
          >
            <ShuffleIcon />
          </button>
        )}
      </span>
    </div>
  );
}
