// // @ts-check
import { test, expect } from "@playwright/test";
import { mockGraphQL, performer, scene, PERFORMERS, SCENES, richPerformers, richScenes } from "./fixtures/graphql.js";

/**
 * Requires a live Stash instance (STASH_URL, default localhost:9999) with
 * Xenith built and loaded as a plugin. GraphQL responses are mocked for
 * determinism (see fixtures/graphql.js); everything else — modal
 * lifecycle, MutationObservers, badge injection, event listeners — is
 * exercised against the real main.js / badge-injector.js / scene-tooltips.js.
 *
 * The two tests that used to be marked `test.fail()` — shortcuts firing
 * while typing in a background input, and a failed match mutation not
 * surfacing .hon-error — were flipped to plain `test()` once HeadToHead.jsx
 * and usePair.js were fixed. If either regresses, it'll fail loudly here.
 */

async function openModal(page) {
  await page.locator("#hon-floating-btn").click();
  await expect(page.locator("#hon-modal")).toBeVisible();
}

async function closeModal(page) {
  await page.locator(".hon-modal-close").click();
  await expect(page.locator("#hon-modal")).toBeHidden();
}

// Regression guard: the Gauntlet challenger preview sits outside
// .hon-vs-container (see the comment above .hon-gauntlet-preview in
// xenith.css), so it doesn't inherit the grid row that normally gives
// .hon-scene-card a definite height. Without an explicit height
// constraint the native card falls back to its image's intrinsic size and
// overflows .hon-modal-content, which .hon-main-plugin-content's
// overflow: auto then turns into a real scrollbar instead of the card
// just fitting. Checks the bottom edge only — width already has its own
// max-width: 420px cap (see xenith.css) that this isn't testing.
async function expectFitsInsideModal(page, locator) {
  const modalBottom = await page.locator(".hon-modal-content").evaluate(
    (el) => el.getBoundingClientRect().bottom
  );
  const elBottom = await locator.evaluate((el) => el.getBoundingClientRect().bottom);
  expect(elBottom).toBeLessThanOrEqual(modalBottom + 1);
}

test.beforeEach(async ({ page }) => {
  await mockGraphQL(page);
  await page.goto("/");
});

// ---------------------------------------------------------------------
// 1. Reopening modal after close doesn't duplicate DOM nodes / React trees
// ---------------------------------------------------------------------
test("reopening the modal does not duplicate #hon-modal or double-mount React", async ({ page }) => {
  for (let i = 0; i < 5; i++) {
    await openModal(page);
    await expect(page.locator("#hon-modal")).toHaveCount(1);
    await expect(page.locator("#hon-app-mount > *")).toHaveCount(1);
    await closeModal(page);
  }
  // main.js reuses `modalRoot` across opens (creates it once, toggles
  // display), so there should never be more than one #hon-modal in the DOM.
  await expect(page.locator("#hon-modal")).toHaveCount(1);
});

test("Escape key closes the modal same as backdrop/close-button", async ({ page }) => {
  await openModal(page);
  await page.keyboard.press("Escape");
  await expect(page.locator("#hon-modal")).toBeHidden();
});

// ---------------------------------------------------------------------
// 2. Large library — sampling kicks in, no full-table fetch for scenes
// ---------------------------------------------------------------------
test("scene battles request a capped, randomly-sampled page (per_page: 500), never the full table", async ({ page }) => {
  const gql = await mockGraphQL(page);
  await page.goto("/"); // re-mock after beforeEach's mock is replaced by gql above
  await openModal(page);
  await page.locator(".hon-sidebar-row", { hasText: "Scenes" }).click();

  await expect.poll(() => gql.requests.some((r) => r.operation === "FindScenesCandidates")).toBeTruthy();
  const findScenes = gql.requests.filter((r) => r.operation === "FindScenesCandidates").at(-1);
  expect(findScenes.variables.filter.per_page).toBe(500);
  expect(findScenes.variables.filter.sort).toBe("random");
  expect(findScenes.variables.filter.per_page).not.toBe(-1);
});

test("leaderboard performer fetch legitimately uses per_page: -1 (full table is expected there)", async ({ page }) => {
  const gql = await mockGraphQL(page);
  await page.goto("/");
  await openModal(page);
  await page.locator(".hon-sidebar-row", { hasText: "Leaderboard" }).click();

  // Leaderboard fetches via rank-cache.js's getRankedItems(), which posts
  // api.js's FIND_PERFORMERS_RANK — a separate query from api.js's
  // candidate/by-ids queries — was previously asserting on the wrong
  // operation name and passing through to the live instance unmocked
  // instead of exercising this assertion at all.
  await expect.poll(() => gql.requests.some((r) => r.operation === "FindPerformersRank" && r.variables.filter?.per_page === -1))
    .toBeTruthy();
});

// Scenes leaderboard: Leaderboard.jsx used to ignore battleType
// entirely, always rendering the performer ranking. Switching Record Type
// to Scenes should now fetch FIND_SCENES_RANK and render scene rows,
// linking out to /scenes/:id instead of /performers/:id.
test("switching Record Type to Scenes on the Leaderboard fetches and renders scene rows", async ({ page }) => {
  const gql = await mockGraphQL(page);
  await page.goto("/");
  await openModal(page);
  await page.locator(".hon-sidebar-row", { hasText: "Scenes" }).click();
  await page.locator(".hon-sidebar-row", { hasText: "Leaderboard" }).click();

  await expect.poll(() => gql.requests.some((r) => r.operation === "FindScenesRank" && r.variables.filter?.per_page === -1))
    .toBeTruthy();

  const firstRow = page.locator(".hon-stats-table tbody tr").first();
  await expect(firstRow).toBeVisible();
  const link = firstRow.locator(".hon-stats-name a");
  await expect(link).toHaveAttribute("href", /^\/scenes\//);
});

// ---------------------------------------------------------------------
// 3. Keyboard shortcuts must not fire while typing in a background input
// ---------------------------------------------------------------------
test(
  "arrow/space shortcuts do not fire while an unrelated input outside the modal is focused",
  async ({ page }) => {
    // Use a fixture input we control instead of Stash's own nav search box —
    // that markup isn't part of Xenith's contract and can change between
    // Stash versions/viewports, which is what caused this test to time out
    // waiting for a selector that never appears.
    await page.evaluate(() => {
      const input = document.createElement("input");
      input.id = "xenith-test-outside-input";
      document.body.appendChild(input);
    });
    const searchInput = page.locator("#xenith-test-outside-input");

    await searchInput.click();
    await openModal(page);
    await searchInput.focus(); // refocus background input while modal is open

    const initialTitle = await page.locator(".hon-vs-container").first().textContent();
    await page.keyboard.type(" "); // space -> should type into searchInput, not skip()
    await expect(searchInput).toHaveValue(" ");
    await expect(page.locator(".hon-vs-container").first()).toHaveText(initialTitle);
  }
);

// ---------------------------------------------------------------------
// 4. Undo history caps at MAX_HISTORY (15, bumped from 10 by Gauntlet
// work so a full ~14-match run stays undoable end to end) and doesn't grow
// unbounded
// ---------------------------------------------------------------------
test("undo is available for at most 15 matches back, never more", async ({ page }) => {
  await openModal(page);
  for (let i = 0; i < 18; i++) {
    await page.locator('[data-side="left"] .hon-choose-btn').first().click();
    await page.waitForTimeout(1200); // RESULT_DELAY_MS (1000) in usePair.js, plus margin
  }
  let undoCount = 0;
  while (await page.locator(".hon-action-btn").nth(1).isEnabled()) {
    await page.locator(".hon-action-btn").nth(1).click();
    await page.waitForTimeout(100);
    undoCount++;
    if (undoCount > 20) break; // safety valve against an infinite loop bug
  }
  expect(undoCount).toBeLessThanOrEqual(15);
});

// ---------------------------------------------------------------------
// Regression: undo must work during the ~1s outcome overlay, not
// just after it clears — that's exactly when a user who saw the outcome
// wants to reverse it.
// ---------------------------------------------------------------------
test("undo works during the outcome overlay, before it auto-advances to the next pair", async ({ page }) => {
  await openModal(page);
  const preMatchPair = await page.locator(".hon-vs-container").first().textContent();

  await page.locator('[data-side="left"] .hon-choose-btn').first().click();

  // No RESULT_DELAY_MS wait here on purpose — the overlay is still up.
  const undoBtn = page.locator(".hon-action-btn").nth(1);
  await expect(undoBtn).toBeEnabled();
  await undoBtn.click();

  // Restored pair should match what was showing pre-match, not whatever
  // the overlay's queued auto-advance would have fetched next.
  await expect(page.locator(".hon-vs-container").first()).toHaveText(preMatchPair);
});

// ---------------------------------------------------------------------
// 5 & 6. Undo / matches invalidate the badge rank cache immediately,
//        not just after the 60s CACHE_TTL_MS window
// ---------------------------------------------------------------------
test("a completed match invalidates the badge rank cache immediately (no stale rank until TTL expires)", async ({ page }) => {
  const gql = await mockGraphQL(page);
  await page.goto("/");

  // Visit a performer page first — this populates rank-cache.js's
  // module-scope cache via getRankedItems("performers") (FindPerformersRank,
  // a separate query from FindPerformers below).
  await page.goto(`/performers/2`);
  await expect(page.locator("#hon-battle-rank-badge")).toBeVisible({ timeout: 5000 });
  const findPerformersCallsBeforeMatch = gql.requests.filter((r) => r.operation === "FindPerformersRank").length;

  await openModal(page);
  await page.locator('[data-side="left"] .hon-choose-btn').first().click();
  await page.waitForTimeout(800);
  await closeModal(page);

  await page.goto(`/performers/2`);
  await expect(page.locator("#hon-battle-rank-badge")).toBeVisible({ timeout: 5000 });
  const findPerformersCallsAfterMatch = gql.requests.filter((r) => r.operation === "FindPerformersRank").length;

  // invalidateRankCache() nulls rankedCache/cacheTimestamp in
  // badge-injector.js after every match — a fresh FindPerformers call
  // should fire on next badge injection instead of serving the 60s cache.
  expect(findPerformersCallsAfterMatch).toBeGreaterThan(findPerformersCallsBeforeMatch);
});

// ---------------------------------------------------------------------
// 7. Badge injection survives SPA navigation, no duplicate MutationObservers,
//    and never shows a stale/wrong performer's rank
// ---------------------------------------------------------------------
test("navigating between performer pages repeatedly shows exactly one badge each time, no duplicates, always for the current performer", async ({ page }) => {
  for (const id of [2, 4, 3, 5, 2]) {
    await page.goto(`/performers/${id}`);
    const badge = page.locator("#hon-battle-rank-badge");
    await expect(badge).toHaveCount(1, { timeout: 5000 });
    // badge-injector.js re-validates the entity after every await and tags
    // the container with data-entity-key ("battleType:id") — a stale
    // in-flight request from the previous page must never render onto
    // this one. Direct check that the badge belongs to the page it's on,
    // not just that exactly one badge element exists somewhere.
    await expect(badge).toHaveAttribute("data-entity-key", `performers:${id}`);
  }
});

test("main.js's routeObserver and badge-injector's observer are singletons, never re-created on navigation", async ({ page }) => {
  // page.goto() is always a hard document reload in Playwright — it never
  // simulates a link click, so React Router gets no chance to intercept it
  // client-side. A hard reload re-runs main.js from scratch AND wipes any
  // window overrides installed via page.evaluate(), which made the original
  // version of this test meaningless (it was measuring "did the page reload",
  // not "did the observer get re-created").
  //
  // To exercise real SPA routing without depending on a specific nav link
  // being present, we push history state and dispatch `popstate` ourselves —
  // this is exactly what React Router's browser history listens for, so it
  // reacts the same way a real back/forward navigation would, without a
  // full page reload.
  await page.goto(`/performers/2`);
  await expect(page.locator("#hon-battle-rank-badge")).toBeVisible({ timeout: 5000 });

  await page.evaluate(() => {
    // @ts-ignore
    window.__observerInstances = 0;
    const OriginalMO = window.MutationObserver;
    // @ts-ignore
    window.MutationObserver = class extends OriginalMO {
      constructor(...args) {
        super(...args);
        // @ts-ignore
        window.__observerInstances++;
      }
    };
  });
  const before = await page.evaluate(() => /** @type any */(window).__observerInstances);

  for (const id of [2, 3, 4, 5, 6]) {
    await page.evaluate((performerId) => {
      window.history.pushState({}, "", `/performers/${performerId}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, id);
    // Give React Router + Xenith's routeObserver a beat to react to the
    // route change without relying on a network request.
    await page.waitForTimeout(300);
  }

  const after = await page.evaluate(() => /** @type any */(window).__observerInstances);
  // main.js creates a single routeObserver once at load; badge-injector.js
  // no longer installs its own duplicate observer at all, relying
  // entirely on main.js's rAF-debounced one. No new observer should ever be
  // created across client-side route changes — only the initial hard load
  // above should have created any (tracked via `before`).
  expect(after - before).toBe(0);
});

// ---------------------------------------------------------------------
// 8. No duplicate tooltip binding on repeated hover
// ---------------------------------------------------------------------
test("scene-page performer thumbnails get a tooltip via one delegated listener despite repeated DOM mutations", async ({ page, request }) => {
  // scene-tooltips.js resolves rank/tier via rank-cache.js's
  // FindPerformersRank, now mocked (see fixtures/graphql.js) — the
  // synthetic PERFORMERS fixture only has ids 1-30, so a real scene's
  // real performer id (whatever it happens to be in this library) won't
  // be found in it unless added here. Discovered at runtime rather than
  // hardcoded to keep this test working across different libraries and
  // avoid baking a specific real performer's id into source.
  const res = await request.post("/graphql", {
    data: { query: "query { findScene(id: 30000) { performers { id } } }" },
  });
  const body = await res.json();
  const realIds = (body?.data?.findScene?.performers || []).map((p) => p.id);
  await mockGraphQL(page, { performers: [...PERFORMERS, ...realIds.map((id) => performer(id))] });

  await page.goto(`/scenes/30000`);
  const img = page.locator(".performer-card-image").first();
  await expect(img).toHaveCount(1, { timeout: 5000 });

  // setupSceneTooltips() re-runs on every routeObserver mutation, but binds
  // a single delegated mouseover listener guarded by a module-level
  // `delegatedHandler` flag (scene-tooltips.js) rather than a per-element
  // bound class, so re-running it is a no-op. Repeated hovers should still
  // resolve a tooltip each time without throwing or leaving stale state.
  for (let i = 0; i < 3; i++) {
    await img.hover();
    await page.mouse.move(0, 0);
  }
  await expect(img).toHaveAttribute("title", /Rank #/);
  // A true listener-count check would need CDP's DOMDebugger.getEventListeners
  // against a specific backendNodeId, which is fiddly enough across Chrome
  // versions that it's not worth the flakiness here — the delegated-listener
  // guard in scene-tooltips.js is what actually prevents re-binding.
});

// ---------------------------------------------------------------------
// 8b. badge-injector.js/scene-tooltips.js now cover scenes, not just
// performers. The /scenes list page's default sort is unpredictable
// (whatever order this library's real scenes happen to be in), so — unlike
// test 8 above, which targets a fixed known scene id — the real id under
// test is discovered from the rendered page itself: load once under a
// generic mock, read the first card's real id off the DOM, then re-mock
// with that id pinned into the FindScenesRank pool and reload. The
// synthetic SCENES fixture only covers ids 1-30, so without this the real
// scene wouldn't be found in rank-cache.js's ranked list at all.
// ---------------------------------------------------------------------
test("a scene card on the scenes list gets a compact rank badge", async ({ page }) => {
  await mockGraphQL(page);
  await page.goto("/scenes");
  const href = await page.locator("a.scene-card-link").first().getAttribute("href");
  const id = href.match(/\/scenes\/(\d+)/)[1];

  await mockGraphQL(page, { scenes: [...SCENES, scene(id)] });
  await page.reload();

  const card = page.locator(".thumbnail-section", { has: page.locator(`a[href^='/scenes/${id}']`) }).first();
  await expect(card.locator(".hon-compact-badge")).toBeVisible({ timeout: 5000 });
  await expect(card).toHaveClass(/hon-processed/);
});

test("hovering a scene card preview on the scenes list shows a rank tooltip", async ({ page }) => {
  await mockGraphQL(page);
  await page.goto("/scenes");
  const href = await page.locator("a.scene-card-link").first().getAttribute("href");
  const id = href.match(/\/scenes\/(\d+)/)[1];

  await mockGraphQL(page, { scenes: [...SCENES, scene(id)] });
  await page.reload();

  const preview = page.locator(`a[href^='/scenes/${id}'] .scene-card-preview`).first();
  await expect(preview).toHaveCount(1, { timeout: 5000 });
  await preview.hover();
  await expect(preview).toHaveAttribute("title", /Rank #/);
});

// ---------------------------------------------------------------------
// 9. Tab state doesn't leak battleType when switching tabs mid-battle
// ---------------------------------------------------------------------
test("switching to Leaderboard mid-scene-battle and back preserves the Scenes selection", async ({ page }) => {
  await openModal(page);
  await page.locator(".hon-sidebar-row", { hasText: "Scenes" }).click();
  await expect(page.locator(".hon-sidebar-row.active", { hasText: "Scenes" })).toBeVisible();

  await page.locator(".hon-sidebar-row", { hasText: "Leaderboard" }).click();
  await expect(page.locator(".hon-leaderboard")).toBeVisible();

  await page.locator(".hon-sidebar-row", { hasText: "Head to Head" }).click();
  // state.js's module-scope `persisted` object should have retained
  // battleType: "scenes" across the tab switch.
  await expect(page.locator(".hon-sidebar-row.active", { hasText: "Scenes" })).toBeVisible();
});

// ---------------------------------------------------------------------
// 9b. Gauntlet mode plays scenes — previously guarded to Performers
// only. Challenger preview should render a scene card via SceneCard.jsx's
// native-component path, and Start Run should begin an active run using the
// scenes ladder (getRankedItems("scenes")).
// ---------------------------------------------------------------------
test("Gauntlet mode plays scenes: challenger preview renders a scene card and Start Run begins a run", async ({ page }) => {
  await openModal(page);
  await page.locator(".hon-sidebar-row", { hasText: "Scenes" }).click();
  await page.locator(".hon-sidebar-row", { hasText: "Gauntlet" }).click();

  const preview = page.locator(".hon-gauntlet-preview");
  await expect(preview).toBeVisible();
  await expect(preview.locator('.hon-scene-card[data-side="left"]')).toBeVisible();
  await expectFitsInsideModal(page, preview);

  await preview.locator(".hon-choose-btn", { hasText: "Start Run" }).click();

  await expect(page.locator(".hon-run-banner")).toBeVisible();
  await expect(page.locator(".hon-run-banner-count")).toHaveText(/Match 1 of/);
  await expect(page.locator('[data-side="left"] .hon-choose-btn')).toBeVisible();
  await expect(page.locator('[data-side="right"] .hon-choose-btn')).toBeVisible();
});

// ---------------------------------------------------------------------
// 9c. Gauntlet challenger preview stays inside the modal for Performers too
// — the performer card is sized by height, unlike the scene card
// above which is sized by width and was never the overflow source.
// ---------------------------------------------------------------------
test("Gauntlet challenger preview (performers) fits inside the modal without scrolling", async ({ page }) => {
  await openModal(page);
  await page.locator(".hon-sidebar-row", { hasText: "Gauntlet" }).click();

  const preview = page.locator(".hon-gauntlet-preview");
  await expect(preview).toBeVisible();
  await expect(preview.locator('.hon-scene-card[data-side="left"]')).toBeVisible();
  await expectFitsInsideModal(page, preview);
  await expect(preview.locator(".hon-choose-btn", { hasText: "Start Run" })).toBeVisible();
  // Metadata chips — both battle types get chips on the Gauntlet preview.
  await expect(preview.locator(".hon-chip").first()).toHaveText(/^Rating /);
});

// ---------------------------------------------------------------------
// 9d. Metadata chips — curated allowlist
// rendered as fixed-height chips on h2h/Gauntlet cards, replacing the old
// single Rating meta row for performers, and the old Performers/Rating
// meta row for scenes.
// ---------------------------------------------------------------------
test("h2h performer card renders metadata chips led by Rating", async ({ page }) => {
  await openModal(page);
  const chips = page.locator('[data-side="left"] .hon-chip');
  await expect(chips.first()).toHaveText(/^Rating /);
  expect(await chips.count()).toBeGreaterThan(0);
});

test("h2h scene card renders metadata chips led by Rating, no more .hon-scene-meta row", async ({ page }) => {
  await openModal(page);
  await page.locator(".hon-sidebar-row", { hasText: "Scenes" }).click();
  const chips = page.locator('[data-side="left"] .hon-chip');
  await expect(chips.first()).toHaveText(/^Rating /);
  expect(await chips.count()).toBeGreaterThan(0);
  await expect(page.locator('[data-side="left"] .hon-scene-meta')).toHaveCount(0);
});

test("chip row height is fixed regardless of chip count — never grows like Ascension's field dump", async ({ page }) => {
  // .hon-modal-content's 0.22s enter animation scales the modal in
  // (hon-modal-enter keyframes) — wait it out before measuring geometry,
  // or getBoundingClientRect returns a mid-transition, non-deterministic
  // value instead of the settled 78px.
  const chipsEl = () => page.locator('[data-side="left"] .hon-card-chips');
  const measure = async () => {
    await page.waitForTimeout(300);
    return chipsEl().evaluate((el) => el.getBoundingClientRect().height);
  };

  // Default pool (beforeEach's mockGraphQL) — each performer only has
  // Rating + Height available (the factory's other chip-eligible fields
  // default to null/0).
  await openModal(page);
  const sparseHeight = await measure();

  // Rich pool — every performer has all chip-eligible fields set plus 40
  // tags, enough to overflow the fixed budget no matter which two get
  // selected as the pair.
  await mockGraphQL(page, { performers: richPerformers() });
  await page.goto("/");
  await openModal(page);
  const richHeight = await measure();

  expect(richHeight).toBeCloseTo(sparseHeight, 0);
  expect(richHeight).toBeCloseTo(78, 0); // 3 lines * 22px + 2 gaps * 6px

  // Overflow: exactly one static "+N" chip, last in the row.
  await expect(page.locator('[data-side="left"] .hon-chip-overflow')).toHaveCount(1);
  await expect(page.locator('[data-side="left"] .hon-chip-overflow')).toHaveText(/^\+\d+$/);
  const overflowIsLast = await chipsEl().evaluate(
    (el) => el.lastElementChild.classList.contains("hon-chip-overflow")
  );
  expect(overflowIsLast).toBe(true);
});

test("scene chip row height is fixed against a sparse vs. a rich scene pool", async ({ page }) => {
  const chipsEl = () => page.locator('[data-side="left"] .hon-card-chips');
  const measure = async () => {
    await page.waitForTimeout(300);
    return chipsEl().evaluate((el) => el.getBoundingClientRect().height);
  };

  // Default SCENES fixture — date/duration/resolution/size/codecs are set,
  // but performers/studio/tags/groups/counts are all empty (scene()'s
  // defaults), a sparse-but-not-bare case.
  await openModal(page);
  await page.locator(".hon-sidebar-row", { hasText: "Scenes" }).click();
  const sparseHeight = await measure();

  // Rich pool — every scene has all sixteen chip-eligible fields populated.
  await mockGraphQL(page, { scenes: richScenes() });
  await page.goto("/");
  await openModal(page);
  await page.locator(".hon-sidebar-row", { hasText: "Scenes" }).click();
  const richHeight = await measure();

  expect(richHeight).toBeCloseTo(sparseHeight, 0);
  expect(richHeight).toBeCloseTo(78, 0); // 3 lines * 22px + 2 gaps * 6px

  await expect(page.locator('[data-side="left"] .hon-chip-overflow')).toHaveCount(1);
  await expect(page.locator('[data-side="left"] .hon-chip-overflow')).toHaveText(/^\+\d+$/);
});

test("performer age is hidden natively but shown as a chip instead", async ({ page }) => {
  const withBirthdate = PERFORMERS.map((p) => ({ ...p, birthdate: "1990-01-01" }));
  await mockGraphQL(page, { performers: withBirthdate });
  await page.goto("/");
  await openModal(page);

  const age = page.locator('[data-side="left"] .performer-card__age');
  await expect(age).toHaveCount(1);
  await expect(age).toHaveCSS("display", "none");

  const ageChip = page.locator('[data-side="left"] .hon-chip').filter({ hasText: /^Age \d+$/ });
  await expect(ageChip).toHaveCount(1);
});

// ---------------------------------------------------------------------
// 10. Backend task stdout — covered by the Python suite (../backend/test_tasks.py),
//     not repeated here since it doesn't require a browser.
// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
// 11. Disconnecting from Stash mid-match shows .hon-error, doesn't hang
// ---------------------------------------------------------------------
test(
  "a failed match mutation (network drop mid-choose) surfaces .hon-error instead of hanging",
  async ({ page }) => {
    // usePair.js's `choose()` now wraps its Promise.all([applyRating,
    // applyRating]) in try/catch and calls setError() on rejection — the
    // same error state HeadToHead.jsx already renders as .hon-error for a
    // failed loadPair(). history/result are left untouched on failure, so
    // no phantom undo entry gets created for a match that never committed.
    await openModal(page);
    await page.route("**/graphql", async (route) => {
      const body = route.request().postDataJSON();
      if (/UpdatePerformer|UpdateScene/.test(body?.query || "")) {
        await route.abort("failed");
        return;
      }
      await route.continue();
    });
    await page.locator('[data-side="left"] .hon-choose-btn').first().click();
    await expect(page.locator(".hon-error")).toBeVisible({ timeout: 5000 });
  }
);

// ---------------------------------------------------------------------
// 13. Closing the modal fully unmounts React, no leftover listeners
// ---------------------------------------------------------------------
test("closing the modal unmounts React and does not leak keydown listeners on repeated open/close", async ({ page }) => {
  for (let i = 0; i < 5; i++) {
    await openModal(page);
    await closeModal(page);
  }
  // handleEscape is a single document-level listener installed once at
  // plugin load and never removed until __xenithCleanup runs — that's
  // expected to persist. What must NOT accumulate is React-internal
  // listeners bound to unmounted nodes; a rough proxy is confirming the
  // mount node is empty after each close.
  await expect(page.locator("#hon-app-mount")).toBeEmpty();
});

// ---------------------------------------------------------------------
// 14. window.__xenithCleanup disconnects the route observer
// ---------------------------------------------------------------------
test("window.__xenithCleanup disconnects the route observer and is idempotent/reloadable", async ({ page }) => {
  await page.addInitScript(() => {
    // Runs before any page script on every navigation in this page —
    // survives page.goto()'s hard reload, unlike page.evaluate().
    window.__disconnectCalls = 0;
    const proto = MutationObserver.prototype;
    const original = proto.disconnect;
    proto.disconnect = function (...args) {
      window.__disconnectCalls++;
      return original.apply(this, args);
    };
  });

  await page.goto(`/performers/2`);
  await expect(page.locator("#hon-battle-rank-badge")).toBeVisible({ timeout: 5000 });

  await page.evaluate(() => /** @type any */(window).__xenithCleanup());
  const disconnectCalls = await page.evaluate(() => /** @type any */(window).__disconnectCalls);
  // badge-injector.js no longer installs its own MutationObserver —
  // main.js's single routeObserver is the only one left to disconnect.
  expect(disconnectCalls).toBeGreaterThanOrEqual(1);

  // cleanup self-cleans (deletes __xenithCleanup, clears the
  // __xenithLoaded double-load guard), so it can't be called twice, and a
  // subsequent script load would re-run the IIFE rather than being a no-op.
  const stateAfterCleanup = await page.evaluate(() => ({
    cleanup: /** @type any */(window).__xenithCleanup,
    loaded: /** @type any */(window).__xenithLoaded,
  }));
  expect(stateAfterCleanup.cleanup).toBeUndefined();
  expect(stateAfterCleanup.loaded).toBe(false);
});

// ---------------------------------------------------------------------
// 15. No duplicate floating nav buttons after multiple SPA route changes
// (structural now — the nav item is a real MainNavBar.MenuItems child
// React reconciles on every render, not a hand-appended DOM node)
// ---------------------------------------------------------------------
test("no duplicate #hon-floating-btn-wrapper after repeated SPA navigation", async ({ page }) => {
  for (const path of ["/", "/performers", "/scenes", "/", "/performers"]) {
    await page.goto(path);
    await expect(page.locator("#hon-floating-btn-wrapper")).toHaveCount(1, { timeout: 5000 });
  }
});

// ---------------------------------------------------------------------
// 16. Changing modes preserves match pair state
// ---------------------------------------------------------------------
test("changing modes preserves match pair state for Performers and Scenes", async ({ page }) => {
  await openModal(page);

  // Wait for performer pair to fully load (choose-btn text confirms the mode)
  await expect(page.locator('[data-side="left"] .hon-choose-btn')).toHaveText("✓ Choose This Performer");
  const perfLeftName = await page.locator('[data-side="left"] .performer-name').textContent();

  // Switch to Scenes mode and wait for scene pair to load
  await page.locator(".hon-sidebar-row", { hasText: "Scenes" }).click();
  await expect(page.locator('[data-side="left"] .hon-choose-btn')).toHaveText("✓ Choose This Scene");
  const sceneLeftName = await page.locator('[data-side="left"] .card-section-title').textContent();

  // Switch back to Performers — state should be restored, no new fetch
  await page.locator(".hon-sidebar-row", { hasText: "Performers" }).click();
  await expect(page.locator('[data-side="left"] .hon-choose-btn')).toHaveText("✓ Choose This Performer");
  const perfLeftNameAfter = await page.locator('[data-side="left"] .performer-name').textContent();
  expect(perfLeftNameAfter).toBe(perfLeftName);

  // Switch back to Scenes — state should also be restored
  await page.locator(".hon-sidebar-row", { hasText: "Scenes" }).click();
  await expect(page.locator('[data-side="left"] .hon-choose-btn')).toHaveText("✓ Choose This Scene");
  const sceneLeftNameAfter = await page.locator('[data-side="left"] .card-section-title').textContent();
  expect(sceneLeftNameAfter).toBe(sceneLeftName);
});

// ---------------------------------------------------------------------
// Automated versions of qa/README.md's coverage-map checklist, for the items
// that turned out to be safely automatable against mocked/deterministic
// data (or, for the rapid-hover dedupe case, against real data discovered
// at runtime rather than hardcoded). Items not covered here and why:
//   Restoring a snapshot into a scratch library — an operational
//      precaution before testing rating changes, not a behavior to assert
//      on; there's no "scratch library" in this environment to restore
//      into, and doing this against the live instance would be the
//      opposite of the precaution it describes.
//   The tooltip portion of the rating100=0 case — scene-tooltips.js
//      resolves tier from whichever real performers happen to be on a
//      real live scene (Stash's own core scene query is unmocked, same as
//      the rest of this suite's scene tests), so forcing a specific
//      rating100=0 performer into a scene's thumbnail row isn't
//      controllable without either mocking Stash's own core query (risky
//      — see fixtures/graphql.js's header on the crash that caused) or
//      mutating a real live performer's rating. The card, badge, and
//      leaderboard portions of that checklist item are covered below.
// ---------------------------------------------------------------------

test("a rating100=0 performer's battle card renders F tier", async ({ page }) => {
  // A deterministic 2-item pool guarantees both performers appear in
  // every match (seed + only remaining candidate) — real matchmaking's
  // weighted random selection can't be forced onto a specific performer
  // from a larger pool.
  await mockGraphQL(page, {
    performers: [performer(9001, { rating100: 0 }), performer(9002, { rating100: 50 })],
  });
  await page.goto("/");
  await openModal(page);
  await expect(page.locator('[data-side="left"] .hon-choose-btn')).toHaveText("✓ Choose This Performer");

  const cardClasses = await page.locator(".hon-scene-card").evaluateAll((els) => els.map((el) => el.className));
  expect(cardClasses.some((c) => c.split(" ").includes("tier-f"))).toBe(true);
});

test("a rating100=0 performer shows F tier consistently on their badge and the leaderboard", async ({ page }) => {
  // Override only the fixture entry for a performer id that also exists
  // in the live library (id "2", used elsewhere in this suite) — Stash's
  // own (unmocked) performer-detail route needs a real performer to
  // render its shell around, but the rank/tier data badge-injector.js and
  // Leaderboard.jsx actually read comes from our mocked
  // FindPerformersRank response, not Stash's own performer query.
  const zeroId = "2";
  const performers = PERFORMERS.map((p) => (p.id === zeroId ? { ...p, rating100: 0 } : p));
  await mockGraphQL(page, { performers });

  await page.goto(`/performers/${zeroId}`);
  const badgeText = page.locator("#hon-battle-rank-badge .hon-rank-text");
  await expect(badgeText).toBeVisible({ timeout: 5000 });
  // BattleRankBadge.jsx color-codes by tier via TIER_COLORS (elo.js) rather
  // than printing the tier letter directly — F is #8a95a5 / rgb(138, 149, 165).
  await expect(badgeText).toHaveCSS("color", "rgb(138, 149, 165)");

  await page.goto("/");
  await openModal(page);
  await page.locator(".hon-sidebar-row", { hasText: "Leaderboard" }).click();
  const row = page.locator("tr", { has: page.locator(`a[href="/performers/${zeroId}"]`) });
  await expect(row).toBeVisible({ timeout: 5000 });
  await expect(row.locator("td").first()).toHaveText("F");
});

// ---------------------------------------------------------------------
// OS key-repeat must not fire more than one match
// ---------------------------------------------------------------------
test("holding ArrowLeft (simulated OS key-repeat) commits exactly one match, not one per repeat event", async ({ page }) => {
  const gql = await mockGraphQL(page);
  await page.goto("/");
  await openModal(page);
  await expect(page.locator('[data-side="left"] .hon-choose-btn')).toHaveText("✓ Choose This Performer");

  // Playwright's keyboard API dispatches real single presses, not OS-level
  // auto-repeat — simulate holding a key the same way a browser would:
  // one genuine keydown (repeat: false), then several repeat: true events
  // while it's held. HeadToHead.jsx's `if (e.repeat) return` guard
  // should swallow all of the latter.
  await page.evaluate(() => {
    const fire = (repeat) =>
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true, repeat }));
    fire(false);
    for (let i = 0; i < 8; i++) fire(true);
  });
  await page.waitForTimeout(1200); // RESULT_DELAY_MS (1000) in usePair.js, plus margin

  const updateCalls = gql.requests.filter((r) => r.operation === "UpdatePerformer").length;
  expect(updateCalls).toBe(2); // one match = one winner write + one loser write
});

// ---------------------------------------------------------------------
// Opposite-direction rapid input must not double-commit
// ---------------------------------------------------------------------
test("ArrowLeft immediately followed by ArrowRight (opposite-direction race) commits exactly one match, not two", async ({ page }) => {
  const gql = await mockGraphQL(page);
  await page.goto("/");
  await openModal(page);
  await expect(page.locator('[data-side="left"] .hon-choose-btn')).toHaveText("✓ Choose This Performer");

  // Both are genuine first presses (repeat: false), so HeadToHead.jsx's
  // e.repeat guard doesn't block either — usePair.js's submittingRef
  // is the mechanism actually under test here, closing the window before
  // either await (getSystemConfig / the mutations) gets a chance to run.
  await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(800);

  const updateCalls = gql.requests.filter((r) => r.operation === "UpdatePerformer").length;
  expect(updateCalls).toBe(2);
});

// ---------------------------------------------------------------------
// Clearing a rating mid-session (badge already shown) must not crash the
// host
// ---------------------------------------------------------------------
test("a performer whose rating gets cleared in Stash while their badge is showing doesn't crash the host", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (err) => {
    // WebKit-only false positive, confirmed by isolated reproduction: the
    // preceding test.beforeEach's page.goto("/") leaves Stash's own home-
    // page module scripts/fetches still in flight, and the very next
    // page.goto (below) interrupts them. WebKit surfaces that interruption
    // as an uncaught "Importing a module script failed" pageerror
    // (sometimes paired with a "Fetch API cannot load ... access control
    // checks" one for the aborted in-flight request); Chromium doesn't
    // surface either. Neither is from Xenith code — the badge renders
    // correctly on both navigations regardless — so they're filtered here
    // rather than causing a false failure on this test's actual assertion
    // (no crash from the rating going null).
    if (/Importing a module script failed|access control checks/.test(err.message)) return;
    errors.push(err);
  });

  const id = "2";
  const rest = PERFORMERS.filter((p) => p.id !== id);
  await mockGraphQL(page, { performers: [performer(id, { rating100: 60 }), ...rest] });
  await page.goto(`/performers/${id}`);
  await expect(page.locator("#hon-battle-rank-badge")).toBeVisible({ timeout: 5000 });

  // Simulate the rating having been cleared in Stash's own UI in between —
  // page.goto is always a hard reload in Playwright (see the routeObserver
  // test above), which resets rank-cache.js's in-memory cache, so this
  // forces a genuinely fresh fetch that now returns rating100: null for
  // the same performer instead of a number.
  await mockGraphQL(page, { performers: [performer(id, { rating100: null }), ...rest] });
  await page.goto(`/performers/${id}`);
  await expect(page.locator("#hon-battle-rank-badge")).toBeVisible({ timeout: 5000 });

  expect(errors, `expected no uncaught page errors, saw: ${errors.map((e) => e.message).join(", ")}`).toHaveLength(0);
});

// ---------------------------------------------------------------------
// Rapid hovers on a cold cache dedupe into one query
// ---------------------------------------------------------------------
test("hovering several performer thumbnails rapidly on a cold cache dedupes into one rank query, not one per hover", async ({ page, request }) => {
  // Find a real scene with several performer thumbnails at runtime rather
  // than hardcoding a scene id/performer identity tied to this specific
  // library into a checked-in test file.
  const res = await request.post("/graphql", {
    data: { query: "query { findScenes(filter: { per_page: 200 }) { scenes { id performers { id } } } }" },
  });
  const body = await res.json();
  const candidate = body?.data?.findScenes?.scenes?.find((s) => s.performers.length >= 3);
  test.skip(!candidate, "no scene with 3+ performers in this library to exercise hover dedupe against");

  let rankRequests = 0;
  await page.route("**/graphql", async (route) => {
    const query = route.request().postDataJSON()?.query || "";
    if (!/FindPerformersRank/.test(query)) {
      await route.continue();
      return;
    }
    rankRequests++;
    // Widens the overlap window so back-to-back hovers land while the
    // first request is still in flight — rank-cache.js's `pending` promise
    // (not just its 60s `cache`) is what's actually under test; without an
    // artificial delay every hover after the first would trivially hit the
    // already-resolved cache instead.
    await new Promise((r) => setTimeout(r, 300));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { findPerformers: { count: PERFORMERS.length, performers: PERFORMERS } } }),
    });
  });

  await page.goto(`/scenes/${candidate.id}`);
  const thumbs = page.locator(".performer-card-image");
  const count = Math.min(await thumbs.count(), candidate.performers.length);

  for (let i = 0; i < count; i++) {
    await thumbs.nth(i).hover();
  }
  await page.waitForTimeout(600);

  expect(rankRequests).toBe(1);
});

// ---------------------------------------------------------------------
// 18. Mobile bar/sheet focus-visible rings. The seed element
// (barButtons[0]) is reached via .focus() and deliberately NOT asserted —
// Chromium doesn't match :focus-visible on programmatic focus of a
// <button>. Every subsequent element is reached via a real
// page.keyboard.press("Tab"), which Chromium attributes to keyboard
// modality (and therefore matches :focus-visible) regardless of how the
// previously-focused element got focus — that's what each assertion below
// actually exercises.
// ---------------------------------------------------------------------
test("mobile bar controls show a focus-visible ring when tabbed to, and tabbing off the bar skips the closed sheet", async ({ page }) => {
  // Open the modal at the default desktop viewport first — #hon-floating-btn
  // is part of Stash's own host page chrome, which has its own responsive
  // behavior and may hide/relocate that button below 900px. Resize down to
  // the mobile bar's breakpoint only after the modal (ours, not the host's)
  // is already open.
  await openModal(page);
  await page.setViewportSize({ width: 393, height: 852 }); // iPhone 14 Pro, below the 900px breakpoint

  const barButtons = [
    page.locator(".hon-mobile-picker", { hasText: "Record" }),
    page.locator(".hon-mobile-picker", { hasText: "Match" }),
    page.locator(".hon-mobile-seg-btn", { hasText: "Board" }),
    page.locator(".hon-mobile-seg-btn", { hasText: "Stats" }),
    page.locator(".hon-mobile-seg-btn", { hasText: "Log" }),
    page.locator(".hon-mobile-filter-btn"),
  ];

  await barButtons[0].focus(); // seed only — not a focus-visible assertion
  for (let i = 1; i < barButtons.length; i++) {
    await page.keyboard.press("Tab");
    await expect(barButtons[i]).toBeFocused();
    const boxShadow = await barButtons[i].evaluate((el) => getComputedStyle(el).boxShadow);
    expect(boxShadow).not.toBe("none");
  }

  // One more Tab past the last bar button (Filter) should leave the bar
  // entirely, not land inside the still-mounted, off-screen gender sheet —
  // the adjacent bug fixed alongside the focus-visible rings above.
  await page.keyboard.press("Tab");
  const inClosedSheet = await page.evaluate(() => document.activeElement?.closest(".hon-sheet") !== null);
  expect(inClosedSheet).toBe(false);

  // Opening a sheet and tabbing to its first row shows the same ring.
  await barButtons[0].click(); // Record picker — opens its sheet
  const sheet = page.locator(".hon-sheet.open");
  await expect(sheet).toBeVisible();
  const firstRow = sheet.locator(".hon-sheet-row").first();
  await firstRow.focus(); // seed only, as above
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab"); // real Tab back onto firstRow to trigger :focus-visible
  await expect(firstRow).toBeFocused();
  const rowBoxShadow = await firstRow.evaluate((el) => getComputedStyle(el).boxShadow);
  expect(rowBoxShadow).not.toBe("none");
});

// ---------------------------------------------------------------------
// 19. Desktop sidebar/tier/choose/close focus-visible rings, the
// desktop-panel counterpart to the mobile-bar coverage above. Default
// Desktop Chrome viewport (1280x720) stays above the 900px breakpoint, so
// .hon-sidebar-desktop (not the mobile bar) is what's on screen here.
//
// Two of these targets — the sidebar rows/subrows and .hon-choose-btn —
// were plain <div onClick>s with no tabIndex/role until they were converted
// to real <button>s alongside adding the rings; this test also covers that
// conversion. Both Champion and Gauntlet are enabled at the default
// battleType of Performers, so there's no disabled row to
// skip in this context.
//
// `.toContain("inset")` rather than `.not.toBe("none")` (unlike section 18
// above): .hon-tier-btn.active already carries a non-"none" box-shadow of
// its own at rest, so a `.not.toBe("none")` assertion would pass on it
// even with no ring composed in.
// ---------------------------------------------------------------------
test("desktop sidebar rows, tier buttons, choose buttons, and modal close show a focus-visible ring when tabbed to", async ({ page, browserName }) => {
  await openModal(page);

  async function assertRing(locator) {
    await page.keyboard.press("Tab");
    await expect(locator).toBeFocused();
    const boxShadow = await locator.evaluate((el) => getComputedStyle(el).boxShadow);
    expect(boxShadow).toContain("inset");
  }

  const closeBtn = page.locator(".hon-modal-close");
  const recordRows = page.locator(".hon-sidebar-row", { hasText: /^🎭 Performers$|^🎬 Scenes$/ });
  const h2hRow = page.locator(".hon-sidebar-row", { hasText: "Head to Head" });
  const championRow = page.locator(".hon-sidebar-row", { hasText: "Champion" });
  const gauntletRow = page.locator(".hon-sidebar-row", { hasText: "Gauntlet" });
  const leaderboardRow = page.locator(".hon-sidebar-row", { hasText: "Leaderboard" });
  const statsRow = page.locator(".hon-sidebar-row", { hasText: "Match Stats" });
  const logRow = page.locator(".hon-sidebar-row", { hasText: "Match Log" });
  const genderRow = page.locator(".hon-sidebar-row.hon-sidebar-expandable");

  // Seed on the close button — the first focusable element in DOM order —
  // via .focus(), never asserted (Chromium doesn't match :focus-visible on
  // programmatic focus of a <button>, same caveat as section 18 above).
  await closeBtn.focus();

  // Record Type (Performers active at rest, Scenes not) → Mode (H2H active,
  // Champion and Gauntlet both enabled under Performers) → Stats → Gender
  // Filter. No disabled row to skip in this battleType.
  await assertRing(recordRows.filter({ hasText: "Performers" }));
  await assertRing(recordRows.filter({ hasText: "Scenes" }));
  await assertRing(h2hRow);
  await assertRing(championRow);
  await assertRing(gauntletRow);
  await assertRing(leaderboardRow);
  await assertRing(statsRow);
  await assertRing(logRow);
  await assertRing(genderRow);

  // No disabled rows — Champion and Gauntlet both play both battle types,
  // so neither mode row is ever disabled (Sidebar.jsx's MATCH_MODES).
  await expect(page.locator(".hon-sidebar-row.disabled")).toHaveCount(0);

  // Expand the gender filter and tab into its subrows.
  await genderRow.click();
  const firstSubrow = page.locator(".hon-sidebar-subrow").first();
  await assertRing(firstSubrow);

  // A choose button (H2H card) also gets the ring. Re-seeded via .focus()
  // rather than continuing the running Tab sequence — the H2H card's DOM
  // position relative to the sidebar isn't asserted, only that Tab lands
  // back on the choose button after Shift+Tab off it.
  const chooseBtn = page.locator('[data-side="left"] .hon-choose-btn');
  await chooseBtn.focus(); // seed only, not asserted
  await page.keyboard.press("Shift+Tab");
  await assertRing(chooseBtn);

  // Switch to the Leaderboard to reach .hon-tier-btn, including the
  // .active + :focus-visible composition on the default "ALL" filter.
  await leaderboardRow.click();
  const allTierBtn = page.locator(".hon-tier-btn", { hasText: "ALL" });
  await expect(allTierBtn).toHaveClass(/active/);
  await allTierBtn.focus(); // seed only, not asserted
  await page.keyboard.press("Shift+Tab");
  await assertRing(allTierBtn);

  // Clicking a different button (mouse, not Tab) shouldn't show a ring on it
  // — confirms :focus-visible, not :focus. Deliberately a different button
  // than allTierBtn above: a mouse click on an already-focused element
  // doesn't re-run the browser's focus-visible heuristic, so clicking the
  // element already focused via Tab would trivially keep its ring and not
  // actually exercise the click-vs-keyboard distinction.
  const sTierBtn = page.locator(".hon-tier-btn", { hasText: "S" });
  await sTierBtn.click();
  // WebKit doesn't focus a <button> on a mouse click by default the way
  // Chromium does (the same underlying engine difference behind the
  // Chromium-only mobile-sheet-scroll bug — see xenith.css's comment above
  // .hon-sheet). So on WebKit there's no focus to assert here at all; what
  // still holds on both engines is the actual invariant this block tests —
  // a mouse click never produces a visible ring — so that assertion runs
  // unconditionally below.
  if (browserName !== "webkit") {
    await expect(sTierBtn).toBeFocused();
  }
  const clickedBoxShadow = await sTierBtn.evaluate((el) => getComputedStyle(el).boxShadow);
  expect(clickedBoxShadow).not.toContain("inset");
});

// ---------------------------------------------------------------------
// 20. Mobile Match picker is a nav target first, a mode picker second.
// From Leaderboard/Stats the first tap returns to the match
// without opening the sheet; a second tap (now on the match) opens it.
// ---------------------------------------------------------------------
test("mobile Match picker returns to the match from Leaderboard/Stats before it opens the mode sheet", async ({ page }) => {
  await openModal(page); // desktop viewport first, see section 18's rationale
  await page.setViewportSize({ width: 393, height: 852 }); // iPhone 14 Pro, below the 900px breakpoint

  const matchPicker = page.locator(".hon-mobile-picker", { hasText: "Match" });
  const matchCaret = matchPicker.locator(".hon-mobile-picker-caret");
  const sheet = page.locator(".hon-sheet.open");

  // Board -> Match: first tap should navigate, not open the sheet.
  await page.locator(".hon-mobile-seg-btn", { hasText: "Board" }).click();
  await expect(page.locator(".hon-leaderboard")).toBeVisible();
  await expect(matchCaret).toHaveCount(0);

  await matchPicker.click();
  await expect(page.locator(".hon-h2h")).toBeVisible();
  await expect(sheet).toHaveCount(0);
  await expect(matchCaret).toHaveCount(1);

  // Already on the match: tapping Match now opens the mode sheet.
  await matchPicker.click();
  await expect(sheet).toBeVisible();
  const h2hRow = sheet.locator(".hon-sheet-row", { hasText: "Head to Head" });
  await expect(h2hRow).toBeVisible();
  // Single-select rows close the sheet on click (OptionSheet.jsx), same as
  // picking any option — re-selecting the already-active row is enough.
  await h2hRow.click();
  await expect(sheet).toHaveCount(0);

  // Stats -> Match: same nav-first behavior on the other non-match tab.
  await page.locator(".hon-mobile-seg-btn", { hasText: "Stats" }).click();
  await matchPicker.click();
  await expect(page.locator(".hon-h2h")).toBeVisible();
  await expect(sheet).toHaveCount(0);
});

// ---------------------------------------------------------------------
// 21. Scene battles now write xenith_record too — previously only
// rating100/xenith_stats were written for scenes, and the record mutation
// field was gated to performers only.
// ---------------------------------------------------------------------
test("winning a scene match writes an xenith_record entry with an id:title opponent", async ({ page }) => {
  const gql = await mockGraphQL(page);
  await openModal(page);
  await page.locator(".hon-sidebar-row", { hasText: "Scenes" }).click();
  await expect(page.locator(".hon-vs-container").first()).toBeVisible();

  await page.locator('[data-side="left"] .hon-choose-btn').first().click();
  await expect.poll(() => gql.requests.some((r) => r.operation === "UpdateScene")).toBeTruthy();

  const updateCalls = gql.requests.filter((r) => r.operation === "UpdateScene");
  expect(updateCalls.length).toBe(2);

  const record = JSON.parse(updateCalls[0].variables.custom_fields.partial.xenith_record);
  expect(record.length).toBe(1);
  expect(record[0].opponent).toMatch(/^\d+:.+$/);
  expect(typeof record[0].ratingAfter).toBe("number");
});

// ---------------------------------------------------------------------
// 22. Selecting a mobile bottom-sheet option doesn't scroll the modal.
// Chromium-only bug: focusing a .hon-sheet-row used to move
// .hon-modal-content's own scrollTop because .hon-sheet's position: fixed
// resolved against .hon-modal-content (an identity transform held at rest
// by the entrance animation's `both` fill mode gave it a containing
// block) rather than the viewport, and .hon-modal-content's overflow:
// hidden made it a scrollable target for that focus-scroll to land on.
// WebKit doesn't focus buttons on tap, so this test only reproduces the
// regression on Chromium — it still runs on both engines as a guard
// against the CSS returning.
// ---------------------------------------------------------------------
test("selecting Record Type / Gender Filter sheet options doesn't scroll .hon-modal-content off-screen", async ({
  page,
}) => {
  await openModal(page);
  await page.setViewportSize({ width: 393, height: 852 }); // iPhone 14 Pro, below the 900px breakpoint

  const modalContent = page.locator(".hon-modal-content");
  const modalClose = page.locator(".hon-modal-close");

  const expectModalNotScrolled = async () => {
    await expect(modalContent).toHaveJSProperty("scrollTop", 0);
    const closeTop = await modalClose.evaluate((el) => el.getBoundingClientRect().top);
    expect(closeTop).toBeGreaterThanOrEqual(0);
  };

  await expectModalNotScrolled();

  // Record Type — single-select, closes the sheet on pick.
  await page.locator(".hon-mobile-picker", { hasText: "Record" }).click();
  await page.locator(".hon-sheet-row", { hasText: "Scenes" }).click();
  await expectModalNotScrolled();

  await page.locator(".hon-mobile-picker", { hasText: "Record" }).click();
  await page.locator(".hon-sheet-row", { hasText: "Performers" }).click();
  await expectModalNotScrolled();

  // Gender Filter — multi-select, sheet stays open across the pick, so the
  // focused row stays mounted inside .hon-modal-content longer.
  await page.locator(".hon-mobile-filter-btn").click();
  await page.locator(".hon-sheet-row", { hasText: "Female" }).first().click();
  await expectModalNotScrolled();
});
