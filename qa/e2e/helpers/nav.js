// @ts-check
import { expect } from "@playwright/test";

/**
 * Shared navigation helpers for capture-style specs (promo.spec.js today;
 * device-review.spec.js, swipe.spec.js, and leaderboard-perf.spec.js each
 * still carry their own copies rather than being migrated onto this module
 * in the same change that introduced it).
 */

/**
 * Opens the Xenith modal, racing Stash's collapsed-navbar hamburger toggler
 * on narrow viewports (below its xl breakpoint, #hon-floating-btn lives
 * inside the collapsed .navbar-collapse and isn't clickable until the
 * toggler opens it). Desktop projects never see the toggler at all.
 * @param {import('@playwright/test').Page} page
 */
export async function openModal(page) {
  const floatingBtn = page.locator("#hon-floating-btn");
  const toggler = page.locator("button.navbar-toggler");
  await toggler.waitFor({ state: "attached", timeout: 5000 }).catch(() => {});

  for (let i = 0; i < 5; i++) {
    if (await floatingBtn.isVisible().catch(() => false)) break;
    if (await toggler.isVisible().catch(() => false)) {
      await toggler.click().catch(() => {});
    }
    await page.waitForTimeout(200);
  }

  await floatingBtn.click();
  await expect(page.locator("#hon-modal")).toBeVisible();
}

/**
 * Clicks a sidebar nav row (desktop) or the equivalent mobile control —
 * either a direct toggle button or a picker + bottom-sheet row.
 * @param {import('@playwright/test').Page} page
 * @param {string} label desktop .xen-sidebar-row text
 * @param {string} mobileLabel mobile control text
 */
export async function selectNav(page, label, mobileLabel) {
  const mobileBar = page.locator(".hon-mobile-bar");
  if (await mobileBar.isVisible().catch(() => false)) {
    const directBtn = page.locator(".hon-mobile-seg-btn, .hon-mobile-filter-btn", { hasText: mobileLabel });
    if (await directBtn.count()) {
      await directBtn.click();
      return;
    }
    await page.locator(".hon-mobile-picker", { hasText: "Record" }).click();
    await page.locator(".hon-sheet-row", { hasText: mobileLabel }).click();
  } else {
    await page.locator(".xen-sidebar-row", { hasText: label }).click();
  }
}

/** @param {import('@playwright/test').Page} page @param {"performers"|"scenes"} mode */
export async function setBattleType(page, mode) {
  if (mode === "performers") {
    await selectNav(page, "🎭 Performers", "Performers");
  } else {
    await selectNav(page, "🎬 Scenes", "Scenes");
  }
}

// Sidebar.jsx's MATCH_MODES — "short" label is what the mobile "Match"
// picker sheet renders per row.
const MATCH_MODE_SHORT = { h2h: "H2H", champion: "Champion", gauntlet: "Gauntlet" };
const MATCH_MODE_LABEL = { h2h: "Head to Head", champion: "Champion", gauntlet: "Gauntlet" };

/**
 * Switches match mode (H2H / Champion / Gauntlet) — desktop sidebar row or
 * mobile "Match" picker + sheet, mirroring selectNav's two-branch shape.
 * @param {import('@playwright/test').Page} page
 * @param {"h2h"|"champion"|"gauntlet"} mode
 */
export async function selectMatchMode(page, mode) {
  const mobileBar = page.locator(".hon-mobile-bar");
  if (await mobileBar.isVisible().catch(() => false)) {
    await page.locator(".hon-mobile-picker", { hasText: "Match" }).click();
    await page.locator(".hon-sheet-row", { hasText: MATCH_MODE_SHORT[mode] }).click();
  } else {
    await page.locator(".xen-sidebar-row", { hasText: MATCH_MODE_LABEL[mode] }).click();
  }
}

/**
 * Clicks the first .hon-choose-btn n times, waiting for each vote's
 * delta-pop animation to settle before the next click — used to build up
 * Champion defenses, Gauntlet run progress, and Match Log entries for a
 * capture that needs mid-run state rather than the idle first pairing.
 * @param {import('@playwright/test').Page} page
 * @param {number} n
 */
export async function playMatches(page, n) {
  for (let i = 0; i < n; i++) {
    await page.locator(".hon-choose-btn").first().click();
    await page.waitForTimeout(350);
  }
}
