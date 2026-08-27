const { React } = window.PluginApi;
import { useXenithState, useSheet } from "../state";
import { OptionSheet } from "./OptionSheet";
import { GENDERS } from "../format";

const RECORD_TYPES = [
  { value: "performers", label: "Performers", icon: "🎭" },
  { value: "scenes", label: "Scenes", icon: "🎬" },
];

// short: abbreviated label for the mobile bar's value line, where full names
// (esp. "Head to Head") don't fit next to a sibling picker at 393px.
// Both Champion and Gauntlet play both battle types (src/champion.js/
// src/gauntlet.js need only the candidate pool/ladder, neither is
// performers-only), so no battleType-dependent disabled/hint state here.
const MATCH_MODES = [
  { value: "h2h", label: "Head to Head", short: "H2H", icon: "🎯" },
  { value: "champion", label: "Champion", short: "Champion", icon: "👑" },
  { value: "gauntlet", label: "Gauntlet", short: "Gauntlet", icon: "⚔️" },
];

export function Sidebar() {
  const {
    battleType, setBattleType,
    tab, setTab,
    matchMode, setMatchMode,
    selectedGenders, setSelectedGenders,
  } = useXenithState();
  const { openSheet, setOpenSheet } = useSheet();

  function toggleGender(g) {
    setSelectedGenders((prev) =>
      prev.includes(g) ? prev.filter((x) => x !== g) : [...prev, g]
    );
  }

  function selectMatchMode(mode) {
    setMatchMode(mode);
    setTab("h2h");
  }

  function closeSheet() {
    setOpenSheet(null);
  }

  // The mobile Match picker doubles as the "back to the match" nav target —
  // from Leaderboard/Stats the first tap just returns you to the
  // match you were already in (whatever `matchMode` holds), and only opens
  // the mode sheet once you're there.
  function onMatchPickerTap() {
    if (tab !== "h2h") setTab("h2h");
    else setOpenSheet("match");
  }

  const recordTypeMeta = RECORD_TYPES.find((r) => r.value === battleType);
  const matchModes = MATCH_MODES;
  const matchModeMeta = matchModes.find((m) => m.value === matchMode);
  const matchOpensSheet = tab === "h2h";

  // Stash has no scene-level gender field, so loadCandidatePool
  // (matchmaking.js) only ever threads selectedGenders into the performers
  // branch — filtering is a live no-op in scenes mode. Disable the whole
  // control there rather than let it render as active while doing nothing.
  const genderFilterDisabled = battleType === "scenes";
  const genderOptions = genderFilterDisabled
    ? GENDERS.map((g) => ({ ...g, disabled: true, hint: "N/A" }))
    : GENDERS;

  // Both the desktop panel and the mobile bar/sheets are always in the DOM,
  // each hidden by CSS on the opposite breakpoint (@media width <= 900px).
  // Neither branch is expensive to render and neither owns state the other
  // doesn't, so a JS breakpoint check (the useIsMobilePortrait pattern in
  // HeadToHead.jsx) would only add a second matchMedia subscription and a
  // hydration-flash risk on the sidebar's very first paint, for no benefit.
  return (
    <div className="hon-sidebar">
      {/* ── Desktop panel (hidden below 900px) ── */}
      <div className="hon-sidebar-desktop">
        <div className="hon-sidebar-group-label">Record Type</div>
        <div className="hon-sidebar-group" role="radiogroup" aria-label="Record Type">
          {RECORD_TYPES.map((r) => (
            <button
              type="button"
              key={r.value}
              className={`hon-sidebar-row ${battleType === r.value ? "active" : ""}`}
              role="radio"
              aria-checked={battleType === r.value}
              onClick={() => setBattleType(r.value)}
            >
              {r.icon} {r.label}
            </button>
          ))}
        </div>

        <div className="hon-sidebar-group-label">Mode</div>
        <div className="hon-sidebar-group" role="radiogroup" aria-label="Mode">
          {matchModes.map((m) => (
            <button
              type="button"
              key={m.value}
              className={`hon-sidebar-row ${m.disabled ? "disabled" : ""} ${
                !m.disabled && matchMode === m.value && tab === "h2h" ? "active" : ""
              }`}
              role="radio"
              aria-checked={!m.disabled && matchMode === m.value && tab === "h2h"}
              disabled={m.disabled}
              aria-disabled={m.disabled || undefined}
              onClick={() => selectMatchMode(m.value)}
            >
              <span className="hon-sidebar-row-text">
                {m.icon} {m.label}
              </span>
              {m.hint && <span className="hon-sheet-row-hint">{m.hint}</span>}
            </button>
          ))}
        </div>

        <div className="hon-sidebar-group-label">Stats</div>
        <button
          type="button"
          className={`hon-sidebar-row ${tab === "leaderboard" ? "active" : ""}`}
          aria-pressed={tab === "leaderboard"}
          onClick={() => setTab("leaderboard")}
        >
          📊 Leaderboard
        </button>
        <button
          type="button"
          className={`hon-sidebar-row ${tab === "stats" ? "active" : ""}`}
          aria-pressed={tab === "stats"}
          onClick={() => setTab("stats")}
        >
          📈 Match Stats
        </button>
        <button
          type="button"
          className={`hon-sidebar-row ${tab === "log" ? "active" : ""}`}
          aria-pressed={tab === "log"}
          onClick={() => setTab("log")}
        >
          📜 Match Log
        </button>

        {/* Gender filter — inline accordion on desktop, bottom sheet on
            mobile, both driven by the same openSheet flag. */}
        <button
          type="button"
          className={`hon-sidebar-row hon-sidebar-expandable ${genderFilterDisabled ? "disabled" : ""} ${
            !genderFilterDisabled && openSheet === "gender" ? "expanded" : ""
          }`}
          aria-expanded={!genderFilterDisabled && openSheet === "gender"}
          aria-controls="hon-gender-panel"
          disabled={genderFilterDisabled}
          aria-disabled={genderFilterDisabled || undefined}
          onClick={() => !genderFilterDisabled && setOpenSheet((o) => (o === "gender" ? null : "gender"))}
        >
          {/* U+FE0F forces emoji (not text-default) presentation — needed here
              since this label still renders a raw glyph, unlike the action
              buttons (HeadToHead.jsx), which moved to inline SVG (Icons.jsx)
              and no longer need this fix. */}
          <span className="hon-sidebar-row-text">⚧️ Gender Filter</span>
          {genderFilterDisabled ? (
            <span className="hon-sheet-row-hint">N/A</span>
          ) : (
            <span className="hon-sidebar-expand-icon" aria-hidden="true">▼</span>
          )}
        </button>
        {!genderFilterDisabled && openSheet === "gender" && (
          <div
            id="hon-gender-panel"
            className="hon-sidebar-expanded-content"
            role="group"
            aria-label="Gender Filter"
          >
            {GENDERS.map((g) => (
              <button
                type="button"
                key={g.value}
                className={`hon-sidebar-subrow ${selectedGenders.includes(g.value) ? "active" : ""}`}
                aria-pressed={selectedGenders.includes(g.value)}
                onClick={() => toggleGender(g.value)}
              >
                {g.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── Mobile bottom bar (hidden above 900px) ──
          Persistent, thumb-zone, nothing hidden at rest: Record Type and
          Match Type read their current value without a tap and open a
          bottom sheet on tap (replaces the flat multi-option segmented
          rows this bar originally shipped with — those didn't scale past
          two options, and Match Type needs three-plus once
          Champion/Gauntlet ship). Board / Stats / Filter stay single-tap
          toggles since each is a two-state switch, not a pick-one-of-N. */}
      <nav className="hon-mobile-bar" aria-label="Xenith">
        {/* Left half: Record Type + Match Type pickers, pinned to a fixed
            50% regardless of value length — previously these and
            the right-half nav split the row by content width, so a longer
            label ("Performers", "Gauntlet") pushed the boundary around. */}
        <div className="hon-mobile-bar-half">
          <button
            type="button"
            className="hon-mobile-picker"
            aria-haspopup="dialog"
            aria-expanded={openSheet === "record"}
            onClick={() => setOpenSheet("record")}
          >
            <span className="hon-mobile-picker-caption">Record</span>
            <span className="hon-mobile-picker-value">
              <span className="hon-mobile-picker-text">{recordTypeMeta?.label}</span>
              <span className="hon-mobile-picker-caret" aria-hidden="true">▾</span>
            </span>
          </button>

          <button
            type="button"
            className={`hon-mobile-picker ${matchOpensSheet ? "active" : ""}`}
            aria-haspopup={matchOpensSheet ? "dialog" : undefined}
            aria-expanded={matchOpensSheet ? openSheet === "match" : undefined}
            onClick={onMatchPickerTap}
          >
            <span className="hon-mobile-picker-caption">Match</span>
            <span className="hon-mobile-picker-value">
              <span className="hon-mobile-picker-text">{matchModeMeta?.short}</span>
              {matchOpensSheet && (
                <span className="hon-mobile-picker-caret" aria-hidden="true">▾</span>
              )}
            </span>
          </button>
        </div>

        {/* Right half: the remaining nav (tab switcher + gender filter). */}
        <div className="hon-mobile-bar-half">
          <div className="hon-mobile-seg" role="group" aria-label="Stats">
            <button
              type="button"
              className={`hon-mobile-seg-btn ${tab === "leaderboard" ? "active" : ""}`}
              aria-pressed={tab === "leaderboard"}
              onClick={() => setTab("leaderboard")}
            >
              <span className="hon-mobile-seg-icon" aria-hidden="true">📊</span>
              <span className="hon-mobile-seg-label">Board</span>
            </button>
            <button
              type="button"
              className={`hon-mobile-seg-btn ${tab === "stats" ? "active" : ""}`}
              aria-pressed={tab === "stats"}
              onClick={() => setTab("stats")}
            >
              <span className="hon-mobile-seg-icon" aria-hidden="true">📈</span>
              <span className="hon-mobile-seg-label">Stats</span>
            </button>
            <button
              type="button"
              className={`hon-mobile-seg-btn ${tab === "log" ? "active" : ""}`}
              aria-pressed={tab === "log"}
              onClick={() => setTab("log")}
            >
              <span className="hon-mobile-seg-icon" aria-hidden="true">📜</span>
              <span className="hon-mobile-seg-label">Log</span>
            </button>
          </div>

          <button
            type="button"
            className={`hon-mobile-filter-btn ${genderFilterDisabled ? "disabled" : ""} ${
              !genderFilterDisabled && openSheet === "gender" ? "active" : ""
            } ${!genderFilterDisabled && selectedGenders.length ? "filtered" : ""}`}
            aria-expanded={!genderFilterDisabled && openSheet === "gender"}
            aria-disabled={genderFilterDisabled || undefined}
            aria-label="Gender filter"
            disabled={genderFilterDisabled}
            onClick={() => !genderFilterDisabled && setOpenSheet("gender")}
          >
            <span className="hon-mobile-seg-icon" aria-hidden="true">⚧️</span>
            <span className="hon-mobile-seg-label">Filter</span>
          </button>
        </div>
      </nav>

      {/* ── Bottom sheets (mobile only) ── */}
      <OptionSheet
        open={openSheet === "record"}
        onClose={closeSheet}
        title="Record Type"
        options={RECORD_TYPES}
        selected={battleType}
        onSelect={setBattleType}
        multi={false}
      />
      <OptionSheet
        open={openSheet === "match"}
        onClose={closeSheet}
        title="Match Type"
        options={matchModes}
        selected={matchMode}
        onSelect={selectMatchMode}
        multi={false}
      />
      <OptionSheet
        open={!genderFilterDisabled && openSheet === "gender"}
        onClose={closeSheet}
        title="Gender Filter"
        options={genderOptions}
        selected={selectedGenders}
        onSelect={toggleGender}
        multi={true}
      />
    </div>
  );
}
