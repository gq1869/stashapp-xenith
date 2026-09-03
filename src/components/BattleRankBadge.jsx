const { React } = window.PluginApi;
import { getRatingTier, TIER_COLORS, DEFAULT_RATING, streakEmoji } from "../elo";
import { formatDisplayRating } from "../format";

// xenith_record entries store the opponent as "id:name" (matchmaking.js's
// RECORD_KEY comment) — split on the first colon only, since a name can
// legitimately contain one.
function parseOpponent(opponent) {
  const i = opponent.indexOf(":");
  if (i === -1) return { id: null, name: opponent };
  return { id: opponent.slice(0, i), name: opponent.slice(i + 1) };
}

function formatHistoryDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Worst to best — tier letters don't sort correctly as strings ("B" > "A"
// lexicographically, but A is the better tier), so arrow direction needs an
// explicit rank lookup.
const TIER_ORDER = ["F", "D", "C", "B", "A", "S"];

// Newest-first, capped at 10 (same cap the Ascension reference used).
// Tier-change arrows compare against the next-older entry in the *full*
// record, not just the visible slice, so the boundary entry still gets a
// correct arrow.
function HistoryDrawer({ record, battleType }) {
  const sorted = [...record].reverse();

  return (
    <div className="hon-history-drawer">
      {sorted.slice(0, 10).map((entry, i) => {
        const { id, name } = parseOpponent(entry.opponent);
        const kind = entry.draw ? "draw" : entry.won ? "win" : "loss";
        const tier = getRatingTier(entry.ratingAfter);
        const prev = sorted[i + 1];
        const prevTier = prev ? getRatingTier(prev.ratingAfter) : null;
        const tierChanged = prevTier && prevTier !== tier;

        return (
          <div className="hon-history-row" key={`${entry.date}-${i}`}>
            <span className="hon-history-date">{formatHistoryDate(entry.date)}</span>
            <span className={`hon-history-chip hon-history-chip-${kind}`}>{kind}</span>
            <span className="hon-history-opponent">
              vs{" "}
              {id ? (
                <a href={`/${battleType}/${id}`} target="_blank" rel="noreferrer">
                  {name}
                </a>
              ) : (
                name
              )}
            </span>
            <span className="hon-history-rating" style={{ color: TIER_COLORS[tier] }}>
              {formatDisplayRating(entry.ratingAfter)}
              {tierChanged && (
                <span className="hon-history-tier-change">
                  {TIER_ORDER.indexOf(tier) > TIER_ORDER.indexOf(prevTier) ? "▲" : "▼"}
                  {tier}
                </span>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function BattleRankBadge({ rank, total, rating100, stats, record, battleType, compact = false }) {
  const tier = getRatingTier(rating100 ?? DEFAULT_RATING);
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const hasHistory = !compact && record && record.length > 0;
  const streak = stats?.current_streak;

  const badge = (
    <div
      className={`hon-battle-rank-badge ${compact ? "xen-battle-rank-badge-compact" : ""}`}
      title={`Rank #${rank} of ${total} (Rating ${formatDisplayRating(rating100)})`}
    >
      {!compact && (
        <span className="hon-tier-chip" style={{ color: TIER_COLORS[tier], borderColor: TIER_COLORS[tier] }}>
          {tier}
        </span>
      )}
      <span className="hon-rank-text" style={{ color: TIER_COLORS[tier] }}>
        #{rank}
      </span>
      {!compact && <span className="hon-rank-total">of {total}</span>}
      {stats?.total_matches > 0 && (
        <span className="hon-match-stats">
          <span className="hon-wins">{stats.wins}W</span>
          <span className="hon-losses">{stats.losses}L</span>
          <span className="hon-draws">{stats.draws || 0}D</span>
        </span>
      )}
      {!compact && streak >= 2 && (
        <span className="hon-streak">
          {streakEmoji(streak)} {streak}
        </span>
      )}
      {hasHistory && (
        <button
          type="button"
          className="hon-history-toggle"
          aria-expanded={historyOpen}
          onClick={() => setHistoryOpen((open) => !open)}
        >
          History {historyOpen ? "▴" : "▾"}
        </button>
      )}
    </div>
  );

  if (!hasHistory) return badge;

  return (
    <div className="hon-rank-badge-detail">
      {badge}
      {historyOpen && <HistoryDrawer record={record} battleType={battleType} />}
    </div>
  );
}
