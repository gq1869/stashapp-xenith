const { React } = window.PluginApi;
import { parseXenithStats } from "../matchmaking";
import { getRatingTier, streakEmoji, DEFAULT_RATING } from "../elo";
import { useNativeCard, handleNativeCardClick } from "../native-loader";
import { CardChips } from "./CardChips";
import { useCardChips } from "../hooks/useCardChips";

export function SceneCard({ item, side, rank, onChoose, outcome, delta }) {
  // Native component bundle loads async via Stash's plugin API; null until ready.
  const NativeSceneCard = useNativeCard("SceneCard");
  const rating100 = item.rating100 ?? DEFAULT_RATING;
  const tier = getRatingTier(rating100);
  const stats = parseXenithStats(item);
  const chips = useCardChips(item, "scenes");
  const outcomeClass = outcome === "winner" ? "hon-outcome-winner" : outcome === "loser" ? "hon-outcome-loser" : outcome === "draw" ? "hon-outcome-draw" : "";

  return (
    <div className={`hon-scene-card tier-${tier.toLowerCase()} ${outcomeClass}`} data-side={side}>
      {/* Native card renders StashApp's own router <Link>s; intercept so they open in a new tab instead of navigating away from this battle modal. */}
      <div className="hon-card-native-wrap" onClickCapture={handleNativeCardClick}>
        {NativeSceneCard ? (
          <NativeSceneCard scene={item} />
        ) : (
          <div className="hon-card-native-loading">Loading...</div>
        )}
        {stats.current_streak >= 3 && (
          <div className="hon-streak-badge">
            {streakEmoji(stats.current_streak)} {stats.current_streak}
          </div>
        )}
        {rank != null && <span className="hon-scene-rank">#{rank}</span>}
        {delta != null && (
          <div className={`hon-delta-badge ${outcome === "draw" ? (delta > 0 ? "hon-delta-positive" : delta < 0 ? "hon-delta-negative" : "hon-delta-neutral") : outcome === "winner" ? "hon-delta-positive" : "hon-delta-negative"}`}>
            {delta > 0 ? `+${delta}` : delta}
          </div>
        )}
      </div>

      <CardChips chips={chips} />
      <button type="button" className="hon-choose-btn" onClick={onChoose}>✓ Choose This Scene</button>
    </div>
  );
}
