// Model-free health check for a Xenith snapshot export. Unlike
// simulate-tier-bounds.mjs, this makes no assumption about the population's
// hidden true-skill distribution — it only asks whether the rating math
// (src/elo.js's expectedScore, D=35) is well-calibrated against the outcomes
// actually recorded, by reconstructing matches from xenith_record (falling
// back to the legacy performer_record key on an un-migrated snapshot) and
// checking predicted-vs-observed win rate directly. That sidesteps the
// failure mode a skill-model sim can't: an invented skill distribution can
// make a perfectly-tuned system look broken, or a broken one look fine,
// depending entirely on the (unverifiable) assumption fed in. A model-free
// check against real recorded outcomes is the only way to confirm
// calibration holds on an actual library, not just the simulated
// population `simulate-tier-bounds.mjs` calibrates against — run this
// periodically as the library grows rather than trusting the sim alone.
//
// Usage: node qa/scripts/diagnose-snapshot.mjs "snapshots/<file>.json"
// Not part of dist, npm test, or CI — a manual investigation tool, run
// against whichever snapshot is newest when you want a read on engine
// health.

import { readFileSync } from "node:fs";
import { expectedScore, getRatingTier } from "../../src/elo.js";

const CODE_D = 35; // must match the divisor hardcoded in expectedScore

const path = process.argv[2];
if (!path) {
  console.error("Usage: node qa/scripts/diagnose-snapshot.mjs <snapshot.json>");
  process.exit(1);
}

const snapshot = JSON.parse(readFileSync(path, "utf8"));
const performers = snapshot.performers ?? [];

// --- Reconstruct one row per logged rating update: (ratingBefore, matchCount) ---
const updates = [];
for (const p of performers) {
  // Snapshot may predate the xenith_ field-name migration — fall back
  // to the legacy key so this script still works on older exports.
  const recordRaw = p.custom_fields?.xenith_record ?? p.custom_fields?.performer_record;
  if (!recordRaw) continue;
  let record;
  try {
    record = JSON.parse(recordRaw);
  } catch {
    continue;
  }
  let before = 50; // DEFAULT_RATING; matches src/elo.js's fallback
  let matchIdx = 0;
  for (const entry of record) {
    if (entry.ratingAfter == null) continue;
    updates.push({
      id: p.id,
      opponentId: String(entry.opponent).split(":")[0],
      date: entry.date,
      before,
      after: entry.ratingAfter,
      won: entry.won,
      matchIdx,
    });
    before = entry.ratingAfter;
    matchIdx += 1;
  }
}

// --- Pair updates into matches by (date, opponent) ---
const byDate = new Map();
for (const u of updates) {
  if (!byDate.has(u.date)) byDate.set(u.date, []);
  byDate.get(u.date).push(u);
}

const matches = []; // { ratingA, ratingB, aWon }
for (const [, entries] of byDate) {
  if (entries.length !== 2) continue; // skip anything that doesn't cleanly pair
  const [a, b] = entries;
  if (a.opponentId !== b.id || b.opponentId !== a.id) continue;
  if (a.won === b.won) continue; // skip draws / inconsistent logs
  matches.push({ ratingA: a.before, ratingB: b.before, aWon: a.won });
}

console.log(`Snapshot: ${path}`);
console.log(`Performers: ${performers.length}, rating updates logged: ${updates.length}`);
console.log(`Reconstructed decisive matches (both sides logged, non-draw): ${matches.length}\n`);

if (matches.length < 30) {
  console.log("Too few reconstructed matches for a meaningful calibration read. Stopping.");
  process.exit(0);
}

// --- Calibration table: bucket by the favorite's predicted win probability ---
const buckets = new Map(); // bucketKey -> [n, wins]
for (const { ratingA, ratingB, aWon } of matches) {
  const favIsA = ratingA >= ratingB;
  const pFav = favIsA ? expectedScore(ratingA, ratingB) : expectedScore(ratingB, ratingA);
  const favWon = favIsA ? aWon : !aWon;
  const key = Math.round(pFav * 20) / 20;
  if (!buckets.has(key)) buckets.set(key, [0, 0]);
  const b = buckets.get(key);
  b[0] += 1;
  b[1] += favWon ? 1 : 0;
}

console.log("Calibration (favorite side, D=%d expectedScore):", CODE_D);
console.log("  predicted     n  observed    error");
let weightedErr = 0;
let totalN = 0;
for (const key of [...buckets.keys()].sort((a, b) => a - b)) {
  const [n, wins] = buckets.get(key);
  if (n < 20) continue; // too sparse to report
  const observed = wins / n;
  const err = observed - key;
  weightedErr += Math.abs(err) * n;
  totalN += n;
  console.log(
    `    ${key.toFixed(2).padStart(6)}  ${n.toString().padStart(5)}  ${observed.toFixed(3).padStart(8)}  ${(err >= 0 ? "+" : "") + err.toFixed(3)}`
  );
}
console.log(`  weighted mean |calibration error| = ${(weightedErr / totalN).toFixed(3)}\n`);

// --- Max-likelihood D fit ---
function logLik(D) {
  let ll = 0;
  for (const { ratingA, ratingB, aWon } of matches) {
    const p = Math.min(Math.max(expectedScore(ratingA, ratingB, D), 1e-9), 1 - 1e-9);
    ll += aWon ? Math.log(p) : Math.log(1 - p);
  }
  return ll;
}
// expectedScore doesn't take D as a param in src/elo.js (D=35 is baked in),
// so fit it directly here with the same logistic form for comparison only —
// this is a read-only diagnostic, not a second implementation callers use.
function expectedScoreD(a, b, D) {
  return 1 / (1 + Math.pow(10, (b - a) / D));
}
function logLikD(D) {
  let ll = 0;
  for (const { ratingA, ratingB, aWon } of matches) {
    const p = Math.min(Math.max(expectedScoreD(ratingA, ratingB, D), 1e-9), 1 - 1e-9);
    ll += aWon ? Math.log(p) : Math.log(1 - p);
  }
  return ll;
}
let bestD = null;
let bestLL = -Infinity;
for (let D = 5; D <= 300; D += 1) {
  const ll = logLikD(D);
  if (ll > bestLL) {
    bestLL = ll;
    bestD = D;
  }
}
const drift = (((bestD - CODE_D) / CODE_D) * 100).toFixed(1);
console.log(`Max-likelihood D fitted from production matches: ${bestD}  (code uses D=${CODE_D}, drift ${drift >= 0 ? "+" : ""}${drift}%)`);
console.log(
  "Decision rule: if fitted D drifts past +/-15% of the code constant at >=20 avg matches/performer,\n" +
    "ratings are mis-spread and K-factor bounds should be revisited. Within that band, leave K alone.\n"
);

// --- Rating distribution / boundary occupancy / tiers ---
const rated = performers
  .map((p) => p.rating100)
  .filter((r) => r != null);
const matchCounts = performers.map((p) => {
  const raw = p.custom_fields?.xenith_stats ?? p.custom_fields?.hotornot_stats;
  if (!raw) return 0;
  try {
    return JSON.parse(raw).total_matches ?? 0;
  } catch {
    return 0;
  }
});
const played = matchCounts.filter((m) => m > 0);
const avgMatches = played.length ? played.reduce((a, b) => a + b, 0) / played.length : 0;

const deciles = new Array(10).fill(0);
for (const r of rated) deciles[Math.min(Math.floor(r / 10), 9)] += 1;

const atCeiling = rated.filter((r) => r === 100).length;
const atFloor = rated.filter((r) => r === 0).length;

const tierCounts = {};
for (const r of rated) {
  const t = getRatingTier(r);
  tierCounts[t] = (tierCounts[t] ?? 0) + 1;
}

console.log(`Avg matches/performer: ${avgMatches.toFixed(1)}`);
console.log(`Rating deciles (0-9..90-99): [${deciles.join(", ")}]`);
console.log(`@100: ${atCeiling} (${((atCeiling / rated.length) * 100).toFixed(1)}%)   @0: ${atFloor} (${((atFloor / rated.length) * 100).toFixed(1)}%)`);
console.log(
  "Tiers: " +
    ["S", "A", "B", "C", "D", "F"]
      .map((t) => `${t}=${(((tierCounts[t] ?? 0) / rated.length) * 100).toFixed(1)}%`)
      .join("  ")
);

// --- Per-match rating movement ---
const deltas = updates.map((u) => Math.abs(u.after - u.before));
const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
const sorted = [...deltas].sort((a, b) => a - b);
const median = sorted[Math.floor(sorted.length / 2)];
console.log(`\nMean |Δrating| per logged update: ${mean.toFixed(1)}   median: ${median}`);
