// Shared reader for Xenith's own plugin settings (xenith.yml's `settings:`
// block), fetched via Stash's `configuration { plugins }` query. Extracted
// out of badge-injector.js once a second consumer (Leaderboard.jsx's
// page-size setting) needed the same 60s-TTL value without duplicating the
// fetch/cache — a third (useCardChips.js) has since joined them.
import { gql } from "./api";

const CACHE_TTL_MS = 60000;

// Shorter backoff for a failed fetch than the normal success TTL, so a
// persistent failure doesn't hammer the config query on every caller, but
// still recovers faster than 60s once it starts succeeding again.
const FAILURE_BACKOFF_MS = 10000;

/** @type {Record<string, any> | null} */
let cache = null;
let cacheExpiry = 0;
let failureUntil = 0;
/** @type {any} */
let lastError = null;

// Returns the `xenith` plugin's settings object (e.g. { HideXenRankBadge,
// LeaderboardRowsPerPage, UseCustomaryUnits, HiddenChips, HiddenSceneChips }).
// Rejects on fetch failure — callers decide their
// own fail-open/fail-closed policy per setting, same as before this was
// shared (badge-injector.js fails closed; Leaderboard.jsx falls back to its
// "auto" page size). A failure is cached for FAILURE_BACKOFF_MS so repeat
// callers during that window re-reject immediately without a new fetch.
/** @returns {Promise<Record<string, any>>} */
export async function getPluginConfig() {
  const now = Date.now();
  if (cache !== null && now < cacheExpiry) return cache;
  if (now < failureUntil) throw lastError;
  try {
    /** @type {Record<string, any>} */
    const resolved = (await gql(`query { configuration { plugins } }`)).configuration.plugins?.xenith ?? {};
    cache = resolved;
    cacheExpiry = now + CACHE_TTL_MS;
    failureUntil = 0;
    return resolved;
  } catch (err) {
    cache = null;
    lastError = err;
    failureUntil = now + FAILURE_BACKOFF_MS;
    throw err;
  }
}

// Clears the cache and any failure backoff — called on plugin
// teardown/reload (destroyBadgeInjector's __xenithCleanup path) so a fresh
// mount doesn't carry over stale config state.
export function resetPluginConfig() {
  cache = null;
  cacheExpiry = 0;
  failureUntil = 0;
  lastError = null;
}
