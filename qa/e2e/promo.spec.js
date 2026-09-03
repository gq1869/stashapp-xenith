// @ts-check
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { test, expect } from "@playwright/test";
import { mockPromo, withRealDetailId, withRealGridIds, withRealSceneGridIds } from "./fixtures/promo.js";
import { openModal, selectNav, setBattleType, selectMatchMode, playMatches } from "./helpers/nav.js";
import { scrubNativePage } from "./helpers/scrub.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Capture-only spec producing a curated promo screenshot set (README /
 * Discourse post) — obfuscated data throughout, generated placeholder art
 * instead of real library images, invented performer/scene names. NOT part
 * of `npm run test:e2e` — the promo-desktop/promo-mobile projects only
 * exist in playwright.config.js when PROMO is set, and testIgnore keeps
 * this file away from the default chromium/webkit projects even then.
 *
 * Run explicitly, e.g.:
 *   PROMO=1 STASH_URL=http://localhost:9999 npm run test:e2e:promo
 *
 * Unlike device-review.spec.js, this spec asserts nothing about layout —
 * it exists to produce good-looking frames, not to catch regressions. No
 * overflow checks, no computed-style dumps, no CDP artifacts.
 */

const OUT_DIR = process.env.PROMO_OUT_DIR || path.join(__dirname, ".artifacts", "promo");

async function shot(page, project, name) {
  const dir = path.join(OUT_DIR, project);
  fs.mkdirSync(dir, { recursive: true });
  // Same rationale as device-review.spec.js's capture wait — sheets/
  // transitions settle on a 220ms CSS transform, and a delta-pop animation
  // runs ~300ms after a vote.
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(dir, `${name}__${project}.png`) });
}

test.describe("promo captures", () => {
  test("h2h performers + scenes", async ({ page }, testInfo) => {
    const project = testInfo.project.name;
    await mockPromo(page);
    await page.goto("/");
    await openModal(page);
    await setBattleType(page, "performers");
    // .hon-h2h is the outer wrapper (present in both mobile and desktop
    // layouts); .hon-vs-container only renders desktop-side, nested inside
    // it, so asserting on both via an OR double-matches on desktop.
    await expect(page.locator(".hon-h2h")).toBeVisible();
    await shot(page, project, "h2h-performers");

    await setBattleType(page, "scenes");
    // .hon-h2h is the outer wrapper (present in both mobile and desktop
    // layouts); .hon-vs-container only renders desktop-side, nested inside
    // it, so asserting on both via an OR double-matches on desktop.
    await expect(page.locator(".hon-h2h")).toBeVisible();
    await shot(page, project, "h2h-scenes");
  });

  test("leaderboard", async ({ page }, testInfo) => {
    const project = testInfo.project.name;
    await mockPromo(page);
    await page.goto("/");
    await openModal(page);
    await selectNav(page, "📊 Leaderboard", "Board");
    await expect(page.locator(".hon-leaderboard")).toBeVisible();
    // Expand the tier distribution accordion so the promo shot shows the
    // populated tier bars, not just the collapsed title row. Above 900px,
    // xenith.css forces the toggle to pointer-events:none and the content
    // to display:block regardless of Leaderboard.jsx's open state — it's
    // permanently expanded and genuinely unclickable there, so check
    // computed pointer-events rather than an "expanded" class that only
    // ever gets set by the (never-fired, on desktop) click handler.
    const toggle = page.locator(".hon-distribution-toggle");
    const clickable = await toggle.evaluate((el) => getComputedStyle(el).pointerEvents !== "none");
    if (clickable) {
      await toggle.click();
    }
    await shot(page, project, "leaderboard");
  });

  test("match stats", async ({ page }, testInfo) => {
    const project = testInfo.project.name;
    await mockPromo(page);
    await page.goto("/");
    await openModal(page);
    await selectNav(page, "📈 Match Stats", "Stats");
    await expect(page.locator(".xen-main-plugin-content")).toBeVisible();
    await shot(page, project, "match-stats");
  });

  test("gauntlet: preview + active run", async ({ page }, testInfo) => {
    const project = testInfo.project.name;
    await mockPromo(page);
    await page.goto("/");
    await openModal(page);
    await selectMatchMode(page, "gauntlet");
    // Challenger preview auto-loads on mount (Gauntlet.jsx's own effect).
    await expect(page.locator(".hon-choose-btn, button", { hasText: "Start Run" })).toBeVisible({ timeout: 10_000 });
    await shot(page, project, "gauntlet-preview");

    await page.locator("button", { hasText: "Start Run" }).click();
    // .hon-h2h is the outer wrapper (present in both mobile and desktop
    // layouts); .hon-vs-container only renders desktop-side, nested inside
    // it, so asserting on both via an OR double-matches on desktop.
    await expect(page.locator(".hon-h2h")).toBeVisible();
    await playMatches(page, 4);
    await shot(page, project, "gauntlet-run");
  });

  test("champion: mid-reign banner", async ({ page }, testInfo) => {
    const project = testInfo.project.name;
    await mockPromo(page);
    await page.goto("/");
    await openModal(page);
    await selectMatchMode(page, "champion");
    // .hon-h2h is the outer wrapper (present in both mobile and desktop
    // layouts); .hon-vs-container only renders desktop-side, nested inside
    // it, so asserting on both via an OR double-matches on desktop.
    await expect(page.locator(".hon-h2h")).toBeVisible();
    await playMatches(page, 4);
    await shot(page, project, "champion");
  });

  test("rank badge: detail page history drawer", async ({ page, request }, testInfo) => {
    test.setTimeout(45_000); // 20s badge wait alone exceeds the file's 30s default
    const project = testInfo.project.name;
    // Stash core's own performer-detail query isn't mocked (see
    // fixtures/graphql.js's header comment) and 404s on a synthetic id, so
    // this needs a real id from the live library — fetched directly,
    // ahead of the mock route below. withRealDetailId keeps PROMO_PERFORMERS[0]'s
    // invented name/rating/populated xenith_record for that id; scrubNativePage
    // below still replaces whatever real name/image Stash core itself renders.
    const idRes = await request.post("/graphql", {
      data: { query: "query { findPerformers(filter: { per_page: 1 }) { performers { id } } }" },
    });
    const idJson = await idRes.json();
    const realId = idJson?.data?.findPerformers?.performers?.[0]?.id;
    test.skip(!realId, "no real performer available in this Stash instance to anchor the detail-page capture");

    await mockPromo(page, { performers: withRealDetailId(realId) });
    await page.goto(`/performers/${realId}`);
    // injectOnPerformerDetail (badge-injector.js) fires off a
    // MutationObserver + rAF debounce, layered on top of Stash core's own
    // (real, unmocked) detail-page query resolving — generous timeout, not
    // the 5-10s used elsewhere, since this is the one capture racing a real
    // network round trip rather than only mocked responses.
    await expect(page.locator(".hon-rank-badge-detail")).toBeVisible({ timeout: 20_000 });
    const toggle = page.locator(".hon-history-toggle");
    if (await toggle.isVisible().catch(() => false)) {
      await toggle.click();
      await expect(page.locator(".hon-history-drawer")).toBeVisible();
    }
    await scrubNativePage(page);
    await shot(page, project, "rank-badge");
  });

  // discoverGridIds: two-pass id discovery shared by both grid captures
  // below — first, unmocked, to see which real ids the grid's actual
  // default sort/filter puts on screen (a guessed sort param previously
  // produced the wrong page), so a second pass can map those exact ids
  // onto the promo pool and make Xenith's .hon-compact-badge actually
  // overlay every card instead of none.
  async function discoverGridIds(page, url, hrefPattern, idRe) {
    await page.goto(url);
    // Cards render async (GraphQL fetch); scanning immediately after goto
    // catches the grid still empty or partially populated, capturing far
    // fewer real ids than the ones actually on screen a moment later.
    await page.locator(hrefPattern).first().waitFor({ state: "visible", timeout: 10_000 });
    await page.waitForTimeout(500);
    const links = await page.locator(hrefPattern).all();
    const idsInOrder = /** @type {string[]} */ ([]);
    for (const link of links) {
      const href = await link.getAttribute("href").catch(() => null);
      const match = href && href.match(idRe);
      if (match && !idsInOrder.includes(match[1])) idsInOrder.push(match[1]);
    }
    return idsInOrder;
  }

  test("rank badges: performer grid", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "promo-desktop", "desktop-only capture");
    test.setTimeout(45_000);
    const project = testInfo.project.name;
    const idsInOrder = await discoverGridIds(page, "/performers", 'a[href*="/performers/"]', /\/performers\/(\d+)/);
    await mockPromo(page, { performers: withRealGridIds(idsInOrder) });
    await page.goto("/performers");
    await expect(page.locator(".hon-compact-badge").first()).toBeVisible({ timeout: 20_000 });
    await scrubNativePage(page);
    await shot(page, project, "rank-badges-grid");
  });

  test("rank badges: scene grid", async ({ page }, testInfo) => {
    // 16:9 scene cards fit the mobile viewport where a full 2:3 performer
    // card doesn't (same reasoning as the h2h/swipe captures above) — the
    // desktop project already covers performers via the test above.
    test.skip(testInfo.project.name !== "promo-mobile", "mobile-only capture");
    test.setTimeout(45_000);
    const project = testInfo.project.name;
    const idsInOrder = await discoverGridIds(page, "/scenes", 'a[href*="/scenes/"]', /\/scenes\/(\d+)/);
    await mockPromo(page, { scenes: withRealSceneGridIds(idsInOrder) });
    await page.goto("/scenes");
    await expect(page.locator(".hon-compact-badge").first()).toBeVisible({ timeout: 20_000 });
    await scrubNativePage(page);
    await shot(page, project, "rank-badges-grid");
  });

  test("mobile: h2h + bottom bar", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "promo-mobile", "mobile-only capture");
    const project = testInfo.project.name;
    await mockPromo(page);
    await page.goto("/");
    await openModal(page);
    // 16:9 scene cards fit the mobile viewport whole; a 2:3 performer
    // portrait doesn't — the card gets cut off before the choose button.
    await setBattleType(page, "scenes");
    await expect(page.locator(".hon-mobile-bar")).toBeVisible();
    await shot(page, project, "mobile-h2h");
  });

  test("mobile: mid-swipe", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "promo-mobile", "mobile-only capture");
    const project = testInfo.project.name;
    await mockPromo(page);
    await page.goto("/");
    await openModal(page);
    // Same reasoning as "mobile: h2h + bottom bar" above — scenes' 16:9
    // cards fit the viewport where performers' 2:3 portraits don't.
    await setBattleType(page, "scenes");
    // SwipeStack reads e.touches[0] off real TouchEvents — Playwright's
    // mouse API synthesizes pointer/mouse events the component ignores, so
    // driving a drag needs CDP Input.dispatchTouchEvent (same technique as
    // device-review.spec.js's own mid-drag capture). CDP is Chromium-only,
    // which promo-mobile already is (browserName forced in
    // playwright.config.js).
    const card = page.locator(".hon-swipe-card-wrapper").first();
    await card.waitFor({ state: "visible" });
    const box = await card.boundingBox();
    if (box) {
      const client = await page.context().newCDPSession(page);
      const startX = box.x + box.width / 2;
      const startY = box.y + box.height / 2;
      const touchPoint = (x, y) => [{ x, y, id: 1 }];
      await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: touchPoint(startX, startY) });
      await client.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: touchPoint(startX + 120, startY),
      });
      await shot(page, project, "mobile-swipe");
      await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await client.detach();
    }
  });

  test("mobile: leaderboard", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "promo-mobile", "mobile-only capture");
    const project = testInfo.project.name;
    await mockPromo(page);
    await page.goto("/");
    await openModal(page);
    await selectNav(page, "📊 Leaderboard", "Board");
    await expect(page.locator(".hon-leaderboard")).toBeVisible();
    await shot(page, project, "mobile-leaderboard");
  });

  test("mobile: match log", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "promo-mobile", "mobile-only capture");
    const project = testInfo.project.name;
    await mockPromo(page);
    await page.goto("/");
    await openModal(page);
    await playMatches(page, 6);
    await selectNav(page, "📜 Match Log", "Log");
    await expect(page.locator(".xen-main-plugin-content")).toBeVisible();
    await shot(page, project, "mobile-match-log");
  });
});
