# Xenith QA Suite

Drop this `qa/` folder into the repo root (next to `src/`, `backend/`, `src/main.js`). This is the single entry point for testing Xenith. The coverage map below shows what's automated and where; the handful of things no test can substitute for are called out at the end. Run whichever layer's relevant to what you touched, top to bottom.

## Three layers

| Layer | Location | Tooling | Needs a server? |
|---|---|---|---|
| Unit | `qa/unit` | Vitest (`npm run test:unit`) | No |
| Backend | `qa/backend` | pytest, against an in-memory `FakeStash` double (`npm run test:backend`) | No |
| E2E | `qa/e2e` | Playwright, Chromium + WebKit (`npm run test:e2e`) | Yes — live Stash |

Both engines run by default, not just Chromium — they have opposite blind spots on this suite. A sticky-column regression only showed up on real WebKit (Chromium measured no cost at any row count); a mobile-sheet-scroll bug only reproduced on Chromium (WebKit doesn't focus buttons on tap, so the focus-scroll that caused it never fires there). One engine alone misses whichever bug is native to the other.

`qa/e2e/swipe.spec.js` also runs on every default `test:e2e` invocation, via its own `mobile-portrait` project (forced to Chromium — `SwipeStack`'s real-TouchEvent drag needs CDP's `Input.dispatchTouchEvent`, which WebKit's Playwright transport doesn't implement). It exists because a swipe-reveal bug had zero regression coverage before it.

## Setup

```
cd qa
npm install                             # needed for unit (Vitest) and e2e (Playwright)
                                        # backend suite self-provisions via `uv run` — just needs uv on PATH
npx playwright install chromium webkit  # only needed for e2e
```

## Running

```
npm run test:unit             # pure logic across the codebase (elo, matchmaking, gauntlet, champion,
                               # match-stats, session-log, stash-log, rank-cache, entity-href, card-chips,
                               # leaderboard-pagination, leaderboard-columns, plus a matchmaking-integration
                               # suite), no server needed
npm run test:backend          # tasks.py + main.py, mocked StashInterface, no server needed
npm test                      # unit + backend together — the CI-safe subset

STASH_URL=http://localhost:9999 npm run test:e2e            # needs a live Stash with Xenith loaded
STASH_URL=http://localhost:9999 npm run test:e2e:diagnose   # single diagnostic spec, same live-Stash requirement

# If the target instance has auth enabled, every project needs a login
# first (auth-setup.js's globalSetup, see below) — set STASH_USERNAME/
# STASH_PASSWORD, or STASH_CREDS_FILE pointing at a two-line
# username/password file. Neither is needed against an already-open
# instance; a login form appearing is what decides that, not whether
# credentials are set.

# Leaderboard rendering perf harness — mobile-WebKit (not
# Chromium emulation) plus desktop Chromium/WebKit, against both a
# 2,473-performer pool and a 16,000-scene pool. Not part of test:e2e; opt in
# with PERF=1, see leaderboard-perf.spec.js's header comment.
PERF=1 STASH_URL=http://localhost:9999 npx playwright test \
  -c e2e/playwright.config.js e2e/leaderboard-perf.spec.js \
  --project=webkit-mobile --project=desktop-chromium --project=desktop-webkit

# Device review — visual/computed-style capture pass across desktop and
# mobile viewports (see device-review.spec.js's header comment for the full
# project list). Not part of test:e2e; opt in with DEVICE_REVIEW=1.
# iphone14pro forces Chromium (its captures use CDP, which WebKit doesn't
# support); webkit-iphone is the same iPhone 14 Pro viewport on real WebKit.
DEVICE_REVIEW=1 STASH_URL=http://localhost:9999 npx playwright test \
  -c e2e/playwright.config.js e2e/device-review.spec.js \
  --project=iphone14pro --project=webkit-iphone

# Promo screenshots — curated capture set (README/Discourse images), fully
# obfuscated data via fixtures/promo.js (invented names, generated
# placeholder art). Not part of test:e2e; opt in with PROMO=1. Auth
# credentials, if your instance needs them, work the same as the general
# test:e2e note above.
PROMO=1 STASH_URL=http://localhost:9999 \
  npm run test:e2e:promo -- --project=promo-desktop --project=promo-mobile --workers=1
```

`test:unit` needs `npm install` (Vitest); `test:backend` runs with zero setup beyond `uv` on PATH. `test:e2e` needs a real Stash instance with the plugin built and installed — GraphQL responses are mocked for determinism, but modal lifecycle, MutationObservers, and DOM injection run against your actual `src/main.js`/`badge-injector.js`/`scene-tooltips.js`.

**E2E is never run automatically by an agent.** This is policy, not a suggestion: only one local machine runs StashApp, so an agent (or CI) invoking `test:e2e` will fail against environment assumptions that don't hold remotely. Running the e2e suite against a live Stash instance is always the user's call, done manually.

### GraphQL mocking convention (e2e)

`qa/e2e/fixtures/graphql.js` intercepts the same-origin `/graphql` route Xenith's `src/api.js` posts to. Matching is done on the **literal query body**, not the GraphQL operation name — Stash's own core UI issues queries that happen to share operation names with Xenith's (`FindPerformers`, `FindScenes`), and GraphQL operation names aren't namespaced, so name-based matching previously swallowed Stash's own requests and handed back Xenith's stripped-down fixture shape. Any request whose query body doesn't exactly match one of Xenith's own templates passes through untouched via `route.continue()`, hitting the real server instead. `qa/` is ESM (`"type": "module"` in `qa/package.json`), so the fixture `import`s its query templates directly from `src/api.js` rather than keeping its own copies — removing a class of drift where the fixture's copies silently fell behind the real queries.

## Coverage map

| Checklist item | Suite | Test |
|---|---|---|
| Reopening modal doesn't duplicate DOM/React | e2e | `reopening the modal does not duplicate...` |
| Large library — sampling, no full-table fetch | e2e | `scene battles request a capped...` |
| Shortcuts don't fire while typing in background input | e2e | `arrow/space shortcuts do not fire while an unrelated input...` |
| Undo caps at MAX_HISTORY (15) | e2e | `undo is available for at most 15 matches...` |
| Undo invalidates badge rank cache | e2e | `a completed match invalidates the badge rank cache...` |
| Rank cache TTL doesn't outlive a fresh match | e2e | same test as above |
| Badge injection survives SPA nav, no observer leaks | e2e | `navigating between performer pages...` + `routeObserver...singletons` |
| No duplicate tooltip binding on repeated hover | e2e | `scene-page performer thumbnails get a tooltip via one delegated listener...` |
| Tab state doesn't leak battleType | e2e | `switching to Leaderboard mid-scene-battle...` |
| Backend stdout is valid JSON, no stray prints | backend | `test_every_task_stdout_is_exactly_one_json_line` (parametrized, all 5 tasks) |
| Disconnect from Stash mid-match → `.hon-error` | e2e | `a failed match mutation (network drop mid-choose) surfaces .hon-error...` |
| Malformed `xenith_stats` JSON falls back to defaults | unit | `parseXenithStats — falls back to defaults on malformed JSON` |
| Closing modal fully unmounts React | e2e | `closing the modal unmounts React...` |
| `__xenithCleanup` disconnects both observers | e2e | `window.__xenithCleanup disconnects...` |
| No duplicate floating nav buttons after SPA nav (structural — React owns the nav item as a `MainNavBar.MenuItems` child) | e2e | `no duplicate #hon-floating-btn-wrapper...` |
| Wide-gap match — smoother deltas, no jarring 1-3pt drops | unit | `lossAttenuation-equivalent behavior: loss magnitude decreases monotonically...`, `favorite winning as expected is NOT attenuated...` |
| Wide-gap upset — both sides' deltas dampened | unit | `winner's gain on a wide-gap upset is attenuated by the same factor as the loser's loss...` |
| Match cooldown — no reappearance within session, Performers/Scenes don't cross-contaminate | unit | `regression: a performer id and a scene id with the same numeric value don't collide`, plus integration: `a performer just matched doesn't reappear as a candidate...`, `switching Performers <-> Scenes mid-session doesn't cross-contaminate...` |
| Leaderboard/badge/tooltip rank ordering — lucky 1-match doesn't outrank a veteran | unit | `compositeScore: XENITH.md §4.3 worked example — fresh 1-match winner vs. 40-match veteran` |
| S-tier badge — rare, only near the ceiling | script | `qa/scripts/simulate-tier-bounds.mjs` (Monte Carlo; ~3.0-3.6% ceiling occupancy, see `src/elo.js`'s `TIER_BOUNDS` comment) + `getRatingTier boundaries match TIER_BOUNDS tier table` |
| Extended session in one tier — not repetitive, surfaces other tiers | unit (integration) | `extended session in a C/D-heavy pool occasionally surfaces performers from other tiers...`, `extended session doesn't get stuck repeating the same few faces...` |
| Gauntlet posterior stays normalized, recovers from an unlucky early loss, terminates within `[MIN_MATCHES, MAX_MATCHES]` | unit | `gauntlet.test.mjs` — `posterior stays normalized after every update`, `a surprising first-probe loss doesn't cap the final placement`, `a run terminates within [MIN_MATCHES, MAX_MATCHES]` |
| Champion reign increments/resets defenses correctly, retires at `MAX_DEFENSES` | unit | `champion.test.mjs` — `a challenger win re-roots the reign at the challenger, resetting defenses`, `reaching MAX_DEFENSES retires the reign (returns null)` |
| Session log caps at 200 entries, undo annotates in place by `seq` (not tail position) | unit | `session-log.test.mjs` — `caps at 200 entries, dropping the oldest`, `markSessionMatchUndone flags the matching entry, even when it isn't the tail` |
| Card chip allowlist excludes negative free-text fields, tag sort order, fixed-line-budget fit math | unit | `card-chips.test.mjs` — `excluded fields never leak into a chip's text`, `sorts by performer_count descending`, `planChipFit` describe block |
| Leaderboard page size resolves from a responsive default, clamps a hostile override, derives desktop at 5x | unit | `leaderboard-pagination.test.mjs` — `unset/undefined override falls back to the responsive default`, `a hostile override is clamped before the desktop multiply` |
| Leaderboard page index stays anchored near the same first row when page size changes | unit | `leaderboard-pagination.test.mjs` — `crossing to a larger/smaller page size lands near the same first-row index` |
| Leaderboard column widths are driven by the longest rendered value (not header, not row order), name column keeps its fixed floor | unit | `leaderboard-columns.test.mjs` — `width is driven by the longest value, not the first row`, `name column always gets the fixed floor`, `result is independent of row order` |
| No `src/` comment cites a rot-prone line number (`file.ext:NN`) — permanent comments cite `file:symbol` instead | unit | `doc-conventions.test.mjs` — `every src/ file is free of file.ext:NN style citations` |

Plus backend correctness beyond the original checklist's scope: Wipe's exact field removal, Reset's null, Export's JSON shape, Import's unmatched-name skip and most-recent-file selection.

The integration tests (`unit/matchmaking-integration.test.mjs`) mock `src/api.js`'s `gql()` via Vitest's `vi.mock()` and drive `selectWeightedPair` through 40-150 match sessions against an in-memory tier-heavy pool — exercising the real seed/opponent weighting and cooldown logic end to end, not just the pure helper functions in isolation.

Still genuinely manual: whether a delta "feels" smooth/jarring is a subjective visual judgment no test can substitute for — the unit tests above confirm the underlying math is monotonic and bounded, not how it reads on screen.

## What's deliberately not automated

- Visual polish (glow/desaturation on win-loss, delta badge animation) — eyeball it once per release, not worth a screenshot-diff pipeline for a personal plugin.
- CDP-level event-listener counting for the tooltip dedup check — flaky across Chrome versions. `scene-tooltips.js` dedupes via a single delegated `mouseover` listener on `document.body` (idempotent `setupSceneTooltips`, no per-node bound flag), so the e2e assertion (`scene-page performer thumbnails get a tooltip via one delegated listener...`) checks tooltip content stays correct across repeated hovers/re-renders instead of counting listeners directly.
- Live-engine calibration health — `qa/scripts/diagnose-snapshot.mjs` is a manual investigation tool, not part of `test:unit`/`test:backend`/CI. Run it against a real snapshot export (`node qa/scripts/diagnose-snapshot.mjs "snapshots/<file>.json"`) to check predicted-vs-observed win rate on your own library's recorded matches — a model-free complement to `simulate-tier-bounds.mjs`'s simulated-population calibration, see the script's own header comment.

## Checks that stay hands-on

The rest of the QA scope is covered above. What's left is genuinely not automatable — subjective judgment calls or one-time precautions, not a second testing phase. Scope: Performer/Scene battles, Head-to-Head, Leaderboard, badge injection, backend tasks, sidebar, scene tooltips — the only two battle types are Performers and Scenes (`src/state.js`'s `battleType`); nothing else exists to test.

### Backend Tasks (run each from Stash's Task Manager UI)

**Reset + Wipe cycle after a formula change.** Any change to the K-factor, D-scale, attenuation, or `TIER_BOUNDS` formulas in `src/elo.js` reshuffles how existing ratings should be interpreted — don't let that happen silently against live data. Run **Reset Ratings** then **Wipe Match History** manually from Stash's Task Manager UI after such a change lands: Reset nulls `rating100` back to the implicit `DEFAULT_RATING` (50) every code path already assumes, and Wipe clears `xenith_stats`/`xenith_record` so stale match counts don't keep driving K-factor and the composite score's uncertainty discount for a rating that no longer means what it used to. This is a one-time step tied to the change, not a recurring maintenance task.

### Rating engine

- [ ] Wide-gap match (~40+ pt rating difference) — winner/loser deltas feel smoother than the old hard-cap behavior, no jarring 1-3pt drops on expected wins
- [ ] Wide-gap upset (lower-rated performer wins against a 40+ pt favorite) — both sides' deltas are visibly dampened relative to a close match, neither delta swings wildly
- [ ] A performer/scene just matched doesn't reappear as a candidate again within the same session until ~10 other matches have happened (20-entry FIFO cooldown, split per battle type — confirm switching Performers ↔ Scenes mid-session doesn't cross-contaminate cooldown)
- [ ] Leaderboard/badge/tooltip rank ordering still looks sane after a Reset + a batch of matches — a lucky 1-match performer shouldn't outrank an established veteran with a similar raw rating (display-rating uncertainty buffer)
- [ ] S-tier badge — expect it to appear rarely and only at the very top of the rating scale (~3.0-3.6% ceiling occupancy by design — see `src/elo.js`'s `TIER_BOUNDS` comment / `XENITH.md` §5)
- [ ] Play an extended session (30+ matches) in one tier-heavy area (e.g. mostly C/D performers) — confirm the pool doesn't feel repetitive/stuck on the same few faces, and occasionally surfaces performers from other tiers (entropy weighting)
