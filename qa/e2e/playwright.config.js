// @ts-check
import { defineConfig, devices } from "@playwright/test";

/**
 * Points at a real, running Stash instance with Xenith installed and
 * loaded. There is no way to meaningfully mock the plugin's DOM injection,
 * modal lifecycle, or MutationObserver behavior without the real
 * main.js/badge-injector.js running in a real page — this suite mocks
 * GraphQL responses (for deterministic data) but not Stash itself.
 *
 * Set STASH_URL before running, e.g.:
 *   STASH_URL=http://localhost:9999 npx playwright test
 */
export default defineConfig({
  testDir: ".",
  timeout: 30_000,
  fullyParallel: false, // tests share MutationObserver/global window state
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.STASH_URL || "http://localhost:9999",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    // testIgnore excludes device-review.spec.js and leaderboard-perf.spec.js
    // from the default project so neither runs there regardless of how the
    // CLI is invoked.
    //
    // Both chromium and webkit run by default (not just chromium) — the two
    // engines have opposite blind spots on this exact suite: a sticky-
    // column regression only showed up on real WebKit (Chromium measured no
    // cost), and a mobile-sheet scroll bug only reproduced on Chromium
    // (WebKit doesn't focus buttons on tap, so the focus-scroll that caused
    // it never fires there). One engine alone misses whichever bug is
    // native to the other.
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: /device-review\.spec\.js|leaderboard-perf\.spec\.js|swipe\.spec\.js/,
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
      testIgnore: /device-review\.spec\.js|leaderboard-perf\.spec\.js|swipe\.spec\.js/,
    },
    // Portrait-mobile project for e2e/swipe.spec.js only — runs on every
    // default `test:e2e` invocation (no env-var gate), unlike the
    // DEVICE_REVIEW-gated projects below, because a swipe-reveal bug
    // had zero regression coverage before this: the only prior swipe touch
    // was device-review.spec.js's screenshot capture, which never runs in
    // CI. Forced to Chromium (not the iPhone 14 Pro preset's default
    // WebKit) because SwipeStack reads e.touches[0] off real TouchEvents,
    // and driving a multi-step touchstart/move/end drag needs CDP
    // Input.dispatchTouchEvent — WebKit's Playwright transport doesn't
    // implement CDP (same constraint documented on iphone14pro below).
    {
      name: "mobile-portrait",
      testMatch: /swipe\.spec\.js/,
      use: { ...devices["iPhone 14 Pro"], browserName: "chromium" },
    },
    // Device-review projects — qa/e2e/device-review.spec.js only. Playwright
    // runs every listed project when no --project filter is given, so
    // without this env-var gate a plain `npm run test:e2e` would also spin
    // up six extra heavy captures on every invocation. Opt in with
    // DEVICE_REVIEW=1, and select the specific project(s) via --project
    // (see device-review.spec.js's header comment for the full command).
    ...(process.env.DEVICE_REVIEW
      ? [
          {
            name: "wqhd-plus",
            testMatch: /device-review\.spec\.js/,
            use: { viewport: { width: 3840, height: 1600 }, deviceScaleFactor: 1 },
          },
          {
            name: "uhd",
            testMatch: /device-review\.spec\.js/,
            use: { viewport: { width: 3840, height: 2160 }, deviceScaleFactor: 1 },
          },
          {
            name: "uhd-hidpi",
            testMatch: /device-review\.spec\.js/,
            use: { viewport: { width: 3840, height: 2160 }, deviceScaleFactor: 2 },
          },
          {
            // browserName is forced to Chromium (the iPhone 14 Pro device
            // preset otherwise defaults to WebKit) because this spec's own
            // capture helpers are Chromium-only: dumpMatchedStyles() needs
            // CDP's CSS.getMatchedStylesForNode, the h2h view's MHTML
            // snapshot needs CDP's Page.captureSnapshot, and the mid-drag
            // SwipeStack frame needs CDP's Input.dispatchTouchEvent — none
            // of which WebKit exposes. This emulates the viewport/DPR/touch
            // surface, not real WebKit rendering; see the webkit-iphone
            // project below for the real-engine counterpart (device-
            // review.spec.js gates the CDP-only captures per-engine so both
            // projects can share the same spec).
            name: "iphone14pro",
            testMatch: /device-review\.spec\.js/,
            use: { ...devices["iPhone 14 Pro"], browserName: "chromium" },
          },
          {
            // Real WebKit counterpart to iphone14pro above — no
            // browserName override, so this uses actual Safari/WebKit
            // rendering rather than Chromium emulating the viewport. Covers
            // that class of bug (Chromium-only: focus-scroll on tap)
            // the same way iphone14pro's Chromium run covers the sticky-column class
            // (WebKit-only: sticky-column cost). Named webkit-iphone, not
            // webkit-mobile, to avoid colliding with the PERF-gated project
            // of that name below (leaderboard-perf.spec.js only).
            name: "webkit-iphone",
            testMatch: /device-review\.spec\.js/,
            use: { ...devices["iPhone 14 Pro"] },
          },
          {
            // Playwright's bundled `devices` has no "iPad Air" preset (only
            // iPad gen 5/6/7/11, Mini, Pro 11), so "iPad Pro 11" landscape
            // stands in as the closest bundled preset (834x1194 @ DPR 2 vs.
            // the real iPad Air 10.9"'s 820x1180 @ DPR 2) rather than
            // hand-specifying a custom viewport/UA. Only Chromium is
            // installed locally, same as iphone14pro above, so browserName
            // is forced rather than relying on the (WebKit) default.
            name: "ipadair-landscape",
            testMatch: /device-review\.spec\.js/,
            use: { ...devices["iPad Pro 11 landscape"], browserName: "chromium" },
          },
        ]
      : []),
    // leaderboard-perf.spec.js only, gated behind PERF=1 for the same
    // reason DEVICE_REVIEW gates the projects above — this shouldn't run on
    // every default `test:e2e` invocation. Real WebKit (no browserName
    // override): device-review's iphone14pro project forces Chromium, which
    // is exactly the blind spot that missed the sticky-column
    // regression (see leaderboard-perf.spec.js's header comment). WebKit is
    // already installed locally (webkit-2311 in the Playwright cache) — no
    // extra `playwright install` needed beyond what qa/README.md already
    // has for chromium.
    ...(process.env.PERF
      ? [
          {
            name: "webkit-mobile",
            testMatch: /leaderboard-perf\.spec\.js/,
            use: { ...devices["iPhone 14 Pro"] },
          },
          // Desktop counterparts — mobile-WebKit numbers alone don't
          // tell you whether a 16k-scene pool is fine on the surface with
          // the higher DOM ceiling, since nothing at desktop viewport was
          // ever measured. Both engines, same rationale as the default
          // chromium/webkit projects above.
          {
            name: "desktop-chromium",
            testMatch: /leaderboard-perf\.spec\.js/,
            use: { ...devices["Desktop Chrome"] },
          },
          {
            name: "desktop-webkit",
            testMatch: /leaderboard-perf\.spec\.js/,
            use: { ...devices["Desktop Safari"] },
          },
        ]
      : []),
  ],
});
