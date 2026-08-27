// Pure, GraphQL-free — same purity contract as leaderboard-pagination.js/
// elo.js/gauntlet.js/champion.js/match-stats.js/card-chips.js. Column-width
// resolution for Leaderboard.jsx's table: widths must come from the
// full ranked record set once, not from whichever page happens to be
// rendered — otherwise table-layout: fixed's colgroup would re-widen/shrink
// every column on every page change.

import { formatDisplayRating } from "./format";

// Single source of truth for column identity/order/labels — Leaderboard.jsx
// imports this instead of keeping its own copy, so the widths computed here
// can never drift from what's actually rendered.
export const COLUMNS = [
  { key: "tier", label: "Tier" },
  { key: "name", label: "Name" },
  { key: "rating100", label: "Rating" },
  { key: "composite", label: "Score" },
  { key: "matches", label: "MP" },
  { key: "wins", label: "W" },
  { key: "losses", label: "L" },
  { key: "draws", label: "D" },
  { key: "streak", label: "↯" },
];

// name is the flex column (no measured width, just a floor) — every other
// column key above must round-trip through this.
const NAME_MIN_CH = 12;

// Same W{n}/L{n}/0 shape Leaderboard.jsx renders for the streak cell —
// exported so the two can't drift, per the module header above.
export function formatStreak(streak) {
  if (streak > 0) return `W${streak}`;
  if (streak < 0) return `L${Math.abs(streak)}`;
  return "0";
}

// Renders the same string each column's <td> actually displays, so a
// measured width matches the real content.
function cellText(row, key) {
  switch (key) {
    case "rating100": return formatDisplayRating(row.rating100);
    case "composite": return row.composite.toFixed(3);
    case "matches": return String(row.stats.total_matches);
    case "wins": return String(row.stats.wins);
    case "losses": return String(row.stats.losses);
    case "draws": return String(row.stats.draws);
    case "streak": return formatStreak(row.stats.current_streak);
    default: return String(row[key] ?? "");
  }
}

// Computes a ch-width per column (excluding "name", which gets NAME_MIN_CH)
// as max(header label length, longest rendered value across all rows).
// Order-independent by construction — sorting/filtering the displayed rows
// never changes these numbers, since callers key this off the unfiltered
// full row set.
export function computeColumnWidths(rows) {
  const widths = {};
  for (const col of COLUMNS) {
    if (col.key === "name") {
      widths.name = NAME_MIN_CH;
      continue;
    }
    let max = col.label.length;
    for (const row of rows) {
      const len = cellText(row, col.key).length;
      if (len > max) max = len;
    }
    widths[col.key] = max;
  }
  return widths;
}
