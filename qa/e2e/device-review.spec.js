// @ts-check
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { test, expect } from "@playwright/test";
import { mockGraphQL, richPerformers, richScenes } from "./fixtures/graphql.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Capture-only spec for the modal device review. NOT part
 * of `npm run test:e2e` — the wqhd-plus/uhd/uhd-hidpi/iphone14pro/
 * ipadair-landscape projects only exist in playwright.config.js when
 * DEVICE_REVIEW is set (Playwright otherwise runs every listed project on a
 * bare `playwright test`, which would silently add five heavy captures to
 * every default e2e run), and testIgnore keeps this file away from the
 * default chromium project even when DEVICE_REVIEW is set.
 *
 * Run explicitly, e.g.:
 *   DEVICE_REVIEW=1 STASH_URL=http://localhost:9999 npx playwright test \
 *     -c e2e/playwright.config.js e2e/device-review.spec.js \
 *     --project=wqhd-plus --project=uhd --project=uhd-hidpi --project=iphone14pro \
 *     --project=ipadair-landscape
 *
 * For each project x battle-mode combination, writes four artifacts to
 * OUT_DIR: a PNG, a computed-style/bounding-rect JSON dump, a CDP
 * matched-styles-for-node dump (the ordered cascade — this is what actually
 * explains *why* a card is sized the way it is, not just the winning
 * value), and (h2h view only) an MHTML snapshot with every stylesheet
 * inlined.
 */

const OUT_DIR =
  process.env.DEVICE_REVIEW_OUT_DIR ||
  path.join(__dirname, ".artifacts", "device-review");

const SELECTORS = [
  ".hon-modal-content",
  ".hon-vs-container",
  ".hon-h2h",
  ".hon-scene-card",
  // Captures the swipe stack's own wrapper transform/transition —
  // useful context for debugging swipe-stack layout issues the way an
  // earlier investigation needed. Only ever populated on the mobile-portrait project; null
  // elsewhere, same as any selector that doesn't match on a given capture.
  ".hon-swipe-card-wrapper",
  ".hon-card-native-wrap",
  ".hon-card-native-wrap .performer-card-image",
  ".hon-card-native-wrap .scene-card-preview-image",
  ".hon-card-chips",
  ".hon-choose-btn",
  ".hon-tier-btn",
  ".hon-modal-close",
  ".hon-leaderboard",
  ".hon-stats-table-wrapper",
  ".hon-stats-table",
];

// Flags any captured element whose own box exceeds the modal's content
// width/top — except .hon-stats-table, which is deliberately excluded: it's
// meant to be wider than its wrapper and scroll, not clip. The wrapper
// itself (.hon-stats-table-wrapper) IS checked — it's the table's real
// scrollport (.hon-stats-table-wrapper below 900px, .hon-main-plugin-content
// above it) and must never itself exceed the modal, or the overflow would
// leak into the rest of the layout instead of scrolling contained. This is
// what would have caught the .hon-leaderboard overflow bug: the modal's
// full-bleed background matches the page background behind it, so the same-
// color overflow was invisible in a screenshot despite being real.
//
// Also asserts .hon-modal-content.scrollTop === 0 — the guard that would
// have caught an earlier bug (selecting a mobile bottom-sheet option scrolled the
// modal itself ~320px, stranding the header above the visible top edge).
// A horizontal-only rect.right check never saw that: the scrolled content
// was still narrower than the modal, just shifted vertically. The rect.top
// check below is the same idea applied per-element, in case a future bug
// pushes something off the top edge without scrolling .hon-modal-content
// itself (e.g. a stray negative margin).
async function checkNoOverflow(page) {
  return page.evaluate((selectors) => {
    const modal = document.querySelector(".hon-modal-content");
    if (!modal) return [];
    const modalRect = modal.getBoundingClientRect();
    const offenders = [];
    if (modal.scrollTop !== 0) {
      offenders.push({ selector: ".hon-modal-content", scrollTop: modal.scrollTop });
    }
    for (const sel of selectors) {
      if (sel === ".hon-stats-table") continue; // scrolls inside its wrapper by design
      const el = document.querySelector(sel);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (rect.right > modalRect.right + 1) {
        offenders.push({ selector: sel, right: rect.right, modalRight: modalRect.right });
      }
      if (rect.top < modalRect.top - 1) {
        offenders.push({ selector: sel, top: rect.top, modalTop: modalRect.top });
      }
    }
    return offenders;
  }, SELECTORS);
}

const COMPUTED_PROPS = [
  "width",
  "height",
  "maxWidth",
  "maxHeight",
  "minWidth",
  "minHeight",
  "objectFit",
  "padding",
  "fontSize",
  "position",
  "transform",
  "transition",
];

async function openModal(page) {
  // Stash's own navbar collapses behind a Bootstrap hamburger toggler below
  // its xl breakpoint (navbar-expand-xl) — on a 393px viewport the
  // floating button lives inside that collapsed .navbar-collapse and isn't
  // clickable until the toggler opens it. Race the toggler click against
  // the button already being visible (desktop projects never see the
  // toggler at all), and re-check rather than trusting a single isVisible
  // snapshot, which can catch the navbar mid-render on first paint.
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

// On mobile-portrait, Sidebar.jsx shows a persistent .hon-mobile-bar
// instead of the desktop .hon-sidebar-row list — nothing hidden behind a
// toggle to expand first, unlike the old "☰ Menu" accordion this replaced.
// Desktop/landscape rows are always visible, so the .hon-sidebar-row
// branch is a no-op there.
//
// Board / Stats / Filter are still direct single-tap toggles
// (.hon-mobile-seg-btn / .hon-mobile-filter-btn). Record Type and Match
// Type are pickers (.hon-mobile-picker) that open a bottom sheet
// (OptionSheet.jsx, .hon-sheet-row) instead — if mobileLabel doesn't match
// a direct toggle, fall through to the Record Type picker + sheet (the
// only picker this suite currently drives).
async function selectNav(page, label, mobileLabel) {
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
    await page.locator(".hon-sidebar-row", { hasText: label }).click();
  }
}

async function setBattleType(page, mode) {
  if (mode === "performers") {
    await selectNav(page, "🎭 Performers", "Performers");
  } else {
    await selectNav(page, "🎬 Scenes", "Scenes");
  }
}

async function dumpComputedStyles(page) {
  return page.evaluate(
    ({ selectors, props }) => {
      const out = {};
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (!el) {
          out[sel] = null;
          continue;
        }
        const cs = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        out[sel] = {
          computed: Object.fromEntries(props.map((p) => [p, cs[p]])),
          rect: { width: rect.width, height: rect.height, top: rect.top, left: rect.left },
        };
      }
      return out;
    },
    { selectors: SELECTORS, props: COMPUTED_PROPS }
  );
}

// CDP (newCDPSession, Input.dispatchTouchEvent, etc.) is Chromium-only —
// WebKit's Playwright transport doesn't implement it. Gates the three
// captures below (matched-rules dump, MHTML snapshot, mid-drag touch frame)
// so webkit-iphone can share this spec with iphone14pro instead of needing
// its own copy.
function isChromium(page) {
  return page.context().browser()?.browserType().name() === "chromium";
}

// CSS.getMatchedStylesForNode via raw CDP — returns the full ordered
// cascade (every matched rule, its stylesheet origin, its selector, and
// which declarations lost) for one node, not just the winning value.
// Chromium-only (see isChromium above) — callers must guard.
async function dumpMatchedStyles(page, selector) {
  const client = await page.context().newCDPSession(page);
  await client.send("DOM.enable");
  await client.send("CSS.enable");
  const { root } = await client.send("DOM.getDocument", { depth: -1, pierce: true });

  const nodeIdResult = await client.send("DOM.querySelector", {
    nodeId: root.nodeId,
    selector,
  });
  if (!nodeIdResult.nodeId) return null;

  const matched = await client.send("CSS.getMatchedStylesForNode", {
    nodeId: nodeIdResult.nodeId,
  });
  await client.detach();

  // Trim to what's actually useful for a cascade review: selector text,
  // origin, and the declaration list per matched rule.
  return (matched.matchedCSSRules || []).map((m) => ({
    origin: m.rule.origin,
    selector: m.rule.selectorList.text,
    styleSheetId: m.rule.styleSheetId,
    declarations: (m.rule.style.cssProperties || []).map((p) => ({
      name: p.name,
      value: p.value,
      disabled: !!p.disabled,
    })),
  }));
}

// Walks from the native card image up to (and including) .hon-card-native-wrap,
// recording each ancestor's tag/class and the computed properties that
// determine whether height actually flows down to it. Pairs with
// dumpMatchedStyles (which explains *which rule won*) by showing *where the
// height chain breaks* — i.e. the first ancestor whose own height resolves to
// auto/content-based despite a definite-height parent.
async function dumpAncestorChain(page, imgSelector) {
  return page.evaluate((selector) => {
    const img = document.querySelector(selector);
    if (!img) return null;
    const wrap = img.closest(".hon-card-native-wrap");
    const chain = [];
    let el = img;
    while (el) {
      const cs = getComputedStyle(el);
      chain.push({
        tagName: el.tagName,
        className: typeof el.className === "string" ? el.className : "",
        display: cs.display,
        height: cs.height,
        flex: cs.flex,
        minHeight: cs.minHeight,
      });
      if (el === wrap) break;
      el = el.parentElement;
    }
    return chain;
  }, imgSelector);
}

async function captureView(page, project, mode, view) {
  const prefix = `${project}__${mode}__${view}`;
  const dir = path.join(OUT_DIR, project);
  fs.mkdirSync(dir, { recursive: true });

  // Record Type / Match Type / Gender Filter each close via a 220ms CSS
  // transform transition (OptionSheet.jsx / .hon-sheet), not an instant
  // DOM change — a screenshot taken immediately after selectNav's click can
  // catch a closing sheet still mid-transition, painted partway up the
  // screen even though React/CSS state is already "closed" (confirmed via
  // getComputedStyle + getBoundingClientRect at the exact capture instant:
  // the sheet's transform is already at its fully-closed value; the
  // compositor's painted frame just hasn't caught up yet). This wait
  // reduces how often that happens but does not eliminate it — a
  // waitForFunction poll on the sheet's rect is a real fix, but it hangs
  // indefinitely on desktop/landscape projects where .hon-mobile-bar and
  // its sheets are permanently display:none. Purely a screenshot-fidelity
  // issue in this opt-in visual-review tool; the default `npm run test:e2e`
  // suite drives the same sheets and passes cleanly.
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(dir, `${prefix}.png`) });

  const styles = await dumpComputedStyles(page);
  fs.writeFileSync(path.join(dir, `${prefix}.computed.json`), JSON.stringify(styles, null, 2));

  // Skipped mid-drag: SwipeStack intentionally translateX()s the top card
  // partway off-screen as live drag feedback — that transient overflow is
  // the feature, not a layout bug, and would always fail this check.
  if (view !== "h2h-swipe-mid-drag") {
    const overflow = await checkNoOverflow(page);
    if (overflow.length) {
      fs.writeFileSync(path.join(dir, `${prefix}.overflow.json`), JSON.stringify(overflow, null, 2));
    }
    expect(overflow, `elements overflowing .hon-modal-content in ${prefix}`).toEqual([]);
  }

  const imgSelector =
    mode === "performers"
      ? ".hon-card-native-wrap .performer-card-image"
      : ".hon-card-native-wrap .scene-card-preview-image";

  // Matched-rules cascade dump and the MHTML snapshot below both need CDP
  // (see isChromium) — WebKit projects (webkit-iphone) get the screenshot,
  // computed-style, ancestor-chain, and overflow captures below just fine,
  // just not these two CDP-only artifacts.
  if (isChromium(page)) {
    const matched = await dumpMatchedStyles(page, imgSelector);
    fs.writeFileSync(path.join(dir, `${prefix}.matched-rules.json`), JSON.stringify(matched, null, 2));
  }

  const ancestors = await dumpAncestorChain(page, imgSelector);
  fs.writeFileSync(path.join(dir, `${prefix}.ancestors.json`), JSON.stringify(ancestors, null, 2));

  if (view === "h2h" && isChromium(page)) {
    const client = await page.context().newCDPSession(page);
    const { data } = await client.send("Page.captureSnapshot", { format: "mhtml" });
    fs.writeFileSync(path.join(dir, `${prefix}.mhtml`), data);
    await client.detach();
  }
}

for (const mode of ["performers", "scenes"]) {
  test(`capture: ${mode} mode`, async ({ page }, testInfo) => {
    const project = testInfo.project.name;
    // Both modes capture the rich chip pool — a full 3-line row with a "+N" overflow chip is the worst
    // case for the mobile-portrait chip-vs-image tradeoff this suite
    // exists to check.
    await mockGraphQL(page, mode === "performers" ? { performers: richPerformers() } : { scenes: richScenes() });
    await page.goto("/");
    await openModal(page);
    await setBattleType(page, mode);

    // h2h — idle state
    await captureView(page, project, mode, "h2h");

    // h2h — post-vote state (win/loss glow + delta badge)
    await page.locator(".hon-choose-btn").first().click();
    await page.waitForTimeout(300); // let the delta-pop animation settle
    await captureView(page, project, mode, "h2h-postvote");

    // Mid-drag SwipeStack frame — portrait-mobile projects only, both modes
    // share the same drag mechanics so one capture per mode is enough.
    // SwipeStack's handlers read e.touches[0] (real TouchEvents), so this
    // needs CDP Input.dispatchTouchEvent rather than Playwright's mouse API
    // (synthesizes pointer/mouse events the component ignores) — and CDP is
    // Chromium-only (isChromium), so webkit-iphone skips this capture
    // entirely rather than the project-name check alone deciding.
    if ((project === "iphone14pro" || project === "webkit-iphone") && isChromium(page)) {
      await page.reload();
      await mockGraphQL(page, mode === "performers" ? { performers: richPerformers() } : { scenes: richScenes() });
      await page.goto("/");
      await openModal(page);
      await setBattleType(page, mode);
      const card = page.locator(".hon-swipe-card-wrapper").first();
      const box = await card.boundingBox();
      if (box) {
        const startX = box.x + box.width / 2;
        const startY = box.y + box.height / 2;
        const client = await page.context().newCDPSession(page);
        const touchPoint = (x, y) => [{ x, y, id: 1 }];
        await client.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: touchPoint(startX, startY),
        });
        await client.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: touchPoint(startX + 120, startY),
        });
        await captureView(page, project, mode, "h2h-swipe-mid-drag");
        await client.send("Input.dispatchTouchEvent", {
          type: "touchEnd",
          touchPoints: [],
        });
        await client.detach();
      }
    }
  });
}

test("capture: leaderboard", async ({ page }, testInfo) => {
  const project = testInfo.project.name;
  await mockGraphQL(page);
  await page.goto("/");
  await openModal(page);
  await selectNav(page, "📊 Leaderboard", "Board");
  await expect(page.locator(".hon-leaderboard")).toBeVisible();
  await captureView(page, project, "n-a", "leaderboard");
});

// Confirms JS and CSS agree at the shared 900px breakpoint: at 901px
// portrait neither should treat the viewport as mobile (SwipeStack must
// not render with a `static`-positioned .hon-vs-container), and at 900px
// portrait both should (SwipeStack renders and .hon-vs-container.hon-
// swipe-stack picks up `position: relative` from the CSS media query).
for (const width of [901, 900]) {
  test(`confirm C1: JS/CSS breakpoint agreement at ${width}px portrait`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "iphone14pro", "breakpoint check only needs one project");
    await page.setViewportSize({ width, height: 1200 });
    await mockGraphQL(page);
    await page.goto("/");
    await openModal(page);
    // .hon-vs-container only renders once usePair's mocked GraphQL fetch
    // resolves (loading -> pair) — without this wait, a fast page.evaluate
    // can read the state while .hon-loading is still showing.
    await expect(page.locator(".hon-vs-container")).toBeVisible();

    // Reads the app's actual live media query rather than a literal
    // duplicated here, so this test tracks HeadToHead.jsx's
    // MOBILE_PORTRAIT_QUERY instead of silently drifting from it the way
    // the original 901px/900px mismatch did.
    const isMobilePortraitJS = await page.evaluate(
      () => window.matchMedia("(max-width: 900px) and (orientation: portrait)").matches
    );
    const vsContainerPosition = await page.evaluate(() => {
      const el = document.querySelector(".hon-vs-container");
      return el ? getComputedStyle(el).position : null;
    });

    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(OUT_DIR, `c1-breakpoint-check-${width}.json`),
      JSON.stringify({ width, isMobilePortraitJS, vsContainerPosition }, null, 2)
    );

    if (width === 901) {
      expect(isMobilePortraitJS).toBe(false);
      expect(vsContainerPosition).toBe("static");
    } else {
      expect(isMobilePortraitJS).toBe(true);
      expect(vsContainerPosition).toBe("relative");
    }
  });
}
