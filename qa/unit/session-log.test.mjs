import { test, describe, beforeEach } from "vitest";
import assert from "node:assert/strict";

import {
  appendSessionMatch,
  markSessionMatchUndone,
  getSessionLog,
  clearSessionLog,
  formatMatchLine,
  formatUndoLine,
} from "../../src/session-log.js";

function winEntry(overrides = {}) {
  return {
    ts: "2026-08-22T18:42:00.000Z",
    battleType: "performers",
    kind: "win",
    a: { id: "1", name: "Jane Doe", ratingBefore: 62, ratingAfter: 65 },
    b: { id: "2", name: "Alex Rivera", ratingBefore: 58, ratingAfter: 55 },
    ...overrides,
  };
}

function drawEntry(overrides = {}) {
  return {
    ts: "2026-08-22T18:45:00.000Z",
    battleType: "scenes",
    kind: "draw",
    a: { id: "10", name: "Scene A", ratingBefore: 60, ratingAfter: 60 },
    b: { id: "11", name: "Scene B", ratingBefore: 61, ratingAfter: 61 },
    ...overrides,
  };
}

describe("session-log", () => {
  beforeEach(() => {
    clearSessionLog();
  });

  test("getSessionLog is empty until something is appended", () => {
    assert.deepEqual(getSessionLog(), []);
  });

  test("appendSessionMatch pushes in order", () => {
    const e1 = winEntry();
    const e2 = drawEntry();
    appendSessionMatch(e1);
    appendSessionMatch(e2);
    assert.deepEqual(getSessionLog(), [e1, e2]);
  });

  test("caps at 200 entries, dropping the oldest", () => {
    for (let i = 0; i < 205; i++) {
      appendSessionMatch(winEntry({ ts: `entry-${i}` }));
    }
    const log = getSessionLog();
    assert.equal(log.length, 200);
    assert.equal(log[0].ts, "entry-5"); // first 5 dropped
    assert.equal(log[199].ts, "entry-204");
  });

  test("appendSessionMatch returns an increasing seq", () => {
    const seq1 = appendSessionMatch(winEntry());
    const seq2 = appendSessionMatch(drawEntry());
    assert.equal(typeof seq1, "number");
    assert.ok(seq2 > seq1);
  });

  test("markSessionMatchUndone flags the matching entry, even when it isn't the tail", () => {
    const e1 = winEntry();
    const e2 = drawEntry();
    const seq1 = appendSessionMatch(e1);
    appendSessionMatch(e2);
    const undone = markSessionMatchUndone(seq1);
    assert.equal(undone, e1);
    assert.equal(e1.undone, true);
    assert.equal(e2.undone, undefined);
  });

  test("markSessionMatchUndone on an unknown seq returns undefined and doesn't throw", () => {
    appendSessionMatch(winEntry());
    assert.equal(markSessionMatchUndone(-1), undefined);
  });

  test("clearSessionLog empties the log", () => {
    appendSessionMatch(winEntry());
    clearSessionLog();
    assert.deepEqual(getSessionLog(), []);
  });

  test("formatMatchLine for a win", () => {
    assert.equal(
      formatMatchLine(winEntry()),
      "[performers] match: Jane Doe (62 -> 65) def. Alex Rivera (58 -> 55)"
    );
  });

  test("formatMatchLine for a draw", () => {
    assert.equal(
      formatMatchLine(drawEntry()),
      "[scenes] skip: Scene A (60 -> 60) vs Scene B (61 -> 61)"
    );
  });

  test("formatUndoLine for a win", () => {
    assert.equal(
      formatUndoLine(winEntry()),
      "undo: [performers] match: Jane Doe (62 -> 65) def. Alex Rivera (58 -> 55)"
    );
  });

  test("formatUndoLine for a draw", () => {
    assert.equal(
      formatUndoLine(drawEntry()),
      "undo: [scenes] skip: Scene A (60 -> 60) vs Scene B (61 -> 61)"
    );
  });
});
