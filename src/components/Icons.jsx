// Shared inline-SVG icon set for the skip/undo/shuffle action buttons
// (HeadToHead.jsx, Gauntlet.jsx, Champion.jsx) — replaces the bare emoji
// glyphs those buttons used to render. currentColor stroke, no
// fills, so hover/disabled/focus states recolor the icon the same way
// they recolor the rest of a button's chrome, and no icon-library
// dependency for three glyphs (Design Philosophy: no bloat).
//
// All three share a 24x24 grid, 2px stroke (matches the bold
// .hon-action-btn-label text they sit beside per the icon-weight
// convention), round caps/joins. Sizing is driven by .hon-icon in
// xenith.css, not inline width/height, so it tracks each button's own
// font-size step (desktop/mobile/coarse-pointer) automatically.
const { React } = window.PluginApi;

// Shared chrome as literal JSX attributes rather than a spread object —
// checkJS infers e.g. strokeLinecap's string literal type ("round") only
// when it's written directly on the element; spreading a plain object
// widens it to `string`, which SVGProps rejects.
function IconBase({ children }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="hon-icon"
    >
      {children}
    </svg>
  );
}

// Next-track glyph: mirrors UndoIcon's arrow reversed, so the pair reads
// as opposites at a glance.
export function SkipIcon() {
  return (
    <IconBase>
      <polygon points="5,4 15,12 5,20" />
      <line x1="19" y1="5" x2="19" y2="19" />
    </IconBase>
  );
}

// Corner-up-left hook: the universal undo arrow (matches Cmd+Z
// iconography elsewhere), not a circular rotate-ccw glyph, which reads
// more like "reset" than "step back one."
export function UndoIcon() {
  return (
    <IconBase>
      <polyline points="9,14 4,9 9,4" />
      <path d="M4 9h10a7 7 0 0 1 7 7v3" />
    </IconBase>
  );
}

// Crossing-arrows media "shuffle" glyph, not a literal die — a 5-pip
// dice face turns to mush at the 28px Champion banner size, and this
// glyph better matches the actual action (reroll/randomize) anyway.
export function ShuffleIcon() {
  return (
    <IconBase>
      <polyline points="16,3 21,3 21,8" />
      <line x1="4" y1="20" x2="21" y2="3" />
      <polyline points="21,16 21,21 16,21" />
      <line x1="15" y1="15" x2="21" y2="21" />
      <line x1="4" y1="4" x2="9" y2="9" />
    </IconBase>
  );
}

// Leaderboard pager Prev/Next glyphs — replaces the bare ◀/▶ text
// arrows, same rationale as the earlier replacement of the match-action emoji:
// once text labels collapse on a narrow pager, a bare glyph is all that's
// left, and it should match the rest of the icon set rather than reverting
// to plain text.
export function ChevronLeftIcon() {
  return (
    <IconBase>
      <polyline points="15,18 9,12 15,6" />
    </IconBase>
  );
}

export function ChevronRightIcon() {
  return (
    <IconBase>
      <polyline points="9,18 15,12 9,6" />
    </IconBase>
  );
}
