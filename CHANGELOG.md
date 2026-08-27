# Changelog

All notable Xenith releases are documented here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## 3.0.0

Xenith is an Elo-based head-to-head ranking and leaderboard plugin for [Stash](https://github.com/stashapp/stash). Rate performers and scenes by choosing winners in head-to-head matchups; ratings settle into a six-tier system (S through F) that reflects relative appeal rather than absolute scores. Requires Stash v0.31+.

This is Xenith's first public release.

### Why 3.0.0

Xenith is part of a lineage of Elo/head-to-head ranking plugins for Stash: [HotOrNot](https://github.com/lowgrade12/hot-or-not) came first, then [Ascension](https://github.com/Servbot91/Sakotos-Stash-Repo/tree/main/plugins/Ascension) raised the bar on features. Xenith is the third generation — same lineage, rebuilt with a sharper focus on the rating math and a leaner, modular implementation. The size difference shows up directly in what ships:

| | Xenith | Ascension |
| --- | --- | --- |
| Frontend bundle | 81.5 KB JS + 34.8 KB CSS (minified) | 483 KB JS + 116 KB CSS (unminified) |
| Frontend source | ~9,600 lines across 38 files | ~18,000 lines across 3 files |
| Backend | ~460 lines Python | ~600 lines Python |

(Xenith's bundle figures are minified; Ascension's aren't, so the payload gap overstates things somewhat — the source line/file-count comparison is the fairer read on maintainability.)

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
