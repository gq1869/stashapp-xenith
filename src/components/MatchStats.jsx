const { React } = window.PluginApi;
import { useLeaderboard } from "../hooks/useLeaderboard";
import { computeMatchStats } from "../match-stats";
import { formatDisplayRating } from "../format";
import { streakEmoji } from "../elo";

/** @param {{ label: string, value: any, sub?: string }} props */
function StatCard({ label, value, sub }) {
  return (
    <div className="hon-match-stats-card">
      <div className="hon-match-stats-card-label">{label}</div>
      <div className="hon-match-stats-card-value">{value}</div>
      {sub && <div className="hon-match-stats-card-sub">{sub}</div>}
    </div>
  );
}

/** @param {{ label: string, leader: any, format: (v: any) => string, sub?: string, entityPath: string }} props */
function LeaderCard({ label, leader, format, sub, entityPath }) {
  return (
    <div className="hon-match-stats-card">
      <div className="hon-match-stats-card-label">{label}</div>
      {leader ? (
        <>
          <a
            className="hon-match-stats-card-name"
            href={`/${entityPath}/${leader.id}`}
            target="_blank"
            rel="noreferrer"
          >
            {leader.name}
          </a>
          <div className="hon-match-stats-card-value">{format(leader.value)}</div>
          {sub && <div className="hon-match-stats-card-sub">{sub}</div>}
        </>
      ) : (
        <div className="hon-match-stats-card-value hon-match-stats-card-empty">—</div>
      )}
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className="hon-match-stats-section">
      <div className="hon-match-stats-section-title">{title}</div>
      <div className="hon-match-stats-grid">{children}</div>
    </div>
  );
}

export function MatchStats() {
  const { rows, error, battleType } = useLeaderboard();
  const stats = React.useMemo(() => (rows ? computeMatchStats(rows) : null), [rows]);
  const entityPath = battleType === "scenes" ? "scenes" : "performers";
  const scopeLabel = battleType === "scenes" ? "Scenes" : "Performers";

  if (error) return <div className="hon-error">{error}</div>;
  if (!rows) return <div className="hon-loading">Loading match stats...</div>;

  return (
    <div className="hon-match-stats-page">
      <div className="hon-stats-header">
        <h2 className="hon-stats-title">
          <span className="hon-stats-title-icon">📈</span> Match Stats
          <span className="hon-match-stats-scope">{scopeLabel}</span>
        </h2>
      </div>

      {!stats ? (
        <div className="hon-match-stats-empty">
          No matches recorded yet. Play a few Head to Head rounds.
        </div>
      ) : (
        <>
          <Section title="Pool">
            <StatCard label="Matches Played" value={stats.pool.matchesPlayed} />
            <StatCard
              label="Rated"
              value={`${stats.pool.ratedCount} / ${stats.pool.poolSize}`}
              sub={`${stats.pool.ratedPercent.toFixed(1)}% of pool`}
            />
            <StatCard label="Mean Matches" value={stats.pool.meanMatches.toFixed(1)} />
            <StatCard label="Median Matches" value={stats.pool.medianMatches} />
            <StatCard
              label="Wins / Losses / Draws"
              value={`${stats.pool.wins} / ${stats.pool.losses} / ${stats.pool.draws}`}
            />
          </Section>

          <Section title="Records">
            <LeaderCard label="Most Played" leader={stats.leaders.mostPlayed} format={(v) => `${v} matches`} entityPath={entityPath} />
            <LeaderCard label="Most Wins" leader={stats.leaders.mostWins} format={(v) => `${v} wins`} entityPath={entityPath} />
            <LeaderCard
              label="Best Win Rate"
              leader={stats.leaders.bestWinRate}
              format={(v) => `${(v * 100).toFixed(1)}%`}
              sub={`min. ${Math.ceil(stats.leaders.minMatches)} matches`}
              entityPath={entityPath}
            />
            <LeaderCard
              label="Highest Rated"
              leader={stats.leaders.highestRated}
              format={(v) => formatDisplayRating(v)}
              entityPath={entityPath}
            />
            <LeaderCard
              label="Lowest Rated"
              leader={stats.leaders.lowestRated}
              format={(v) => formatDisplayRating(v)}
              entityPath={entityPath}
            />
          </Section>

          <Section title="Streaks">
            <LeaderCard
              label="Longest Active Win Streak"
              leader={stats.streaks.longestActiveWin}
              format={(v) => `${streakEmoji(v)} W${v}`}
              entityPath={entityPath}
            />
            <LeaderCard
              label="Longest Active Loss Streak"
              leader={stats.streaks.longestActiveLoss}
              format={(v) => `L${v}`}
              entityPath={entityPath}
            />
            <LeaderCard
              label="Best Streak (All-Time)"
              leader={stats.streaks.bestAllTime}
              format={(v) => `${streakEmoji(v)} W${v}`}
              entityPath={entityPath}
            />
            <LeaderCard
              label="Worst Streak (All-Time)"
              leader={stats.streaks.worstAllTime}
              format={(v) => `L${v}`}
              entityPath={entityPath}
            />
          </Section>
        </>
      )}
    </div>
  );
}
