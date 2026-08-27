// Match Log page's data source — every match/skip played this session,
// across both battle types. Distinct from matchmaking.js's xenith_record:
// that store lives per-item in custom_fields, capped at MAX_RECORD_ENTRIES
// entries each; this is a single session-scoped array (dies on page reload)
// backing src/components/MatchLog.jsx and, via formatMatchLine below,
// src/stash-log.js's batched Stash debug log.

import { persisted } from "./state";

const MAX_SESSION_LOG = 200;

/**
 * @typedef {{
 *   ts: string,
 *   battleType: "performers" | "scenes",
 *   kind: "win" | "draw",
 *   a: { id: string, name: string, ratingBefore: number, ratingAfter: number },
 *   b: { id: string, name: string, ratingBefore: number, ratingAfter: number },
 *   seq?: number,
 *   undone?: boolean,
 * }} SessionLogEntry
 */

// Mutated in place (push/pop/splice), not reassigned — same pattern
// matchmaking.js's pushToRecentMatchBuffer/isInRecentMatchBuffer use for
// persisted's other array fields, since TS infers an empty-array-literal
// property as never[] and rejects a whole-array reassignment.

// Monotonic id stamped onto every entry so undo can target the exact row it
// came from (markSessionMatchUndone below) instead of assuming the entry
// being undone is still at the tail — the Match Log page's Clear button can
// empty the array while usePair.js's own undo history still holds older
// entries, so position alone isn't a safe handle.
let nextSeq = 1;

/**
 * @param {SessionLogEntry} entry
 * @returns {number} the seq stamped onto the stored entry
 */
export function appendSessionMatch(entry) {
  const log = /** @type {SessionLogEntry[]} */ (persisted.sessionLog);
  entry.seq = nextSeq++;
  log.push(entry);
  if (log.length > MAX_SESSION_LOG) log.shift();
  return entry.seq;
}

/**
 * Flags the entry with the given seq as undone, in place, rather than
 * removing it — an undone match should stay visible in its original
 * chronological slot (see MatchLog.jsx), not vanish as if it never happened.
 * @param {number} seq
 * @returns {SessionLogEntry | undefined} the entry, or undefined if it's
 *   already gone (aged out past MAX_SESSION_LOG, or cleared)
 */
export function markSessionMatchUndone(seq) {
  const log = /** @type {SessionLogEntry[]} */ (persisted.sessionLog);
  const entry = log.find((e) => e.seq === seq);
  if (entry) entry.undone = true;
  return entry;
}

/** @returns {SessionLogEntry[]} */
export function getSessionLog() {
  return /** @type {SessionLogEntry[]} */ (persisted.sessionLog);
}

export function clearSessionLog() {
  const log = /** @type {SessionLogEntry[]} */ (persisted.sessionLog);
  log.length = 0;
}

/** @param {SessionLogEntry} entry */
export function formatMatchLine(entry) {
  const { a, b, kind, battleType } = entry;
  const aStr = `${a.name} (${a.ratingBefore} -> ${a.ratingAfter})`;
  const bStr = `${b.name} (${b.ratingBefore} -> ${b.ratingAfter})`;
  const prefix = `[${battleType}] `;
  return kind === "win" ? `${prefix}match: ${aStr} def. ${bStr}` : `${prefix}skip: ${aStr} vs ${bStr}`;
}

/** @param {SessionLogEntry} entry */
export function formatUndoLine(entry) {
  return `undo: ${formatMatchLine(entry)}`;
}
