// @ts-check
import { chromium } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Written once by globalSetup below, read by playwright.config.js's
// promo-desktop/promo-mobile projects (use.storageState) so every promo
// test starts already authenticated instead of hitting Stash's login wall.
// Lives under .artifacts/, which the repo root .gitignore already excludes
// at any depth — never committed.
export const STORAGE_STATE_PATH = path.join(__dirname, ".artifacts", "promo", "storageState.json");

/**
 * Logs in to the live Stash instance once, if it asks, and persists the
 * resulting session as a storageState file, so the promo capture spec's
 * per-test browser contexts don't each need their own login flow. Only
 * runs when PROMO=1 (see playwright.config.js) — other suites either don't
 * need auth or (xenith.spec.js/device-review.spec.js/etc.) are unaffected
 * since globalSetup isn't wired in for their invocations.
 *
 * STASH_USERNAME/STASH_PASSWORD are only required if the target instance
 * actually has auth enabled (dangerous_allow_public_without_auth: false in
 * its config) — a login form appearing is what decides that, not whether
 * the env vars are set, so an already-open local instance needs neither.
 * @param {import('@playwright/test').FullConfig} config
 */
export default async function globalSetup(config) {
  const baseURL = config.projects[0]?.use?.baseURL || process.env.STASH_URL || "http://localhost:9999";

  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(baseURL);

  const usernameBox = page.getByRole("textbox", { name: "Username" });
  if (await usernameBox.isVisible({ timeout: 5000 }).catch(() => false)) {
    const username = process.env.STASH_USERNAME;
    const password = process.env.STASH_PASSWORD;
    if (!username || !password) {
      await browser.close();
      throw new Error(
        `${baseURL} requires login — set STASH_USERNAME and STASH_PASSWORD to log in to it.`
      );
    }
    await usernameBox.fill(username);
    await page.getByRole("textbox", { name: "Password" }).fill(password);
    await page.getByRole("button", { name: "Login" }).click();
    await page.waitForLoadState("networkidle").catch(() => {});
  }
  // Else: no login form appeared — already-authenticated or auth disabled,
  // nothing to do.

  await page.context().storageState({ path: STORAGE_STATE_PATH });
  await browser.close();
}
