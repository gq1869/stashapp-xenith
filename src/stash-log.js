// Batched flush of match-result lines to Stash's server-side debug log, via
// runPluginOperation -> backend/tasks.py's handle_log_operation. Buffered
// client-side rather than one call per match, so a fast voting session
// doesn't spawn one Python subprocess and one queued Stash job per vote.
//
// Logging must never be able to break a vote: every path here is
// fire-and-forget and every rejection is swallowed.

import { gqlMutate, RUN_PLUGIN_OPERATION } from "./api";

const FLUSH_AT = 10;
const FLUSH_IDLE_MS = 5000;

/** @type {string[]} */
let buffer = [];
/** @type {ReturnType<typeof setTimeout> | null} */
let idleTimer = null;

function clearIdleTimer() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

/** @param {string} line */
export function queueStashLog(line) {
  buffer.push(line);

  // No separate max-buffer cap needed: the buffer is drained synchronously
  // below on every flush, independent of whether the network request that
  // follows succeeds — so it can never hold more than FLUSH_AT - 1 lines
  // between flushes, failed or not.
  if (buffer.length >= FLUSH_AT) {
    flushStashLog();
    return;
  }
  clearIdleTimer();
  idleTimer = setTimeout(flushStashLog, FLUSH_IDLE_MS);
}

export function flushStashLog() {
  clearIdleTimer();
  if (buffer.length === 0) return;
  // Drain before awaiting, not after — a failed flush shouldn't re-send the
  // same lines on the next attempt. Debug logging is best-effort: silent
  // loss beats duplicate spam.
  const lines = buffer;
  buffer = [];
  gqlMutate(RUN_PLUGIN_OPERATION, {
    plugin_id: "xenith",
    args: { mode: "log", level: "debug", lines },
  }).catch(() => {});
}
