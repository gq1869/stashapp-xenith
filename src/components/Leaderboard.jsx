const { React } = window.PluginApi;
import { useLeaderboard } from "../hooks/useLeaderboard";
import { TIER_COLORS, DEFAULT_RATING } from "../elo";
import { formatDisplayRating } from "../format";
import { persisted } from "../state";
import { getPluginConfig } from "../plugin-config";
import { resolvePageSize, reindexPage } from "../leaderboard-pagination";
import { COLUMNS, computeColumnWidths, formatStreak } from "../leaderboard-columns";
import { ChevronLeftIcon, ChevronRightIcon } from "./Icons";

// Same breakpoint xenith.css's `.hon-stats-table-wrapper` scrollport switch
// uses (the `width <= 900px` block) — page size and scrollport change
// together.
const MOBILE_MEDIA_QUERY = "(max-width: 900px)";

const TIER_ORDER = ["S", "A", "B", "C", "D", "F"];

function rowValue(row, key) {
  switch (key) {
    case "matches": return row.stats.total_matches;
    case "wins": return row.stats.wins;
    case "losses": return row.stats.losses;
    case "draws": return row.stats.draws;
    case "streak": return row.stats.current_streak;
    default: return row[key];
  }
}

// Log-scaled bar widths (not linear) so a tier with 2 performers is still
// visible next to a tier with 200.
function tierBarWidths(counts) {
  const values = TIER_ORDER.map((t) => counts[t]).filter((v) => v > 0);
  if (values.length === 0) return {};
  const max = Math.max(...values);
  const min = Math.min(...values);
  const logMax = Math.log(max + 1);
  const logMin = Math.log(min + 1);
  return TIER_ORDER.reduce((acc, t) => {
    const c = counts[t];
    if (c === 0) { acc[t] = 0; return acc; }
    acc[t] = logMax === logMin ? 100 : 5 + ((Math.log(c + 1) - logMin) / (logMax - logMin)) * 95;
    return acc;
  }, {});
}

function TierDistribution({ rows, open, onToggle, itemLabel }) {
  const [animated, setAnimated] = React.useState(false);

  const counts = React.useMemo(() => {
    const c = { S: 0, A: 0, B: 0, C: 0, D: 0, F: 0 };
    rows.forEach((r) => { c[r.tier] = (c[r.tier] || 0) + 1; });
    return c;
  }, [rows]);

  const widths = React.useMemo(() => tierBarWidths(counts), [counts]);

  React.useEffect(() => {
    setAnimated(false);
    const id = requestAnimationFrame(() => setAnimated(true));
    return () => cancelAnimationFrame(id);
  }, [rows]);

  // Threshold: if bar is under 12% wide, render count outside the tip
  const CUTOFF_PERCENT = 12;

  return (
    <div className="hon-tier-distribution">
      {/* On mobile this doubles as the accordion header (see
          .hon-distribution-toggle in xenith.css); on desktop it's forced
          open and unclickable, rendering as a plain title as before. */}
      <button
        type="button"
        className={`hon-tier-distribution-title hon-distribution-toggle ${open ? "expanded" : ""}`}
        onClick={onToggle}
        aria-expanded={open}
      >
        <span>Tier Distribution</span>
        <span className="hon-sidebar-expand-icon" aria-hidden="true">▼</span>
      </button>
      <div className={`hon-distribution-content ${open ? "expanded" : ""}`}>
        <div className="hon-distribution-content-inner">
          <div className="hon-tier-bars">
            {TIER_ORDER.map((tier, index) => {
              const widthPct = widths[tier] || 0;
              const isOutside = widthPct < CUTOFF_PERCENT;
              const targetWidth = animated ? `${widthPct}%` : "0%";

              return (
                // Staggered rather than simultaneous — this is an infrequent
                // staged entrance (leaderboard load/refresh only), and the
                // sequence communicates the S->F tier hierarchy. 60ms rather
                // than a slower default stagger: six rows at 100ms is a
                // 500ms tail on a panel the user is trying to read.
                <div
                  className="hon-tier-bar-row"
                  key={tier}
                  style={{ animationDelay: `${index * 60}ms` }}
                >
                  <span className="hon-tier-bar-label" style={{ color: TIER_COLORS[tier] }}>
                    {tier}
                  </span>
                  <div className="hon-tier-bar-track">
                    <div
                      className="hon-tier-bar-fill"
                      style={{
                        width: targetWidth,
                        background: TIER_COLORS[tier],
                      }}
                    />
                    {counts[tier] > 0 && (
                      <span
                        className={`hon-tier-bar-count ${isOutside ? "is-outside" : "is-inside"}`}
                        style={{ left: targetWidth }}
                      >
                        {counts[tier]}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="hon-tier-distribution-total">
            {rows.length} {itemLabel}{rows.length === 1 ? "" : "s"} total
          </div>
        </div>
      </div>
    </div>
  );
}

// Resolves the effective page size: mobile/desktop split on
// MOBILE_MEDIA_QUERY, overridable via the LeaderboardRowsPerPage plugin
// setting (see xenith.yml, resolvePageSize in leaderboard-pagination.js).
// Config is fetched async — first render uses the auto default and adopts
// the override once resolved (getPluginConfig() is 60s-TTL cached, so this
// is one round trip at most per mount, shared with badge-injector.js).
function usePageSize() {
  const [isMobile, setIsMobile] = React.useState(
    () => typeof window !== "undefined" && window.matchMedia(MOBILE_MEDIA_QUERY).matches
  );
  const [override, setOverride] = React.useState(null);

  React.useEffect(() => {
    const mql = window.matchMedia(MOBILE_MEDIA_QUERY);
    const onChange = (e) => setIsMobile(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    getPluginConfig()
      .then((config) => { if (!cancelled) setOverride(config.LeaderboardRowsPerPage); })
      .catch(() => {}); // auto (override stays null) on failure
    return () => { cancelled = true; };
  }, []);

  return resolvePageSize(override, isMobile);
}

export function Leaderboard() {
  const { rows, error, battleType } = useLeaderboard();
  const entityPath = battleType === "scenes" ? "scenes" : "performers";
  const scopeLabel = battleType === "scenes" ? "Scenes" : "Performers";
  const [sortKey, setSortKey] = React.useState("composite");
  const [sortAsc, setSortAsc] = React.useState(false);
  const [tierFilter, setTierFilter] = React.useState("ALL");
  // Mobile-only accordion (see .hon-distribution-toggle in xenith.css) —
  // closed by default so the bounded table region below it isn't squeezed
  // by the ~200px distribution panel on a phone screen. Desktop forces this
  // open via CSS regardless of the persisted value, so the toggle is a
  // no-op there and the value only matters below 900px. The toggle button
  // itself lives inside TierDistribution's own title row (one card, one
  // heading) rather than as a separate element above it.
  const [distributionOpen, setDistributionOpen] = React.useState(persisted.leaderboardDistributionOpen);

  function toggleDistribution() {
    setDistributionOpen((prev) => {
      const next = !prev;
      persisted.leaderboardDistributionOpen = next;
      return next;
    });
  }

  const sorted = React.useMemo(() => {
    if (!rows) return [];
    const filtered = tierFilter === "ALL" ? rows : rows.filter((r) => r.tier === tierFilter);
    return [...filtered].sort((a, b) => {
      const av = rowValue(a, sortKey);
      const bv = rowValue(b, sortKey);
      let cmp;
      if (sortKey === "tier") {
        // TIER_ORDER.indexOf ranks S first, matching the tier hierarchy
        // instead of alphabetical order (A, B, C, D, F, S).
        cmp = TIER_ORDER.indexOf(av) - TIER_ORDER.indexOf(bv);
      } else if (sortKey === "rating100") {
        // `?? DEFAULT_RATING`, not the numeric-branch's default `0` coercion
        // of null — rank-cache.js's `getRatingTier(p.rating100 ?? DEFAULT_RATING)`
        // is what actually assigns each row's displayed tier, so an unrated
        // row (tier "C") must sort as if rated DEFAULT_RATING, not 0.
        cmp = (av ?? DEFAULT_RATING) - (bv ?? DEFAULT_RATING);
      } else {
        cmp = typeof av === "string" ? av.localeCompare(bv) : av - bv;
      }
      return sortAsc ? cmp : -cmp;
    });
  }, [rows, tierFilter, sortKey, sortAsc]);

  // Bound what's rendered to a page window rather than the whole pool — see
  // leaderboard-pagination.js; rank-cache.js itself still fetches everything
  // since every other consumer (badges, tooltips, match-stats) needs the
  // full ranked list.
  const pageSize = usePageSize();
  const [page, setPage] = React.useState(0);
  const prevPageSizeRef = React.useRef(pageSize);

  // Sorting/filtering on page 87 and staying on page 87 would show an
  // unrelated slice of the new ordering — snap back to the top.
  React.useEffect(() => {
    setPage(0);
  }, [rows, tierFilter, sortKey, sortAsc]);

  // Breakpoint crossing (mobile <-> desktop page size) shouldn't teleport
  // the reader — reindexPage recomputes from the current first-row index so
  // rotating a phone mid-scroll lands near the same rows, not row 20,000 of
  // a suddenly-32-page desktop layout.
  React.useEffect(() => {
    if (prevPageSizeRef.current !== pageSize) {
      setPage((p) => reindexPage(p, prevPageSizeRef.current, pageSize));
      prevPageSizeRef.current = pageSize;
    }
  }, [pageSize]);

  // Widths derived from the full unfiltered `rows` set, not `sorted`
  // (page or tier-filter changes never resize columns) or `pageRows` (which
  // is what caused the original jitter — table-layout: fixed's colgroup
  // needs a stable source, and only the whole pool is one).
  const columnWidths = React.useMemo(() => computeColumnWidths(rows ?? []), [rows]);
  const tableMinWidth = React.useMemo(
    () => `calc(${Object.values(columnWidths).reduce((sum, ch) => sum + ch, 0)}ch + ${COLUMNS.length} * var(--hon-cell-pad))`,
    [columnWidths]
  );

  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  // Derived, not stored — `page` can drift out of range (a shrinking tier
  // filter, a smaller battleType pool) between the effects above firing and
  // this render, so every read of "the current page" goes through this.
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = React.useMemo(
    () => sorted.slice(safePage * pageSize, (safePage + 1) * pageSize),
    [sorted, safePage, pageSize]
  );

  // Local text state for the jump-to-page input — committed on blur/Enter
  // rather than every keystroke, so typing "1" on the way to "12" doesn't
  // render page 1 first. Synced from safePage so Prev/Next and a reset both
  // update the displayed number.
  const [pageInput, setPageInput] = React.useState(String(safePage + 1));
  React.useEffect(() => {
    setPageInput(String(safePage + 1));
  }, [safePage]);

  function commitPageInput() {
    const n = Number(pageInput);
    if (Number.isInteger(n) && n >= 1 && n <= pageCount) {
      setPage(n - 1);
    } else {
      setPageInput(String(safePage + 1)); // snap back rather than erroring
    }
  }

  if (error) return <div className="hon-error">{error}</div>;
  if (!rows) return <div className="hon-loading">Loading leaderboard...</div>;

  function toggleSort(key) {
    if (key === sortKey) setSortAsc((a) => !a);
    else {
      setSortKey(key);
      setSortAsc(false);
    }
  }

  return (
    <div className="hon-leaderboard">
      <div className="hon-stats-header">
        <h2 className="hon-stats-title">
          <span className="hon-stats-title-icon">📊</span> Leaderboard
          <span className="hon-match-stats-scope">{scopeLabel}</span>
        </h2>
        <div className="hon-tier-filter" role="radiogroup" aria-label="Tier filter">
          {["ALL", "S", "A", "B", "C", "D", "F"].map((t) => (
            <button
              key={t}
              type="button"
              className={`hon-tier-btn ${tierFilter === t ? "active" : ""}`}
              role="radio"
              aria-checked={tierFilter === t}
              onClick={() => setTierFilter(t)}
              style={t !== "ALL" ? { "--tier-color": TIER_COLORS[t] } : undefined}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      <TierDistribution
        rows={rows}
        open={distributionOpen}
        onToggle={toggleDistribution}
        itemLabel={battleType === "scenes" ? "scene" : "performer"}
      />

      <div className="hon-stats-table-wrapper">
        <table className="hon-stats-table" style={{ minWidth: tableMinWidth }}>
          <colgroup>
            {COLUMNS.map((col) => (
              <col
                key={col.key}
                style={col.key === "name" ? undefined : { width: `calc(${columnWidths[col.key]}ch + var(--hon-cell-pad))` }}
              />
            ))}
          </colgroup>
          <thead>
            <tr>
              {COLUMNS.map((col) => {
                const isActive = sortKey === col.key;
                const sortClass = isActive
                  ? `sort-active ${sortAsc ? 'sort-asc' : 'sort-desc'}`
                  : '';

                return (
                  <th
                    key={col.key}
                    className={sortClass}
                    aria-sort={isActive ? (sortAsc ? "ascending" : "descending") : "none"}
                  >
                    <button type="button" className="hon-stats-th-btn" onClick={() => toggleSort(col.key)}>
                      {col.label}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row) => (
              <tr key={row.id}>
                <td style={{ color: TIER_COLORS[row.tier], fontWeight: "bold" }}>{row.tier}</td>
                <td className="hon-stats-name"><a href={`/${entityPath}/${row.id}`} target="_blank" rel="noreferrer">{row.name}</a></td>
                <td>{formatDisplayRating(row.rating100)}</td>
                <td>{row.composite.toFixed(3)}</td>
                <td>{row.stats.total_matches}</td>
                <td className="hon-stats-positive">{row.stats.wins}</td>
                <td className="hon-stats-negative">{row.stats.losses}</td>
                <td className="hon-stats-neutral">{row.stats.draws}</td>
                <td className={row.stats.current_streak > 0 ? "hon-stats-positive" : row.stats.current_streak < 0 ? "hon-stats-negative" : "hon-stats-neutral"}>
                  {formatStreak(row.stats.current_streak)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {pageCount > 1 && (
        <div className="hon-leaderboard-pager" role="navigation" aria-label="Leaderboard pagination">
          <button
            type="button"
            className="hon-tier-btn hon-pager-btn"
            disabled={safePage === 0}
            aria-label="Previous page"
            onClick={() => setPage(safePage - 1)}
          >
            <ChevronLeftIcon /> <span className="hon-pager-label">Prev</span>
          </button>

          {/* Text labels collapse first (below 460px container width),
              then this whole range span (below 340px) — the page counter
              in .hon-pager-jump conveys position on its own, so the range is
              the redundant half once space runs out entirely. */}
          <span className="hon-pager-range" aria-live="polite">
            <span className="hon-pager-label">Showing </span>
            {(safePage * pageSize + 1).toLocaleString()}–
            {Math.min((safePage + 1) * pageSize, sorted.length).toLocaleString()} of{" "}
            {sorted.length.toLocaleString()}
          </span>

          <span className="hon-pager-jump">
            <span className="hon-pager-label">Page </span>
            <input
              type="number"
              className="hon-pager-jump-input"
              min={1}
              max={pageCount}
              value={pageInput}
              aria-label="Jump to page"
              onChange={(e) => setPageInput(e.target.value)}
              onBlur={commitPageInput}
              onKeyDown={(e) => { if (e.key === "Enter") commitPageInput(); }}
            />{" "}
            of {pageCount}
          </span>

          <button
            type="button"
            className="hon-tier-btn hon-pager-btn"
            disabled={safePage >= pageCount - 1}
            aria-label="Next page"
            onClick={() => setPage(safePage + 1)}
          >
            <span className="hon-pager-label">Next</span> <ChevronRightIcon />
          </button>
        </div>
      )}
    </div>
  );
}
