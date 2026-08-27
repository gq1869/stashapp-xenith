// Injects the Xenith rank badge into native Stash performer/scene cards
// outside the plugin's own React tree — DOM mutation + a MutationObserver
// (routeObserver) watching for SPA navigation, not a component. Reads
// ranking data from rank-cache.js rather than fetching its own.
const { React, ReactDOM } = window.PluginApi;
import { BattleRankBadge } from "./components/BattleRankBadge";
import { getRankedItems, invalidateRankCache as invalidateSharedRankCache } from "./rank-cache";
import { parseEntityHref, parseEntityPath } from "./entity-href";
import { getPluginConfig, resetPluginConfig } from "./plugin-config";

// Removes the already-injected detail badge and strips .hon-processed from
// every card (which also un-hides their native .rating-banner, since that
// hide is scoped to .thumbnail-section.hon-processed .rating-banner in
// xenith.css) so the next injectBattleRankBadge() pass re-renders fresh
// badges in place, instead of a vote only visibly updating after a
// navigation away and back.
export function resetInjectedBadges() {
  document.getElementById("hon-battle-rank-badge")?.remove();
  document.querySelectorAll(".thumbnail-section.hon-processed").forEach((card) => {
    card.classList.remove("hon-processed");
    card.querySelectorAll(".hon-compact-badge").forEach((badge) => badge.remove());
  });
}

export function invalidateRankCache() {
  invalidateSharedRankCache();
  resetInjectedBadges();
}

async function isHideBadgeEnabled() {
  try {
    const config = await getPluginConfig();
    return config.HideXenRankBadge === true;
  } catch (err) {
    // Fail closed (hide badges) rather than open — getPluginConfig() caches
    // the failure itself (see plugin-config.js), so this doesn't need its
    // own backoff on top.
    console.error("[Xenith] failed to load HideXenRankBadge config, hiding badges", err);
    return true;
  }
}

let detailInjecting = false;

function currentEntityFromPath() {
  return parseEntityPath(window.location.pathname);
}

// Scene detail's rating lives in the first .scene-toolbar-group (the
// structural analogue of performer detail's .quality-group), where Stash
// renders its own RatingSystem star widget.
function detailHostSelector(battleType) {
  return battleType === "scenes" ? ".scene-toolbar .scene-toolbar-group" : ".quality-group";
}

// React reuses the host node across same-route navigations (param change
// only), so an existing #hon-battle-rank-badge only proves *some* badge was
// injected, not that it's for the current entity. Tags the container with
// the battleType:id it was built for, so this can tell a stale badge apart
// from a fresh one (including a /performers/7 -> /scenes/7 navigation,
// which must not be read as "same entity"). Returns the still-current badge
// if one exists, otherwise removes any stale badge and returns null.
function removeStaleBadge(currentEntity) {
  const badge = document.getElementById("hon-battle-rank-badge");
  if (!badge) return null;
  if (badge.dataset.entityKey === `${currentEntity.battleType}:${currentEntity.id}`) return badge;
  badge.remove();
  return null;
}

async function injectOnPerformerDetail() {
  const entity = currentEntityFromPath();
  if (!entity) return;

  const target = document.querySelector(detailHostSelector(entity.battleType));
  if (!target) return;

  // Synchronous guards, checked before any await: routeObserver invokes this
  // function on DOM mutations. The `detailInjecting` flag closes concurrent-pass
  // races; the DOM check backs it up for the first call.
  if (detailInjecting) return;
  if (removeStaleBadge(entity)) return;

  detailInjecting = true;
  try {
    if (await isHideBadgeEnabled()) return;

    // Re-validate after every await — the pathname may have changed (a
    // same-route navigation) since this call started.
    let liveEntity = currentEntityFromPath();
    if (!liveEntity) return;
    if (removeStaleBadge(liveEntity)) return;

    const ranked = await getRankedItems(liveEntity.battleType);

    liveEntity = currentEntityFromPath();
    if (!liveEntity) return;
    const item = ranked.find((p) => p.id === liveEntity.id);
    if (!item) return;
    if (removeStaleBadge(liveEntity)) return;

    const liveTarget = document.querySelector(detailHostSelector(liveEntity.battleType));
    if (!liveTarget) return;

    const container = document.createElement("span");
    container.id = "hon-battle-rank-badge";
    container.dataset.entityKey = `${liveEntity.battleType}:${liveEntity.id}`;
    liveTarget.appendChild(container);
    ReactDOM.render(
      React.createElement(BattleRankBadge, {
        rank: item.rank,
        total: ranked.length,
        rating100: item.rating100,
        stats: item.stats,
        record: item.record,
        battleType: liveEntity.battleType,
      }),
      container
    );
  } finally {
    detailInjecting = false;
  }
}

let cardsInjecting = false;
// Set when the observer fires again while an injection pass is already in
// flight. injectOnPerformerCards snapshots `cards` once at the start, so
// cards mounting during the ~1 RTT of isHideBadgeEnabled + getRankedItems
// were previously dropped silently — only picked up by some later,
// unrelated mutation. Re-checked in `finally` to trigger one more pass.
let cardsDirty = false;

async function injectOnPerformerCards() {
  // Bail before any network/GQL work if there's nothing on this page to
  // inject into.
  const cards = Array.from(document.querySelectorAll(".thumbnail-section:not(.hon-processed)")).filter(
    (el) => !el.closest(".hon-card-native-wrap")
  );
  if (cards.length === 0) return;

  if (cardsInjecting) {
    cardsDirty = true;
    return;
  }

  cardsInjecting = true;
  try {
    if (await isHideBadgeEnabled()) return;

    // Resolve each card's entity up front, so only the battle types actually
    // present on this page get fetched — a performers-only page still makes
    // exactly one query, same as before scenes support.
    const cardEntities = cards.map((card) => {
      const link = card.querySelector("a[href^='/performers/'], a[href^='/scenes/']");
      const entity = link ? parseEntityHref(/** @type {HTMLAnchorElement} */(link).href) : null;
      return { card, entity };
    });

    /** @type {("performers" | "scenes")[]} */
    const battleTypes = [
      ...new Set(cardEntities.map((c) => c.entity?.battleType).filter((bt) => bt !== undefined)),
    ];
    /** @type {Map<"performers" | "scenes", any[]>} */
    const rankedByType = new Map();
    /** @type {Map<"performers" | "scenes", Map<string, any>>} */
    const rankByIdByType = new Map();
    await Promise.all(
      battleTypes.map(async (bt) => {
        const ranked = await getRankedItems(bt);
        rankedByType.set(bt, ranked);
        rankByIdByType.set(bt, new Map(ranked.map((p) => [p.id, p])));
      })
    );

    cardEntities.forEach(({ card, entity }) => {
      if (!entity) return;
      const rankById = rankByIdByType.get(entity.battleType);
      const item = rankById?.get(entity.id);
      const ranked = rankedByType.get(entity.battleType);
      if (!item || !ranked) return;

      // .rating-banner is React-owned (Stash's RatingBanner, rendered inside
      // PerformerCard/SceneCard only when rating100 is truthy). It's also not
      // always present at all — an unrated entity gets no banner, which used
      // to cause the card to be skipped entirely. Anchor on the
      // always-present .thumbnail-section instead: append as a sibling and
      // hide the banner via CSS (.hon-processed .rating-banner, xenith.css)
      // rather than removing it from the DOM, so React never targets a
      // missing node if it later re-renders the banner in place.
      const container = document.createElement("div");
      container.className = "hon-compact-badge";
      card.appendChild(container);

      ReactDOM.render(
        React.createElement(BattleRankBadge, {
          rank: item.rank,
          total: ranked.length,
          rating100: item.rating100,
          stats: item.stats,
          compact: true,
        }),
        container
      );

      // Only mark processed once the badge has actually been injected — a
      // card that hasn't successfully rendered a badge stays eligible for
      // retry on the next mutation batch instead of being skipped forever.
      card.classList.add("hon-processed");
    });
  } finally {
    cardsInjecting = false;
    if (cardsDirty) {
      cardsDirty = false;
      injectOnPerformerCards().catch((err) => console.error("[Xenith] injectOnPerformerCards retry failed", err));
    }
  }
}

// src/main.js's rAF-debounced routeObserver is the sole MutationObserver caller of
// this function — this module used to install its own duplicate
// (undebounced) observer on document.body here, which bypassed that
// debounce and caused uncoalesced work on pages with frequent DOM churn.
export function injectBattleRankBadge() {
  injectOnPerformerDetail().catch((err) => console.error("[Xenith] injectOnPerformerDetail failed", err));
  injectOnPerformerCards().catch((err) => console.error("[Xenith] injectOnPerformerCards failed", err));
}

export function destroyBadgeInjector() {
  invalidateSharedRankCache();
  resetPluginConfig();
}
