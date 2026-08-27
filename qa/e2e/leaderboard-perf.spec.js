// @ts-check
import { test } from "@playwright/test";
import { mockGraphQL, performer, scene } from "./fixtures/graphql.js";

/**
 * Leaderboard rendering perf harness. Not part of
 * `npm run test:e2e` — only exists under the `webkit-mobile`/`desktop-*`
 * projects, themselves only added to playwright.config.js when PERF=1 is
 * set (same gating pattern as DEVICE_REVIEW for device-review.spec.js).
 *
 * Run explicitly, e.g.:
 *   PERF=1 STASH_URL=http://localhost:9999 npx playwright test \
 *     -c e2e/playwright.config.js e2e/leaderboard-perf.spec.js \
 *     --project=webkit-mobile --project=desktop-chromium --project=desktop-webkit
 *
 * Why a real WebKit project matters: device-review.spec.js's iphone14pro
 * project forces browserName: "chromium" (only Chromium is installed by
 * default), which emulates viewport/DPR/touch but not real WebKit
 * rendering. That's precisely the gap that let an earlier sticky-column
 * regression through — Chromium measured no cost at any row count, real
 * Safari mobile did. webkit-mobile (playwright.config.js) uses actual
 * WebKit, no override.
 *
 * Two pool sizes, both mocked for determinism rather than depending on
 * whatever a live library happens to contain:
 *   - PERFORMER_COUNT (2,473) mirrors the library size the original
 *     regression was measured against.
 *   - SCENE_COUNT (16,000) is the pagination fix's driving case — the pool size large
 *     enough that even the mobile-WebKit numbers above don't tell you
 *     whether the fix holds, since nothing was ever measured against a
 *     pool this size or on desktop.
 *
 * This spec measures paged rendering, not the pre-pagination full
 * table — Leaderboard.jsx now renders a bounded page window, so "full row
 * count" here means "full pool size behind the pager," not "every row in
 * one DOM."
 */

const PERFORMER_COUNT = 2473;
const PERFORMERS = Array.from({ length: PERFORMER_COUNT }, (_, i) =>
  performer(i + 1, { rating100: i % 101 })
);

const SCENE_COUNT = 16000;
const SCENES = Array.from({ length: SCENE_COUNT }, (_, i) =>
  scene(i + 1, { rating100: i % 101 })
);

async function openModal(page) {
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
  await page.locator("#hon-modal").waitFor({ state: "visible" });
}

// On mobile-portrait, Sidebar.jsx shows a persistent .hon-mobile-bar
// instead of the desktop .hon-sidebar-row list (nothing to expand first,
// unlike the old "☰ Menu" accordion this replaced) — same helper as
// device-review.spec.js's selectNav. Desktop/landscape rows are always
// visible, so the .hon-sidebar-row branch is a no-op there.
async function selectNav(page, label, mobileLabel) {
  const mobileBar = page.locator(".hon-mobile-bar");
  if (await mobileBar.isVisible().catch(() => false)) {
    await page.locator(".hon-mobile-seg-btn, .hon-mobile-filter-btn", { hasText: mobileLabel }).click();
  } else {
    await page.locator(".hon-sidebar-row", { hasText: label }).click();
  }
}

// Switching Record Type to Scenes — same pattern as xenith.spec.js's own
// "switching Record Type to Scenes" coverage: desktop clicks the
// .hon-sidebar-row directly, mobile opens the Record Type sheet first and
// picks the .hon-sheet-row option inside it.
async function switchToScenes(page) {
  const mobileBar = page.locator(".hon-mobile-bar");
  if (await mobileBar.isVisible().catch(() => false)) {
    await page.locator(".hon-mobile-picker", { hasText: "Record" }).click();
    await page.locator(".hon-sheet-row", { hasText: "Scenes" }).click();
  } else {
    await page.locator(".hon-sidebar-row", { hasText: "Scenes" }).click();
  }
}

async function scrollFrameCost(page) {
  // Scripted scroll of the table's own scrollport (bounded on mobile),
  // sampling frame-to-frame deltas via requestAnimationFrame rather than
  // Playwright round-trips, which would dwarf the real cost being measured.
  const frameDeltas = await page.evaluate(() => {
    return new Promise((resolve) => {
      const el = document.querySelector(".hon-stats-table-wrapper");
      if (!el) return resolve([]);
      const deltas = [];
      let last = performance.now();
      let frames = 0;
      const maxFrames = 60;

      function tick() {
        const now = performance.now();
        deltas.push(now - last);
        last = now;
        frames++;
        el.scrollTop += 40;
        el.scrollLeft = (el.scrollLeft + 20) % Math.max(1, el.scrollWidth - el.clientWidth);
        if (frames < maxFrames) {
          requestAnimationFrame(tick);
        } else {
          resolve(deltas);
        }
      }
      requestAnimationFrame(tick);
    });
  });
  return Math.max(...frameDeltas.slice(1)); // drop the first — includes rAF warmup
}

function runLeaderboardPerf(label, pool, rowCount) {
  test(`leaderboard render/scroll/page-change cost — ${label} (${rowCount} rows)`, async ({ page }) => {
    await mockGraphQL(page, pool);
    await page.goto("/");
    await openModal(page);

    if (pool.scenes) await switchToScenes(page);

    const start = Date.now();
    await selectNav(page, "Leaderboard", "Board");
    await page.locator(".hon-stats-table-wrapper").waitFor({ state: "visible" });
    // Last row of the *first page*, not the pool — pagination bounds rendering to
    // a page window, so the last DOM row is whatever the resolved page size
    // is, not rowCount - 1.
    const rows = page.locator(".hon-stats-table tbody tr");
    await rows.last().waitFor({ state: "attached" });
    const renderMs = Date.now() - start;
    const renderedRowCount = await rows.count();

    const maxFrameMs = await scrollFrameCost(page);

    // Page-change cost: the new interaction pagination introduces. A full
    // page-worth teardown+rebuild on every Next click — the number most
    // likely to disappoint at a large page size, and the one worth
    // watching if a page-size constant needs to come down.
    const nextBtn = page.locator(".hon-leaderboard-pager button", { hasText: "Next" });
    let pageChangeMs = null;
    if (await nextBtn.isVisible().catch(() => false)) {
      const firstRowText = await rows.first().innerText();
      const pageStart = Date.now();
      await nextBtn.click();
      await page.locator(".hon-stats-table tbody tr").first().locator("visible=true")
        .waitFor({ state: "attached" });
      // Wait for the first row's text to actually change, not just for
      // *a* row to be attached (React reuses DOM nodes across the slice).
      await page.waitForFunction(
        (prevText) => {
          const first = document.querySelector(".hon-stats-table tbody tr");
          return first && first.innerText !== prevText;
        },
        firstRowText,
        { timeout: 5000 }
      );
      pageChangeMs = Date.now() - pageStart;
    }

    console.log(
      `\n=== leaderboard perf: ${label} (${rowCount} rows, ${test.info().project.name}) ===\n` +
      `render: ${renderMs}ms (${renderedRowCount} rows in DOM)\n` +
      `max scroll frame: ${maxFrameMs.toFixed(1)}ms\n` +
      `page-change: ${pageChangeMs === null ? "n/a (single page)" : `${pageChangeMs}ms`}\n`
    );
  });
}

runLeaderboardPerf("performers", { performers: PERFORMERS }, PERFORMER_COUNT);
runLeaderboardPerf("scenes", { scenes: SCENES, performers: [] }, SCENE_COUNT);

test("leaderboard fetch-to-first-paint cost at 16k scenes", async ({ page }) => {
  // rank-cache.js's map/compute/sort (composite, tier, stats over 16,000
  // rows) happens between the GraphQL response landing and the first row
  // painting, so it's already inside the "render" measurement above —
  // there's no separate hook to isolate it further (dist/xenith.js is an
  // unexported IIFE bundle, not an ESM module, so getRankedItems can't be
  // called directly from the page). This measures the network-response ->
  // first-paint gap specifically, as the closest proxy: if that gap is
  // large relative to total render time, compute (not DOM) is the
  // remaining ceiling and paging alone wouldn't fix it.
  await mockGraphQL(page, { scenes: SCENES, performers: [] });
  await page.goto("/");
  await openModal(page);
  await switchToScenes(page);

  const responsePromise = page.waitForResponse((res) => res.url().includes("/graphql"));
  const navStart = Date.now();
  await selectNav(page, "Leaderboard", "Board");
  await responsePromise;
  const responseMs = Date.now() - navStart;
  await page.locator(".hon-stats-table tbody tr").first().waitFor({ state: "attached" });
  const firstPaintMs = Date.now() - navStart;

  console.log(
    `\n=== leaderboard fetch-to-paint: scenes (${SCENE_COUNT} rows, ${test.info().project.name}) ===\n` +
    `graphql response: ${responseMs}ms\n` +
    `first row painted: ${firstPaintMs}ms\n` +
    `compute+render gap: ${firstPaintMs - responseMs}ms\n`
  );
});
