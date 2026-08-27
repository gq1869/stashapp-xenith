// @ts-check
import { test, expect } from "@playwright/test";
import { mockGraphQL } from "./fixtures/graphql.js";

/**
 * Regression coverage for SwipeStack's peek-toggle cycle jankiness.
 * Portrait-mobile only (mobile-portrait project, playwright.config.js) —
 * SwipeStack doesn't render above the 900px/portrait breakpoint.
 *
 * Before this suite existed, the only touch coverage was
 * device-review.spec.js's screenshot capture, which is
 * DEVICE_REVIEW-gated and never runs as part of `npm run test:e2e`. These
 * tests read inline style off `.hon-swipe-card-wrapper` rather than taking
 * screenshots, so they assert the actual defect (transform/transition
 * values), not just "no visible overflow."
 *
 * Touch is driven via CDP Input.dispatchTouchEvent, mirroring
 * device-review.spec.js's mid-drag capture — SwipeStack reads
 * e.touches[0] off real TouchEvents, and Playwright's page.touchscreen
 * only exposes a single tap(), not a multi-step drag.
 */

async function openModal(page) {
  // Mirrors device-review.spec.js's openModal: on a portrait viewport,
  // Stash's own navbar collapses behind a Bootstrap hamburger toggler
  // below its xl breakpoint, and #hon-floating-btn lives inside that
  // collapsed .navbar-collapse until the toggler opens it.
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

// Drives a full swipe past the 80px threshold via CDP, matching
// device-review.spec.js's mid-drag capture but carried through to
// touchend so the throw + cycle actually fires.
async function swipeTopCard(page, dx = 150) {
  const card = page.locator(".hon-swipe-card-wrapper").first();
  const box = await card.boundingBox();
  if (!box) throw new Error("no .hon-swipe-card-wrapper to swipe");

  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  const client = await page.context().newCDPSession(page);
  const touchPoint = (x, y) => [{ x, y, id: 1 }];

  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: touchPoint(startX, startY),
  });
  // A few intermediate points, not one jump — matches how a real drag
  // fires touchmove repeatedly (handleTouchMove reads e.touches[0] each
  // time), rather than a single 150px step.
  for (const step of [40, 90, 150].map((n) => Math.min(n, dx))) {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: touchPoint(startX + step, startY),
    });
  }
  await client.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await client.detach();
}

test.beforeEach(async ({ page }) => {
  await mockGraphQL(page);
  await page.goto("/");
  await openModal(page);
});

test("swiping past the threshold snaps the demoted card instead of animating it back on-screen", async ({ page }) => {
  await expect(page.locator(".hon-swipe-card-wrapper")).toHaveCount(2);

  await swipeTopCard(page);

  // Give the 250ms throw-and-cycle timer (SWIPE_MS, HeadToHead.jsx) time
  // to fire and land the single-commit topIndex flip.
  await page.waitForTimeout(350);

  const wrappers = await page.locator(".hon-swipe-card-wrapper").evaluateAll((els) =>
    els.map((el) => ({
      transform: el.style.transform,
      transition: el.style.transition,
      zIndex: el.style.zIndex,
      pointerEvents: el.style.pointerEvents,
    }))
  );

  const promoted = wrappers.find((w) => w.zIndex === "2");
  const demoted = wrappers.find((w) => w.zIndex === "1");
  expect(promoted).toBeTruthy();
  expect(demoted).toBeTruthy();

  // The regression this guards: the demoted card must never carry a live
  // transition — it should have snapped to the back position, not slid
  // back in from off-screen over 250ms.
  // Browsers normalize inline transform values to px, so translate3d(0,
  // 12px, 0) round-trips as translate3d(0px, 12px, 0px).
  expect(demoted.transition).toBe("none");
  expect(demoted.transform).toContain("translate3d(0px, 12px, 0px)");
  expect(demoted.transform).toContain("scale(0.95)");
  expect(demoted.pointerEvents).toBe("none");

  // The promoted card is the one that (potentially) transitions, and its
  // resting transform is the identity — dragX zeroed in the same commit
  // that flipped topIndex.
  expect(promoted.transform).toContain("translate3d(0px, 0px, 0px)");
  expect(promoted.pointerEvents).toBe("auto");
});

test("the reveal starts immediately with the throw, not after it finishes", async ({ page }) => {
  // Regression guard for the follow-up fix: topIndex used to flip only
  // after the full SWIPE_MS throw timer fired, so the covered card sat
  // static and revealed-but-idle for ~250ms before its own 250ms scale-up
  // even began — a visible hesitation between the throw landing and the
  // reveal starting. Now both run concurrently: topIndex flips in the same
  // commit the throw starts, so a poll shortly after touchend (well inside
  // the first 250ms window) should already show the covered card promoted
  // and mid-transition, with the thrown card still marked exiting.
  await swipeTopCard(page);

  const wrappers = await page.locator(".hon-swipe-card-wrapper").evaluateAll((els) =>
    els.map((el) => ({
      transform: el.style.transform,
      transition: el.style.transition,
      zIndex: el.style.zIndex,
    }))
  );

  const promoted = wrappers.find((w) => w.zIndex === "2");
  const exiting = wrappers.find((w) => w.zIndex === "3");
  expect(promoted).toBeTruthy();
  expect(exiting).toBeTruthy();

  // The promoted card is already animating (not "none") this early —
  // proof the reveal didn't wait for the throw's own timer to elapse.
  expect(promoted.transition).toContain("250ms");
  // The exiting (just-thrown) card keeps its own transition running too,
  // to the same off-screen target it was already headed to — it isn't cut
  // off or snapped away just because topIndex moved on.
  expect(exiting.transition).toContain("250ms");
  expect(exiting.transform).not.toContain("translate3d(0px, 0px, 0px)");
});

test("both cards use the same transform function order so they interpolate per-function, not via matrix decomposition", async ({ page }) => {
  const transforms = await page.locator(".hon-swipe-card-wrapper").evaluateAll((els) =>
    els.map((el) => el.style.transform)
  );
  expect(transforms).toHaveLength(2);

  const functionOrder = (t) => [...t.matchAll(/([a-zA-Z0-9]+)\(/g)].map((m) => m[1]);
  const [a, b] = transforms.map(functionOrder);
  expect(a).toEqual(["translate3d", "rotate", "scale"]);
  expect(b).toEqual(["translate3d", "rotate", "scale"]);
});

test("a new pair resets to the first card on top without a spurious promote animation", async ({ page }) => {
  // Cycle once so topIndex is 1 (odd swipe count) before the pair changes —
  // this is exactly the state that used to trigger the useEffect-driven
  // stale-frame commit and its unrequested 250ms scale-up.
  await swipeTopCard(page);
  await page.waitForTimeout(350);

  // Click the currently-promoted card's choose button specifically — after
  // the swipe above, DOM order (key={index}) still puts card 0 first, but
  // card 1 is the one with pointerEvents: "auto" now.
  await page.evaluate(() => {
    const wrappers = Array.from(document.querySelectorAll(".hon-swipe-card-wrapper"));
    const top = wrappers.find((el) => el.style.pointerEvents === "auto");
    top?.querySelector(".hon-choose-btn")?.click();
  });
  // Outcome overlay (~1s) plus the auto-advance to a new pair.
  await page.waitForTimeout(1300);

  const wrappers = await page.locator(".hon-swipe-card-wrapper").evaluateAll((els) =>
    els.map((el) => ({ transform: el.style.transform, zIndex: el.style.zIndex }))
  );
  const promoted = wrappers.find((w) => w.zIndex === "2");
  expect(promoted).toBeTruthy();
  // The new pair's top card is index 0 again — no lingering topIndex: 1
  // carried over from the previous pair.
  expect(promoted.transform).toContain("translate3d(0px, 0px, 0px)");
});

test("touching down alone doesn't tear down the wrapper's transition", async ({ page }) => {
  // The actual defect is in the JS state, not a specific frame of a live
  // animation: the top card's inline transition is "transform 250ms
  // cubic-bezier(...)" (isTop && !isDragging) any time it's at rest, not
  // just while a promote is in flight — the CSS declaration is present
  // whether or not anything is currently transforming. Before this fix,
  // handleTouchStart set isDragging synchronously on touch-down alone,
  // flipping that transition to "none" on nothing more than a tap. Testing
  // it at rest (rather than trying to land a touch inside the live
  // promote's ~1-frame tail window, per the SWIPE_MS comment in
  // HeadToHead.jsx) asserts the same state-logic fix deterministically,
  // without racing real animation frame timing.
  const box = await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll(".hon-swipe-card-wrapper")).find(
      (w) => w.style.zIndex === "2"
    );
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!box) throw new Error("no top .hon-swipe-card-wrapper to touch");

  const client = await page.context().newCDPSession(page);
  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: box.x, y: box.y, id: 1 }],
  });

  const afterTouchStart = await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll(".hon-swipe-card-wrapper")).find(
      (w) => w.style.zIndex === "2"
    );
    return el?.style.transition;
  });
  // Touch-down alone must not have torn down the transition.
  expect(afterTouchStart).toContain("250ms");

  // Now establish real drag intent (past the 8px threshold) and confirm the
  // transition *does* drop to "none" once a genuine drag starts — the
  // deferral shouldn't disable drag responsiveness, just delay it past
  // touch-down.
  await client.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: box.x + 40, y: box.y, id: 1 }],
  });
  // CDP's dispatchTouchEvent resolves once the OS-level event is injected,
  // not once React has processed it and committed the resulting state —
  // without this, the read below can race the touchmove handler's setState
  // and see the pre-drag transition (this is exactly what happened before
  // this wait was added: a false failure, not a real regression).
  await page.waitForTimeout(50);

  const afterTouchMove = await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll(".hon-swipe-card-wrapper")).find(
      (w) => w.style.zIndex === "2"
    );
    return el?.style.transition;
  });
  expect(afterTouchMove).toBe("none");

  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await client.detach();
});

test("a rightward swipe throw can't turn .hon-main-plugin-content into a horizontal scroll container", async ({ page }) => {
  // Regression guard: the thrown card's translate3d(...) lives on
  // an absolutely-positioned, transformed .hon-swipe-card-wrapper — a
  // transformed box still grows its ancestors' *scrollable* overflow area
  // even though it's visually out of flow. Before the fix, nothing between
  // .hon-vs-container.hon-swipe-stack and .hon-modal-content declared any
  // overflow, so a rightward throw (up to +110% of the container's width)
  // made .hon-main-plugin-content — the nearest ancestor with overflow:
  // auto, needed there for desktop's stats-table scrollport — scrollable
  // sideways for the ~250ms the throw was live. Checked mid-throw (no
  // waitForTimeout past touchend) since that's the live window; also
  // confirms scrollLeft can't actually be driven, not just that scrollWidth
  // reports even.
  const scrollBox = () =>
    page.evaluate(() => {
      const el = document.querySelector(".hon-main-plugin-content");
      return el ? { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth } : null;
    });

  const atRest = await scrollBox();
  expect(atRest).toBeTruthy();
  expect(atRest.scrollWidth).toBe(atRest.clientWidth);

  await swipeTopCard(page, 150);

  const midThrow = await scrollBox();
  expect(midThrow.scrollWidth).toBe(midThrow.clientWidth);

  const scrollLeftAfterAttempt = await page.evaluate(() => {
    const el = document.querySelector(".hon-main-plugin-content");
    el.scrollLeft = 9999;
    return el.scrollLeft;
  });
  expect(scrollLeftAfterAttempt).toBe(0);
});
