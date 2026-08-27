// Test environment shim. Loaded via Vitest's setupFiles before any test
// modules, so window.PluginApi is available when state.js is first
// evaluated. state.js is pulled in transitively by matchmaking.js; the
// React context functions are never exercised in unit tests, so stubs are
// sufficient.
globalThis.window = {
  PluginApi: {
    React: {
      createContext: () => ({ Provider: {} }),
      useState: (v) => [v, () => { }],
      useCallback: (fn) => fn,
      useContext: () => null,
      createElement: () => null,
    },
  },
};

// Node 22+'s built-in global `localStorage` is lazily initialized on first
// access (even a bare `typeof localStorage`) and prints an
// ExperimentalWarning about --localstorage-file when it isn't configured.
// matchmaking.js's isDebugEnabled() does exactly that access. A plain stub
// avoids ever touching Node's real experimental global, matching the
// window shim above.
globalThis.localStorage = {
  getItem: () => null,
  setItem: () => { },
  removeItem: () => { },
};
