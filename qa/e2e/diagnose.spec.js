// // @ts-check
import { test, expect } from "@playwright/test";

test("diagnose why Xenith isn't rendering", async ({ page }) => {
  /** @type {string[]} */
  const consoleErrors = [];
  /** @type {string[]} */
  const pageErrors = [];
  /** @type {string[]} */
  const failedRequests = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => {
    pageErrors.push(err.message);
  });
  page.on("requestfailed", (req) => {
    failedRequests.push(`${req.url()} — ${req.failure()?.errorText}`);
  });

  await page.goto("/");

  await page.locator("#hon-floating-btn")
    .waitFor({ state: "attached", timeout: 5000 })
    .catch(() => null);

  console.log("\n=== Xenith diagnostic ===");

  const hasPluginApi = await page.evaluate(() => typeof window.PluginApi !== "undefined");
  console.log(hasPluginApi ? "✅ window.PluginApi is defined" : "❌ window.PluginApi is undefined");

  if (pageErrors.length) {
    console.log(`❌ ${pageErrors.length} uncaught page error(s):`);
    pageErrors.forEach((e) => console.log(`   - ${e}`));
  } else {
    console.log("✅ no uncaught page errors");
  }

  if (consoleErrors.length) {
    console.log(`⚠️  ${consoleErrors.length} console.error() call(s):`);
    consoleErrors.forEach((e) => console.log(`   - ${e}`));
  }

  if (failedRequests.length) {
    console.log(`❌ ${failedRequests.length} failed request(s):`);
    failedRequests.forEach((r) => console.log(`   - ${r}`));
  }

  const hasNavbar = await page.locator(".navbar-nav").count();
  console.log(hasNavbar > 0 ? "✅ .navbar-nav exists" : "❌ .navbar-nav does not exist");

  const hasWrapper = await page.locator("#hon-floating-btn-wrapper").count();
  const hasButton = await page.locator("#hon-floating-btn").count();
  console.log(hasWrapper > 0 ? "✅ #hon-floating-btn-wrapper exists" : "❌ #hon-floating-btn-wrapper does not exist");
  console.log(hasButton > 0 ? "✅ #hon-floating-btn exists" : "❌ #hon-floating-btn does not exist");

  console.log("=== end diagnostic ===\n");

  expect(pageErrors, `uncaught JS error during load: ${pageErrors[0]}`).toHaveLength(0);
  expect(hasPluginApi, "window.PluginApi was never defined — script load order issue").toBe(true);
  expect(hasNavbar, ".navbar-nav missing — Stash markup may not match what addFloatingButton() expects").toBeGreaterThan(0);
  expect(hasButton, "#hon-floating-btn never got created").toBeGreaterThan(0);
});
