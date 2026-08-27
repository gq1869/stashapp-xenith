// Pure, GraphQL-free — same purity contract as elo.js/gauntlet.js/champion.js/
// match-stats.js/card-chips.js. Page-size resolution and page-index math for
// Leaderboard.jsx's pagination — kept separate from the component so
// the resolution logic (override vs. auto, mobile vs. desktop, clamping) is
// unit-testable without a DOM.

// Mobile is the constrained surface (per earlier real-WebKit measurements),
// so the plugin setting names the mobile figure; desktop derives at a fixed
// multiplier rather than being separately configurable.
export const DEFAULT_PAGE_SIZE_MOBILE = 100;
export const DESKTOP_MULTIPLIER = 5;

// Guards against a hostile/typo'd setting value (e.g. "999999") reintroducing
// the exact full-table-render problem this feature fixes, applied before the
// desktop multiplier so the multiplied value can't exceed it either.
const MAX_PAGE_SIZE_MOBILE = 2000;

// Resolves the effective page size for one surface from the plugin setting's
// raw value (whatever `configuration.plugins.xenith.LeaderboardRowsPerPage`
// comes back as — a number, a string, undefined, or garbage). 0/absent/
// negative/NaN/non-integer all mean "auto".
export function resolvePageSize(rawOverride, isMobile) {
  const n = Number(rawOverride);
  const mobileBase = Number.isInteger(n) && n > 0
    ? Math.min(n, MAX_PAGE_SIZE_MOBILE)
    : DEFAULT_PAGE_SIZE_MOBILE;
  return isMobile ? mobileBase : mobileBase * DESKTOP_MULTIPLIER;
}

// Recomputes a page index when the page size changes (crossing the
// responsive breakpoint) so the reader lands near the same rows instead of
// jumping — e.g. rotating a phone mid-scroll on page 40 of a 100-row-per-page
// layout should land near page 8 of a 500-row-per-page layout (row ~4,000
// either way), not on page 40 of the new layout (row 20,000).
export function reindexPage(oldPage, oldSize, newSize) {
  if (oldSize === newSize) return oldPage;
  return Math.floor((oldPage * oldSize) / newSize);
}
