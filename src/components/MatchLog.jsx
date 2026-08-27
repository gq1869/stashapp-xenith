const { React } = window.PluginApi;
import { getSessionLog, clearSessionLog } from "../session-log";
import { formatDisplayRating } from "../format";

// Session-scoped, both battle types — this page reads src/session-log.js's
// in-memory store, not xenith_record, so it's scoped to what's been played
// this session rather than to one battle type. That's why the scope chip
// below says "This session" rather than "Performers"/"Scenes".

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** @param {{ entry: any }} props */
function LogRow({ entry }) {
  const { a, b, kind, battleType, ts, undone } = entry;
  const href = (id) => `/${battleType}/${id}`;

  return (
    <tr className={undone ? "hon-match-log-row hon-match-log-row-undone" : "hon-match-log-row"}>
      <td className="hon-match-log-time">{formatTime(ts)}</td>
      <td className="hon-match-log-result">
        {undone ? (
          <span className="hon-match-log-chip hon-match-log-chip-undone">Undone</span>
        ) : kind === "win" ? (
          <span className="hon-match-log-chip hon-match-log-chip-win">Win</span>
        ) : (
          <span className="hon-match-log-chip hon-match-log-chip-draw">Draw</span>
        )}
      </td>
      <td className="hon-match-log-names">
        <a className="hon-match-log-name" href={href(a.id)} target="_blank" rel="noreferrer">{a.name}</a>
        {kind === "win" ? " def. " : " vs "}
        <a className="hon-match-log-name" href={href(b.id)} target="_blank" rel="noreferrer">{b.name}</a>
      </td>
      <td className="hon-match-log-ratings">
        <span className="hon-match-log-rating-pair">{formatDisplayRating(a.ratingBefore)} → {formatDisplayRating(a.ratingAfter)}</span>
        {" / "}
        <span className="hon-match-log-rating-pair">{formatDisplayRating(b.ratingBefore)} → {formatDisplayRating(b.ratingAfter)}</span>
      </td>
    </tr>
  );
}

export function MatchLog() {
  // A plain counter to force a re-render after Clear — the log itself is
  // read straight from module scope (session-log.js), not React state, since
  // main.js's TABS lookup fully unmounts this page whenever another tab is
  // showing, so it can't go stale while visible.
  const [, bump] = React.useState(0);
  const entries = getSessionLog();

  function handleClear() {
    clearSessionLog();
    bump((n) => n + 1);
  }

  return (
    <div className="hon-match-log-page">
      <div className="hon-stats-header">
        <h2 className="hon-stats-title">
          <span className="hon-stats-title-icon">📜</span> Match Log
          <span className="hon-match-stats-scope">This session</span>
        </h2>
        <button className="hon-header-btn" onClick={handleClear} title="Clear" aria-label="Clear match log">
          🗑️
        </button>
      </div>

      {entries.length === 0 ? (
        <div className="hon-match-log-empty">No matches this session yet.</div>
      ) : (
        <table className="hon-match-log-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Result</th>
              <th>Match</th>
              <th>Rating</th>
            </tr>
          </thead>
          <tbody>
            {[...entries].reverse().map((entry, i) => (
              <LogRow key={`${entry.ts}-${i}`} entry={entry} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
