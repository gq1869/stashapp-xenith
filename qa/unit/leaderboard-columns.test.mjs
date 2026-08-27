// Coverage for leaderboard-columns.js's column-width resolution —
// widths must be driven by the longest rendered value across the full row
// set, not the first row or whichever rows happen to be on the current page.
import { test, describe } from "vitest";
import assert from "node:assert/strict";

import { computeColumnWidths, formatStreak, COLUMNS } from "../../src/leaderboard-columns.js";

function makeRow(overrides = {}) {
  return {
    id: "1",
    name: "A",
    tier: "C",
    rating100: 50,
    composite: 0.5,
    stats: { total_matches: 0, wins: 0, losses: 0, draws: 0, current_streak: 0 },
    ...overrides,
  };
}

describe("formatStreak", () => {
  test("positive streak", () => assert.equal(formatStreak(3), "W3"));
  test("negative streak", () => assert.equal(formatStreak(-12), "L12"));
  test("zero streak", () => assert.equal(formatStreak(0), "0"));
});

describe("computeColumnWidths", () => {
  test("empty rows falls back to each header label's own length", () => {
    const widths = computeColumnWidths([]);
    for (const col of COLUMNS) {
      if (col.key === "name") continue;
      assert.equal(widths[col.key], col.label.length, col.key);
    }
  });

  test("width is driven by the longest value, not the first row", () => {
    const rows = [
      makeRow({ stats: { total_matches: 1, wins: 1, losses: 0, draws: 0, current_streak: 1 } }),
      makeRow({ stats: { total_matches: 12345, wins: 0, losses: 0, draws: 0, current_streak: 1 } }),
    ];
    const widths = computeColumnWidths(rows);
    assert.equal(widths.matches, "12345".length);
  });

  test("header label wins when longer than every value", () => {
    // "Rating" (6 chars) vs. rendered ratings like "8.7"/"5.0" (3 chars).
    const rows = [makeRow({ rating100: 87 }), makeRow({ rating100: 50 })];
    const widths = computeColumnWidths(rows);
    assert.equal(widths.rating100, "Rating".length);
  });

  test("Unrated rows are counted against the rating column", () => {
    const rows = [makeRow({ rating100: null })];
    const widths = computeColumnWidths(rows);
    assert.equal(widths.rating100, "Unrated".length);
  });

  test("negative streaks are counted (L12 longer than W1/Rating-style short values)", () => {
    const rows = [
      makeRow({ stats: { total_matches: 1, wins: 0, losses: 1, draws: 0, current_streak: -12 } }),
    ];
    const widths = computeColumnWidths(rows);
    assert.equal(widths.streak, "L12".length);
  });

  test("name column always gets the fixed floor, regardless of name length", () => {
    const shortWidths = computeColumnWidths([makeRow({ name: "Al" })]);
    const longWidths = computeColumnWidths([makeRow({ name: "A Very Long Performer Name Indeed" })]);
    assert.equal(shortWidths.name, longWidths.name);
  });

  test("result is independent of row order", () => {
    const rowA = makeRow({ stats: { total_matches: 5, wins: 0, losses: 0, draws: 0, current_streak: 0 } });
    const rowB = makeRow({ stats: { total_matches: 500, wins: 0, losses: 0, draws: 0, current_streak: 0 } });
    const forward = computeColumnWidths([rowA, rowB]);
    const backward = computeColumnWidths([rowB, rowA]);
    assert.deepEqual(forward, backward);
  });
});
