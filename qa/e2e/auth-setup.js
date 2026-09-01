// @ts-check
import { chromium } from "@playwright/test";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Written once by globalSetup below, read by playwright.config.js's
// top-level `use.storageState` so every project's contexts — chromium,
// webkit, mobile-portrait, and the DEVICE_REVIEW/PERF/PROMO-gated ones
// alike — start already authenticated instead of hitting Stash's login
// wall. Lives under .artifacts/, which the repo root .gitignore already
// excludes at any depth — never committed.
export const STORAGE_STATE_PATH = path.join(__dirname, ".artifacts", "auth", "storageState.json");

/**
 * Reads username/password from a two-line credentials file (username on
 * line 1, password on line 2; blank lines and lines starting with "#" are
 * skipped). Used as a fallback when STASH_USERNAME/STASH_PASSWORD aren't
 * set — creds for a local instance often live in a file outside this repo
 * rather than in the shell environment. The path itself is never
 * hardcoded here: it's supplied via STASH_CREDS_FILE so a real path (which
 * would carry a username, an identity string) never lands in tracked code.
 * @param {string} filePath
 * @returns {{ username?: string, password?: string }}
 */
function readCredsFile(filePath) {
  const lines = fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  return { username: lines[0], password: lines[1] };
}

/**
 * Logs in to the live Stash instance once, if it asks, and persists the
 * resulting session as a storageState file, so every project's per-test
 * browser contexts start already authenticated rather than each needing
 * their own login flow. Runs on every invocation (globalSetup is wired in
 * unconditionally in playwright.config.js) — a no-auth instance is simply
 * a no-op below, since nothing happens unless a login form actually
 * appears.
 *
 * Credentials are resolved in order: STASH_USERNAME/STASH_PASSWORD, then
 * STASH_CREDS_FILE (a two-line username/password file). Only required if
 * the target instance actually has auth enabled — a login form appearing
 * is what decides that, not whether credentials are available, so an
 * already-open local instance needs neither.
 * @param {import('@playwright/test').FullConfig} config
 */
export default async function globalSetup(config) {
  const baseURL = config.projects[0]?.use?.baseURL || process.env.STASH_URL || "http://localhost:9999";

  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(baseURL);

  const usernameBox = page.getByRole("textbox", { name: "Username" });
  if (await usernameBox.isVisible({ timeout: 5000 }).catch(() => false)) {
    let username = process.env.STASH_USERNAME;
    let password = process.env.STASH_PASSWORD;
    const triedSources = ["STASH_USERNAME/STASH_PASSWORD"];

    if ((!username || !password) && process.env.STASH_CREDS_FILE) {
      triedSources.push("STASH_CREDS_FILE");
      const fromFile = readCredsFile(process.env.STASH_CREDS_FILE);
      username = username || fromFile.username;
      password = password || fromFile.password;
    }

    if (!username || !password) {
      await browser.close();
      throw new Error(
        `${baseURL} requires login — no usable credentials from: ${triedSources.join(", ")}. ` +
          `Set STASH_USERNAME/STASH_PASSWORD, or STASH_CREDS_FILE pointing at a two-line ` +
          `username/password file.`
      );
    }

    await usernameBox.fill(username);
    await page.getByRole("textbox", { name: "Password" }).fill(password);
    await page.getByRole("button", { name: "Login" }).click();
    await page.waitForLoadState("networkidle").catch(() => {});

    // Fail fast with one clear error rather than letting all 84 specs
    // fail individually against a still-showing login page.
    if (await usernameBox.isVisible({ timeout: 2000 }).catch(() => false)) {
      await browser.close();
      throw new Error(`${baseURL} login did not succeed — still on the login form after submit.`);
    }
  }
  // Else: no login form appeared — already-authenticated or auth disabled,
  // nothing to do.

  await page.context().storageState({ path: STORAGE_STATE_PATH });
  await browser.close();
}
