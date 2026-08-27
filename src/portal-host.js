const { React, ReactDOM } = window.PluginApi;

// Xenith's modal is portaled into StashApp's own React tree (via a
// patch.after on "MainNavBar.UtilityItems") so anything rendered inside —
// including the native PerformerCard — inherits ConfigurationProvider,
// IntlProvider, and Router context that a standalone ReactDOM.render root
// never has access to.
//
// Module-level ref (not context) because src/main.js calls showPortal/hidePortal
// imperatively from plain event handlers outside the React tree.
/** @type {any} */
let stateRef = null;

export function showPortal(node) {
  if (stateRef) stateRef({ visible: true, node });
}

export function hidePortal() {
  if (stateRef) stateRef({ visible: false, node: null });
}

export function XenithPortalHost({ children }) {
  const [state, setState] = React.useState({ visible: false, node: null });
  React.useEffect(() => {
    stateRef = setState;
    // Guards showPortal/hidePortal against firing before mount or after
    // unmount, when there's no live setState to call.
    return () => {
      // stateRef is a last-mount-wins singleton. Only null it if it still
      // points at *this* instance's setState — otherwise a stale instance's
      // cleanup (only reachable if src/main.js's double-load guard is somehow
      // bypassed) could null out a legitimate later instance's ref.
      if (stateRef === setState) stateRef = null;
    };
  }, []);

  if (!state.visible || !state.node) return null;
  return ReactDOM.createPortal(children, state.node);
}
