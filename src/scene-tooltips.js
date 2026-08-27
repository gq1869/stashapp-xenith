// Rank/rating tooltips on native Stash scene-page performer thumbnails, via
// one delegated `mouseover` listener on document.body rather than a
// per-thumbnail bound listener — idempotent setup so repeated SPA
// navigation can't stack duplicate listeners. Reads from rank-cache.js.
import { getRankedItems, invalidateRankCache } from "./rank-cache";
import { formatDisplayRating } from "./format";
import { parseEntityHref } from "./entity-href";

// invalidateSceneTooltipCache is the pre-existing export name usePair.js
// imports; it now just delegates to the shared rank-cache module, which
// badge-injector.js's invalidateRankCache also delegates to — one cache,
// invalidated from either call site.
export function invalidateSceneTooltipCache() {
  invalidateRankCache();
}

// Memoized alongside (not inside) rank-cache.js: that module returns a
// plain array shared by all consumers, so a Map keyed off it here is
// rebuilt only when the underlying array reference changes (i.e. after a
// real refetch), not on every hover. One slot per battle type, mirroring
// rank-cache.js's own per-battle-type cache.
/** @type {{ performers: { source: any[] | null, byId: Map<string, any> | null }, scenes: { source: any[] | null, byId: Map<string, any> | null } }} */
const memo = {
  performers: { source: null, byId: null },
  scenes: { source: null, byId: null },
};

async function handleHover(host) {
  const link = host.closest("a[href^='/performers/'], a[href^='/scenes/']");
  if (!link) return;
  // Resolved fresh on every hover rather than captured once at bind time:
  // React can reuse a .performer-card-image/.scene-card-preview node for a
  // different entity (list re-sort, filter change, virtualized scroll),
  // which would leave a closure-captured id stale.
  const entity = parseEntityHref(/** @type {HTMLAnchorElement} */(link).href);
  if (!entity) return;

  const items = await getRankedItems(entity.battleType);
  const slot = memo[entity.battleType];
  if (slot.source !== items) {
    slot.source = items;
    slot.byId = new Map(items.map((p) => [p.id, p]));
  }
  const p = /** @type {Map<string, any>} */(slot.byId).get(entity.id);
  if (!p) return;
  const winRate = p.stats.total_matches > 0 ? ((p.stats.wins / p.stats.total_matches) * 100).toFixed(1) : "0.0";
  // p.rating100 is the raw rating (rank-cache.js spreads the raw GraphQL
  // field onto each entry); p.rank/p.composite are the composite-derived
  // sort — rank and displayed rating are two different, correctly-paired
  // values here, not the same number twice.
  /** @type {HTMLElement} */(host).title = `Rank #${p.rank} of ${items.length}\nRating: ${formatDisplayRating(p.rating100)}\nRecord: ${p.stats.wins}W-${p.stats.losses}L (${winRate}%)`;
}

/** @type {((e: MouseEvent) => void) | null} */
let delegatedHandler = null;

// One delegated listener on document.body instead of a per-element
// mouseenter + ".hon-tooltip-bound" flag. mouseenter doesn't bubble — even
// with capture:true it still dispatches once per ancestor entered, so a
// single mouse move over nested elements fires it N times. mouseover
// bubbles, giving exactly one dispatch per hovered element, and lets the id
// be resolved fresh from the DOM per event (see handleHover) instead of
// requiring a per-node bound flag that survives node reuse.
export function setupSceneTooltips() {
  if (delegatedHandler) return;
  delegatedHandler = (e) => {
    const target = /** @type {Element} */(e.target);
    // .scene-card-preview (the container), not .scene-card-preview-image —
    // Stash overlays a <video> on top of the <img> on hover, so a title set
    // on the img alone would be covered.
    const host = target.closest?.(".performer-card-image, .scene-card-preview");
    if (!host) return;
    handleHover(host).catch((err) => console.error("[Xenith] scene tooltip hover failed", err));
  };
  document.body.addEventListener("mouseover", delegatedHandler);
}

export function destroySceneTooltips() {
  if (delegatedHandler) {
    document.body.removeEventListener("mouseover", delegatedHandler);
    delegatedHandler = null;
  }
  memo.performers.source = null;
  memo.performers.byId = null;
  memo.scenes.source = null;
  memo.scenes.byId = null;
}
