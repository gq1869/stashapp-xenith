// Shared React context/providers plus `persisted`, the module-scope store
// for everything that should survive a modal unmount/remount (main.js only
// unmounts the React tree, not this module) but not necessarily a full page
// reload. Two contexts on purpose — see SheetContext's own comment below for
// why battle state and sheet-open state are split rather than one value.
const { React } = window.PluginApi;

const XenithContext = React.createContext(null);
// openSheet lives in its own context, separate from the battle state
// above. The `value` object below is rebuilt every render, but the setters
// are useCallback([])-stable, so a useMemo on it is a provable no-op —
// XenithProvider only re-renders when one of its states changes (which a
// memo can't prevent) or on a tab change that swaps the whole subtree
// anyway. Splitting the context is the only fix that actually changes
// anything: HeadToHead.jsx only consumes XenithContext, so toggling
// openSheet (opening any of the mobile bottom sheets, or the desktop
// gender accordion) no longer re-renders it (and its two native Stash
// cards).
const SheetContext = React.createContext(null);

// Module-scope store — survives unmount/remount of the modal, since
// src/main.js only unmounts the React tree, not this module.
export const persisted = {
  battleType: "performers", // "performers" | "scenes"
  tab: "h2h", // "h2h" | "leaderboard" | "stats" | "log"
  matchMode: "h2h", // "h2h" | "champion" | "gauntlet"
  selectedGenders: [],
  openSheet: null, // null | "record" | "match" | "gender"
  leaderboardDistributionOpen: false,
  pairStates: {
    performers: null,
    scenes: null,
  },
  // sessionMatchCounts, recentlySelected, and recentMatchBuffer (below) are
  // all kept as separate performers/scenes sub-stores since Stash IDs
  // aren't namespaced by entity type (a performer and a scene can share the
  // same numeric id). All three are session-scoped — they survive
  // unmount/remount of the modal but not a full page reload.
  sessionMatchCounts: { performers: {}, scenes: {} },
  recentlySelected: { performers: [], scenes: [] },
  // 20-entry FIFO cooldown buffer per battle type — one entry per committed
  // match (holding both participant IDs together), oldest evicted past 20,
  // so the buffer holds a true 20 matches of cooldown. Replaces the old
  // wall-clock blackout.
  recentMatchBuffer: { performers: [], scenes: [] },
  // Match Log page's data source (src/session-log.js) — every match played
  // this session, both battle types together in one flat array (unlike
  // xenith_record, which lives per-item in custom_fields). Session-scoped
  // like the stores above: survives unmount/remount of the modal, not a
  // page reload.
  sessionLog: [],
  // Gauntlet mode's active run per battle type (src/gauntlet.js's run
  // object, or null between runs). Namespaced by battle type, same as
  // championRun below — Gauntlet plays both performers and scenes.
  // Session-scoped, same lifetime as the stores above. Typed `any` (not
  // inferred from the `null` initializers) — gauntlet.js's run shape is
  // reassigned wholesale from several places (usePair.js, Gauntlet.jsx) via
  // plain `persisted.gauntletRun[battleType] = ...`, which a narrower type
  // would reject.
  /** @type {any} */
  gauntletRun: { performers: null, scenes: null },
  // Gauntlet's challenger-preview screen (the picked candidate before a run
  // is started), namespaced by battle type same as gauntletRun. Kept
  // separate from it — a run and a preview are mutually exclusive states,
  // but the preview needs to survive unmount/remount the same way gauntletRun
  // already does, so a mode switch or tab round trip doesn't reroll it.
  /** @type {any} */
  gauntletPreview: { performers: null, scenes: null },
  // Champion mode's active reign per battle type (src/champion.js's run
  // object, or null between reigns). Namespaced by battle type — Champion
  // has no ladder dependency and plays both performers and scenes. Same
  // session-scoped lifetime and `any` typing rationale as gauntletRun above
  // (usePair.js/Champion.jsx reassign it wholesale).
  /** @type {any} */
  championRun: { performers: null, scenes: null },
};

export function getPersistedPairState(battleType) {
  return persisted.pairStates[battleType];
}

export function setPersistedPairState(battleType, next) {
  persisted.pairStates[battleType] = next;
}

export function XenithProvider({ children }) {
  const [battleType, setBattleTypeState] = React.useState(persisted.battleType);
  const [tab, setTabState] = React.useState(persisted.tab);
  const [matchMode, setMatchModeState] = React.useState(persisted.matchMode);
  const [selectedGenders, setSelectedGendersState] = React.useState(persisted.selectedGenders);

  // Each setter writes through to `persisted` synchronously (not just via
  // setState) because matchmaking.js reads persisted.* directly outside
  // React — it would otherwise see stale values until the next render.
  const setBattleType = React.useCallback((value) => {
    setBattleTypeState((prev) => {
      const next = typeof value === "function" ? value(prev) : value;
      persisted.battleType = next;
      return next;
    });
  }, []);

  const setTab = React.useCallback((value) => {
    setTabState((prev) => {
      const next = typeof value === "function" ? value(prev) : value;
      persisted.tab = next;
      return next;
    });
  }, []);

  const setMatchMode = React.useCallback((value) => {
    setMatchModeState((prev) => {
      const next = typeof value === "function" ? value(prev) : value;
      persisted.matchMode = next;
      return next;
    });
  }, []);

  const setSelectedGenders = React.useCallback((value) => {
    setSelectedGendersState((prev) => {
      const next = typeof value === "function" ? value(prev) : value;
      persisted.selectedGenders = next;
      return next;
    });
  }, []);

  const value = {
    battleType, setBattleType,
    tab, setTab,
    matchMode, setMatchMode,
    selectedGenders, setSelectedGenders,
  };
  return React.createElement(XenithContext.Provider, { value }, children);
}

export function useXenithState() {
  const ctx = React.useContext(XenithContext);
  if (!ctx) throw new Error("useXenithState must be used within XenithProvider");
  return ctx;
}

export function SheetProvider({ children }) {
  const [openSheet, setOpenSheetState] = React.useState(persisted.openSheet);

  const setOpenSheet = React.useCallback((value) => {
    setOpenSheetState((prev) => {
      const next = typeof value === "function" ? value(prev) : value;
      persisted.openSheet = next;
      return next;
    });
  }, []);

  const value = { openSheet, setOpenSheet };
  return React.createElement(SheetContext.Provider, { value }, children);
}

export function useSheet() {
  const ctx = React.useContext(SheetContext);
  if (!ctx) throw new Error("useSheet must be used within SheetProvider");
  return ctx;
}
