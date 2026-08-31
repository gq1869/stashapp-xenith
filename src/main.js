// Plugin entry point, bundled by Vite into dist/xenith.js (what Stash
// actually serves). Wires the React tree (XenithProvider/SheetProvider +
// tab layout) into portal-host.js's native-tree mounting, and starts/stops
// the DOM-injection side effects (badge-injector.js, scene-tooltips.js,
// stash-log.js's flush) alongside it.
import "./styles/xenith.css";

import { XenithProvider, SheetProvider, useXenithState } from "./state";
import { HeadToHead } from "./components/HeadToHead";
import { Leaderboard } from "./components/Leaderboard";
import { MatchStats } from "./components/MatchStats";
import { MatchLog } from "./components/MatchLog";
import { Sidebar } from "./components/Sidebar";
import { injectBattleRankBadge, destroyBadgeInjector } from "./badge-injector";
import { setupSceneTooltips, destroySceneTooltips } from "./scene-tooltips";
import { XenithPortalHost, showPortal, hidePortal } from "./portal-host";
import { flushStashLog } from "./stash-log";

const { React, patch } = window.PluginApi;

// Ternary swap (not a router) — the rendered tab fully unmounts, which is
// exactly what useLeaderboard.js's generation-counter cancellation is
// written against. Lookup instead of a growing ternary chain now that
// there are 4 tabs.
const TABS = {
  h2h: HeadToHead,
  leaderboard: Leaderboard,
  stats: MatchStats,
  log: MatchLog,
};

function XenithLayout() {
  const { tab } = useXenithState();
  const Tab = TABS[tab] ?? HeadToHead;
  return React.createElement(
    "div",
    { className: "hon-plugin-layout" },
    React.createElement(Sidebar),
    React.createElement(
      "div",
      { className: "hon-main-plugin-content" },
      React.createElement(Tab)
    )
  );
}

function XenithApp() {
  // SheetProvider wraps XenithProvider (rather than the reverse) so that
  // toggling openSheet never re-renders XenithProvider's subtree — the
  // whole point of splitting openSheet into its own context (see
  // state.js). Sidebar consumes both contexts; HeadToHead and Leaderboard
  // only consume XenithContext.
  return React.createElement(
    SheetProvider,
    null,
    React.createElement(XenithProvider, null, React.createElement(XenithLayout))
  );
}

// Class component required: React 17's legacy API has no hooks-based error
// boundary. Without this, an uncaught render/commit throw inside XenithApp
// (e.g. badge-injector's replaceWith on a React-owned node) propagates up
// through the patch.after fiber into Stash's own root and unmounts the
// whole host app.
class XenithErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error) {
    console.error("[Xenith] caught render error", error);
  }

  render() {
    if (this.state.hasError) return null;
    return this.props.children;
  }
}

/** @type {HTMLElement | null} */
let modalRoot = null;
/** @type {Element | null} */
let mountNode = null;

function openModal() {
  if (!modalRoot) {
    modalRoot = document.createElement("div");
    modalRoot.id = "hon-modal";
    modalRoot.className = "hon-modal";
    modalRoot.innerHTML = `
      <div class="hon-modal-backdrop"></div>
      <div class="hon-modal-content">
        <button class="hon-modal-close" aria-label="Close">✕</button>
        <div id="hon-app-mount"></div>
      </div>
    `;
    document.body.appendChild(modalRoot);

    modalRoot.querySelector(".hon-modal-backdrop")?.addEventListener("click", closeModal);
    modalRoot.querySelector(".hon-modal-close")?.addEventListener("click", closeModal);
    mountNode = modalRoot.querySelector("#hon-app-mount");
  }

  modalRoot.style.display = "flex";
  // Locks the background page's scroll for as long as the modal is open —
  // pairs with body.hon-modal-open in xenith.css. Without this, scrolling
  // inside the modal (or its backdrop, on touch devices) can still move
  // the Stash page behind it.
  document.body.classList.add("hon-modal-open");
  showPortal(mountNode);
}

function closeModal() {
  if (!modalRoot) return;
  flushStashLog();
  hidePortal();
  modalRoot.style.display = "none";
  document.body.classList.remove("hon-modal-open");
}

// A React child of MainNavBar.MenuItems (patch.before, not patch.after —
// patch.after would append as a sibling of the <Nav> that IS .navbar-nav,
// landing the item outside it) rather than a hand-rolled DOM node
// appended into that same React-owned container. The old appendChild
// approach fought React's reconciliation of .navbar-nav's children (a
// foreign trailing node gets dropped whenever React inserts/removes a
// sibling, then re-added by routeObserver on the very next mutation) and,
// being raw `btn btn-primary` on
// top of Stash's own `p-4 p-xl-2`, was a heavier/wider flex item than
// anything a theme's navbar layout math accounts for. Markup below
// mirrors MainNavbar.tsx's own menuItems.map() output (module `nav-link`
// wrapper > `minimal` button > icon + label) exactly, minus
// LinkContainer since this opens a modal rather than navigating.
//
// Not MainNavBar.UtilityItems (the issue's original suggested target):
// that slot renders TWICE in MainNavbar.tsx (once in .navbar-collapse,
// once in .navbar-buttons), which would double-mount the item, and
// Refract's own navbar CSS hides every direct child of that slot except
// an explicit allowlist of known plugin classes — landing here would
// make the button invisible for Refract users specifically.
/** @type {((visible: boolean) => void) | null} */
let setNavItemVisible = null;

function XenithNavItem() {
  const [visible, setVisible] = React.useState(true);
  React.useEffect(() => {
    setNavItemVisible = setVisible;
    return () => {
      if (setNavItemVisible === setVisible) setNavItemVisible = null;
    };
  }, []);

  if (!visible) return null;

  return React.createElement(
    "div",
    { id: "hon-floating-btn-wrapper", className: "nav-link col-4 col-sm-3 col-md-2 col-lg-auto" },
    React.createElement(
      "button",
      {
        id: "hon-floating-btn",
        className: "minimal p-4 p-xl-2 d-flex d-xl-inline-block flex-column justify-content-between align-items-center",
        onClick: openModal,
      },
      React.createElement(
        "svg",
        {
          "data-prefix": "fas",
          "data-icon": "volcano",
          className: "svg-inline--fa fa-volcano fa-icon nav-menu-icon d-block d-xl-inline mb-2 mb-xl-0",
          role: "img",
          viewBox: "0 0 512 512",
          "aria-hidden": "true",
        },
        React.createElement("path", {
          fill: "currentColor",
          d: "M160 144c-35.3 0-64-28.7-64-64s28.7-64 64-64c15.7 0 30 5.6 41.2 15C212.4 12.4 232.7 0 256 0s43.6 12.4 54.8 31C322 21.6 336.3 16 352 16c35.3 0 64 28.7 64 64s-28.7 64-64 64c-14.7 0-28.3-5-39.1-13.3l-32 48C275.3 187 266 192 256 192s-19.3-5-24.9-13.3l-32-48C188.3 139 174.7 144 160 144zM144 352l48.4-24.2c10.2-5.1 21.6-7.8 33-7.8c19.6 0 38.4 7.8 52.2 21.6l32.5 32.5c6.3 6.3 14.9 9.9 23.8 9.9c11.3 0 21.8-5.6 28-15l9.7-14.6-59-66.3c-9.1-10.2-22.2-16.1-35.9-16.1H235.1c-13.7 0-26.8 5.9-35.9 16.1l-59.9 67.4L144 352zm19.4-95.8c18.2-20.5 44.3-32.2 71.8-32.2h41.8c27.4 0 53.5 11.7 71.8 32.2l150.2 169c8.5 9.5 13.2 21.9 13.2 34.7c0 28.8-23.4 52.2-52.2 52.2H52.2C23.4 512 0 488.6 0 459.8c0-12.8 4.7-25.1 13.2-34.7l150.2-169z",
        })
      ),
      React.createElement("span", null, "Xenith")
    )
  );
}

// cleanup() can't unregister the patch.before below, so it hides the
// item by flipping React state instead of trying to remove a DOM node
// React itself owns — mirrors portal-host.js's showPortal/hidePortal
// singleton-ref pattern, including the "still points at this instance"
// guard in the effect cleanup above.
function disableNavItem() {
  setNavItemVisible?.(false);
}

let rafPending = false;
/** @type {MutationObserver | null} */
let routeObserver = null;

function handleEscape(e) {
  if (!modalRoot || modalRoot.style.display === "none") return;
  if (e.key === "Escape") closeModal();
}

function cleanup() {
  flushStashLog();
  routeObserver?.disconnect();
  destroyBadgeInjector();
  destroySceneTooltips();
  document.removeEventListener("keydown", handleEscape);
  window.removeEventListener("beforeunload", cleanup);
  hidePortal();
  disableNavItem();
  if (modalRoot) modalRoot.remove();
  document.body.classList.remove("hon-modal-open");
  modalRoot = null;
  mountNode = null;
  window.__xenithLoaded = false;
  delete window.__xenithCleanup;
}

function init() {
  // Guards against a hot-reload or double script-injection re-running this
  // whole setup and double-registering the patch, observers, and listeners
  // below. Cleared at the end of cleanup() so a legitimate
  // teardown-then-reload can re-run it.
  if (window.__xenithLoaded) return;
  window.__xenithLoaded = true;

  // Portals XenithApp into StashApp's own React tree via a component that's
  // always mounted, so native components (e.g. PerformerCard) rendered
  // inside inherit ConfigurationProvider/IntlProvider/Router context that a
  // standalone ReactDOM.render root never has.
  patch.after("MainNavBar.UtilityItems", function (props, _ctx, result) {
    return [
      result,
      // Keyed: this array is returned fresh from patch.after on every
      // MainNavBar render, and an unkeyed array makes React warn every time.
      React.createElement(
        XenithPortalHost,
        { key: "xenith-portal-host" },
        React.createElement(XenithErrorBoundary, null, React.createElement(XenithApp))
      ),
    ];
  });

  // patch.before (not .after) inserts XenithNavItem INSIDE the <Nav> that
  // MainNavBar.MenuItems renders — i.e. as a real .navbar-nav child — so it
  // participates in whatever layout the active theme applies instead of
  // being appended after the fact. See the comment above XenithNavItem.
  patch.before("MainNavBar.MenuItems", function (props) {
    return [
      {
        children: React.createElement(
          React.Fragment,
          null,
          props.children,
          React.createElement(XenithNavItem, { key: "xenith-nav-item" })
        ),
      },
    ];
  });

  routeObserver = new MutationObserver(() => {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      injectBattleRankBadge();
      setupSceneTooltips();
    });
  });
  routeObserver.observe(document.body, { childList: true, subtree: true });

  document.addEventListener("keydown", handleEscape);

  window.__xenithCleanup = cleanup;

  // beforeunload is the one event guaranteed to fire in the real world,
  // giving __xenithCleanup at least one production run instead of only ever
  // running from qa/e2e.
  window.addEventListener("beforeunload", cleanup);

  // Run once immediately for the DOM already present at script load —
  // routeObserver only catches *future* mutations, so without this,
  // badge/tooltip injection depends entirely on some unrelated mutation
  // happening later to trigger it, which may be delayed or never fire.
  // (The nav item needs no equivalent: patch.before above fires on
  // MainNavBar's own render, not on a DOM mutation.)
  injectBattleRankBadge();
  setupSceneTooltips();
}

init();
