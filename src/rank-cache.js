// Shared, 60s-TTL cache of the full ranked ordering (id/rank/tier/
// composite/record), one cache per battle type (`getRankedItems(battleType)`).
// Backs useLeaderboard.js, badge-injector.js/scene-tooltips.js,
// matchmaking.js's Gauntlet ladder, match-stats.js, and BattleRankBadge.jsx's
// detail-page history drawer (`record` is the whole reason it's cached here
// rather than fetched separately) — so they don't each independently
// fetch and re-derive rank. `invalidateRankCache()` is called after every
// committed match.
import { gql, FIND_PERFORMERS_RANK, FIND_SCENES_RANK } from "./api";
import { compositeScore, getRatingTier, DEFAULT_RATING } from "./elo";
import { parseXenithStats, parseRecord } from "./matchmaking";
import { displayName } from "./format";

// Same 60s TTL badge-injector.js used before this module existed: ratings
// only change after a match (which calls invalidateRankCache directly), but
// callers re-trigger this path on DOM mutations or hover, so a bit of
// staleness tolerance avoids refetching.
const CACHE_TTL_MS = 60000;

// One cache per battle type — mirrors matchmaking.js's systemConfigCache
// shape/rationale (Performers and Scenes are separate pools with
// independent staleness). Each entry stores the in-flight *promise*, not
// just the resolved rows, so concurrent callers before resolution (e.g.
// hovering five cards on a cold cache) share one request instead of each
// firing their own full-library query.
/** @type {{ performers: { rows: any[] | null, timestamp: number, pending: Promise<any[]> | null }, scenes: { rows: any[] | null, timestamp: number, pending: Promise<any[]> | null } }} */
const caches = {
  performers: { rows: null, timestamp: 0, pending: null },
  scenes: { rows: null, timestamp: 0, pending: null },
};

function cacheKey(battleType) {
  return battleType === "scenes" ? "scenes" : "performers";
}

// No-arg, clears both — a vote in either battle type has historically
// invalidated the single shared cache this module used to have, and
// scoping invalidation to just the voted-on type would leave a stale
// leaderboard visible after an undo in the *other* type mid-session.
export function invalidateRankCache() {
  caches.performers.rows = null;
  caches.performers.timestamp = 0;
  caches.performers.pending = null;
  caches.scenes.rows = null;
  caches.scenes.timestamp = 0;
  caches.scenes.pending = null;
}

/** @param {"performers" | "scenes"} battleType */
export async function getRankedItems(battleType) {
  const key = cacheKey(battleType);
  const entry = caches[key];
  const now = Date.now();
  if (entry.rows && now - entry.timestamp < CACHE_TTL_MS) return entry.rows;
  if (entry.pending) return entry.pending;

  const isScenes = key === "scenes";

  entry.pending = (async () => {
    const data = isScenes
      ? await gql(FIND_SCENES_RANK, { filter: { per_page: -1 } })
      : await gql(FIND_PERFORMERS_RANK, { performer_filter: {}, filter: { per_page: -1 } });
    const raw = isScenes ? data.findScenes.scenes : data.findPerformers.performers;

    const items = raw.map((p) => {
      const stats = parseXenithStats(p);
      return {
        ...p,
        // Scenes carry `title`, not `name` — normalized here via the shared
        // displayName() (src/format.js) so Leaderboard.jsx/match-stats.js can
        // render `row.name` unconditionally for either battle type. Falls
        // back to an id-based label rather than leaving an untitled scene
        // blank in the table.
        name: displayName(p),
        stats,
        record: parseRecord(p),
        tier: getRatingTier(p.rating100 ?? DEFAULT_RATING),
        composite: compositeScore({ rating100: p.rating100, matchCount: stats.total_matches }),
      };
    });
    items.sort((a, b) => b.composite - a.composite);
    items.forEach((p, i) => (p.rank = i + 1));

    entry.rows = items;
    entry.timestamp = Date.now();
    return items;
  })();

  try {
    return await entry.pending;
  } finally {
    entry.pending = null;
  }
}

