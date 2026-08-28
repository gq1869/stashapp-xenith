# Changelog

All notable Xenith releases are documented here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## 3.0.0

Xenith is an Elo-based head-to-head ranking and leaderboard plugin for [Stash](https://github.com/stashapp/stash). Rate performers and scenes by choosing winners in head-to-head matchups; ratings settle into a six-tier system (S through F) that reflects relative appeal rather than absolute scores. Requires Stash v0.31+.

This is Xenith's first public release.

### Why 3.0.0

Xenith is part of a lineage of Elo/head-to-head ranking plugins for Stash — [HotOrNot](https://github.com/lowgrade12/hot-or-not) came first, and later plugins in the family built on those ideas. Xenith is a from-scratch rebuild in that same spirit, with its own take on the rating math and a modular implementation (~9,600 lines across 38 source files, an 81.5 KB JS + 34.8 KB CSS minified bundle).

A few of the underlying design choices:

- **New items start neutral.** An unrated item seeds at 50/100 — the middle of the scale — so its first few matches can move it in either direction rather than only upward.
- **K-factor scales with library size.** The K-factor bounds grow with pool size, rather than staying fixed regardless of whether the library has 100 items or 100,000.
- **Gauntlet mode is a Bayesian posterior over ladder position, not a climb/fall bracket.** Every match is treated as evidence updating a posterior, so one unlucky early loss doesn't cap the final placement.
- **One unified attenuation formula.** A single non-linear attenuation applies symmetrically to both sides of an upset, rather than several separate multipliers/dampeners layered on top of each other — attenuation itself can't create net rating inflation across the pool.
- **Fixed, calibrated tier bounds.** Tier cutoffs are calibrated once against the rating math (via Monte Carlo simulation) and held constant, so the same rating always maps to the same tier regardless of how the library's distribution shifts over time.

Size aside, a few of the underlying design decisions differ from Ascension too:

- **New items start neutral, not at the bottom.** Xenith seeds an unrated item at 50/100 — the middle of the scale — so its first few matches can move it either direction. Ascension seeds new items at 1/100, presuming an unrated item is bad until proven otherwise.
- **Library-scaled K-factor, not a fixed per-mode cap.** Xenith's K-factor bounds grow with pool size; Ascension hardcodes the same range regardless of whether the library has 100 items or 100,000.
- **Gauntlet mode is a Bayesian posterior, not a climb/fall ladder.** Ascension's gauntlet is a literal climb-until-you-lose structure. Xenith treats every match as evidence updating a posterior over ladder position, so one unlucky early loss doesn't cap the final placement.
- **One unified attenuation formula, not several stacked ones.** Ascension layers an underdog multiplier, a separate loss-protection curve, and mode-specific win-streak dampeners (gauntlet, champion) on top of each other. Xenith uses a single non-linear attenuation applied symmetrically to both sides of an upset, so attenuation itself can't create net rating inflation across the pool.
- **Fixed, calibrated tier bounds, not live percentile brackets.** Xenith's tier cutoffs are calibrated once against the rating math and held constant. Ascension recomputes tier boundaries from the pool's current percentile distribution, so the same rating can shift tiers as the library grows even though the item itself didn't get better or worse.

### What's in it

- Three match modes: classic Swiss-style head-to-head, Gauntlet (place one challenger against the ladder via a Bayesian posterior), and Champion (an incumbent defends against a stream of challengers)
- Both performers and scenes, across every mode and view
- Sortable, filterable, paginated leaderboard with composite score alongside raw rating
- Pool-wide match stats and a session-scoped match log
- Rank badges on performer/scene pages and cards, with an expandable match-history drawer
- Hover tooltips showing rank on performer thumbnails
- Curated, individually hideable metadata chips on comparison cards
- Snapshot export/import for backing up and restoring rating history

### Rating model

Ratings live on a 0-100 scale. Expected score uses a compressed D=35 scale (vs. standard Elo's D=400) so a 10-point gap yields ~67% expected win probability. K-factor is dynamic, scaled to library size and decaying as an item accumulates matches. A single non-linear attenuation formula smooths wide-gap upsets — no separate underdog multiplier or tier dampening layered on top. Display rating (used for leaderboard sort and badge rank) is a composite score that discounts for uncertainty, so a lucky low-match win doesn't outrank an established veteran; tier assignment stays on raw rating. See this repo's design doc for the full derivations and calibration methodology.

### Install

**Prerequisite, all paths:** install `stashapp-tools` (`pip install -r requirements.txt`, or `pip install stashapp-tools`).

- **In-app (recommended):** Settings → Plugins → Available Plugins → Add Source, add this repo's Pages installer index, then install Xenith from the Available Plugins list.
- **Release zip:** download `xenith.zip` from this release, unzip into your Stash `plugins/` directory, reload plugins.
- **Clone + build:** clone into `plugins/`, `npm install && npm run build`, reload plugins.
