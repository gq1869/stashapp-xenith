# Xenith

Elo-based head-to-head ranking and leaderboard plugin for Stash. Rate performers and scenes by choosing winners in head-to-head matchups; ratings settle into a six-tier system (S through F) that reflects relative appeal rather than absolute scores.

Requires Stash v0.31+.

## Features

- **Head-to-Head** — performers and scenes both run the same entropy-weighted matchmaking pipeline (prioritizes the most informative pairing, plus a low-match cold-start boost). Keyboard shortcuts: arrows to choose, space to skip, Ctrl+Z to undo (double-tap ↑/↓ also work as undo/skip)
- **Gauntlet mode** — place one challenger against the ladder over a short run of matches, converging on its rank via a Bayesian posterior rather than drifting there over hundreds of random pairings
- **Champion mode** — an incumbent defends its spot against a stream of challengers for as long as it keeps winning, up to a capped reign
- **Leaderboard** — sortable, filterable by tier, paginated, shows composite score alongside raw rating. Covers both performers and scenes
- **Match Stats** — pool-wide records page (best streaks, most matches, etc.), both battle types
- **Match Log** — session-scoped list of every match played this session, both battle types
- **Battle rank badges** — injected on performer and scene detail pages and cards, shows rank + W/L/streak; the detail-page badge also has an expandable match-history drawer (last 10 matches, opponent links, rating deltas)
- **Performer thumbnail tooltips** — hover any performer's image (including on scene pages) to see their rank
- **Curated metadata chips** — h2h and Gauntlet-preview cards, both performers and scenes, show a fixed-budget row of chips (age, height/weight, tags, etc. for performers; resolution, duration, tags, etc. for scenes), individually hideable via a setting
- **Sidebar nav toggle** — switch between battle types, match modes, and views without leaving the modal

Snapshot export/import (for backing up and restoring rating history) is available as a maintenance task — see below.

## Screenshots

All screenshots below use generated placeholder art and invented names — no real library content.

<p>
  <img src="docs/images/head-to-head.png" alt="Head-to-head matchup" width="49%">
  <img src="docs/images/leaderboard.png" alt="Leaderboard with tier distribution" width="49%">
</p>
<p>
  <img src="docs/images/gauntlet.png" alt="Gauntlet mode mid-run" width="49%">
  <img src="docs/images/champion.png" alt="Champion mode defending a reign" width="49%">
</p>
<p>
  <img src="docs/images/match-stats.png" alt="Pool-wide match stats" width="49%">
  <img src="docs/images/rank-badge.png" alt="Detail-page rank badge with match history expanded" width="49%">
</p>
<p>
  <img src="docs/images/mobile-head-to-head.png" alt="Mobile head-to-head view" width="32%">
  <img src="docs/images/mobile-swipe.png" alt="Mobile swipe gesture mid-drag" width="32%">
</p>

## Installation

**Prerequisite, all paths:** Xenith's backend needs `stashapp-tools`. Stash doesn't install Python deps for you, so run `pip install -r requirements.txt` (or `pip install stashapp-tools`) once, regardless of which install method you use below.

### A. In-app (recommended)

1. Settings → Plugins → Available Plugins → Add Source, and add:
   `https://gq1869.github.io/stashapp-xenith/stable/index.yml`
2. Find Xenith under Available Plugins and click Install — this installs a prebuilt bundle straight into your Stash `plugins/` directory, no manual build step
3. Install backend deps (see prerequisite above)
4. Future updates show up in the same Available Plugins list

### B. Release zip

1. Download `xenith.zip` from this repo's Releases page (ships a prebuilt `dist/`) and unzip it into your Stash `plugins/` directory
2. Install backend deps (see prerequisite above)
3. Reload plugins in Stash (Settings → Plugins → Reload Plugins)

### C. Clone + build (development)

1. Clone this repo into your Stash `plugins/` directory
2. Install backend deps (see prerequisite above)
3. `npm install && npm run build` — `dist/` is gitignored, so this step is required when cloning
4. Reload plugins in Stash (Settings → Plugins → Reload Plugins)

## Usage

Click the Xenith button in the nav bar to open the ranking modal. Choose a battle type (Performers or Scenes) from the sidebar, then start comparing. Ratings update live using a single-pass Elo calculation (`src/elo.js`) — dynamic, library-size-scaled K-factor and a single non-linear attenuation formula that smooths wide-gap upsets, rather than a hard-capped multiplier.

### Maintenance tasks (Settings → Tasks → Xenith)

- **Wipe Match History** — clears Xenith custom fields on performers and scenes, keeps ratings. Also available as performers-only/scenes-only variants
- **Reset Ratings** — nulls all performer and scene ratings. Also available as performers-only/scenes-only variants
- **Export Snapshot** — writes a timestamped JSON snapshot of ratings + history to `snapshots/`
- **Import Latest Snapshot** — restores from the most recent snapshot file. Performers are matched by name (unmatched or ambiguous names are skipped); scenes are only imported if the snapshot's `database_path` matches the current Stash database, since scene IDs aren't stable across databases
- **Migrate Legacy Field Names** — one-time migration from the original HotOrNot-era custom-field names to Xenith's own; safe to re-run, takes its own pre-migration snapshot first

## Settings

- **Hide Xenith Rank Badge** — suppresses the rank badge on performer/scene pages/cards, restores default Stash rating display
- **Leaderboard Rows Per Page (Mobile)** — rows per leaderboard page on mobile; desktop always renders 5x this value. Leave at 0 for automatic sizing
- **Use Customary Units** — show height/weight in feet/inches and pounds instead of centimeters/kilograms. Off by default
- **Hidden Performer Card Chips** — comma-separated list of h2h performer card chips to hide (e.g. `measurements, piercings`); blank shows all
- **Hidden Scene Card Chips** — comma-separated list of h2h scene card chips to hide (e.g. `video_codec, bit_rate`); blank shows all

## Development

Stack: React 17.0.2 (legacy API via `window.PluginApi.React`/`ReactDOM`), Vite, Python backend on `stashapi.stashapp.StashInterface`.

```
npm run build   # bundle src/main.js -> dist/xenith.js
npm run watch   # rebuild on change
```

Frontend entry is `src/main.js`; components live in `src/components/`. Backend entry is `backend/main.py`, tasks in `backend/tasks.py`. `src/elo.js` is the single source of truth for rating math — don't re-derive K-factor or composite score elsewhere.

## Acknowledgments

Xenith is part of the Elo/head-to-head ranking plugin family for Stash. It draws on ideas from these earlier plugins in the same lineage:

- [Stash Battle](https://github.com/dtt-git/stash-battle/tree/main/plugins/stash-battle)
- [HotOrNot](https://github.com/lowgrade12/hot-or-not/tree/main/plugins/hotornot)
- [HotOrNotV2](https://github.com/lowgrade12/hot-or-not/tree/main/plugins/hotOrNotV2)
- [HotOrNot_V3](https://github.com/Lurking987/stash-plugins/tree/main/plugins/hot_or_not)
- [Ascension](https://github.com/Servbot91/Sakotos-Stash-Repo/tree/main/plugins/Ascension) ([white paper](https://github.com/Servbot91/Sakotos-Stash-Repo/blob/main/plugins/Ascension/Documentation/White%20Paper.md))

## License

MIT — see LICENSE.
