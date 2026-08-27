// `loadableComponents` is accessed lazily (inside the hooks below), not
// destructured at module-eval time: it's a newer, less stable PluginApi
// surface than React/patch, so if a Stash version renames or drops it, a
// top-level destructure would throw at module-eval and take down the
// entire bundle — including code that never touches loadableComponents at
// all. `hooks` is destructured eagerly since it's not the risky one.
const { hooks } = window.PluginApi;

// useNativePerformerCard/useNativeSceneCard differed only by which
// loadableComponents/components key they used. `kind` is a plain value
// argument, not a conditional hook call, so this collapse is hook-order-safe.
export function useNativeCard(kind) {
  const loading = hooks.useLoadComponents([window.PluginApi.loadableComponents[kind]]);
  return loading ? null : window.PluginApi.components[kind];
}

// Native cards render StashApp's own <Link>s (image, title, country flag,
// etc.) which use React Router and would navigate the page behind the
// battle modal. Intercept and open in a new tab instead.
export function handleNativeCardClick(e) {
  e.preventDefault();
  e.stopPropagation();
  const anchor = e.target.closest("a[href]");
  if (anchor) {
    const card = anchor.closest(".hon-card-native-wrap");
    card?.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));

    window.open(anchor.href, "_blank");
  }
}
