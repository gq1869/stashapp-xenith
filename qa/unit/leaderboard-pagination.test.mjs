// Coverage for leaderboard-pagination.js's page-size resolution and
// breakpoint-crossing index math.
import { test, describe } from "vitest";
import assert from "node:assert/strict";

import {
  resolvePageSize,
  reindexPage,
  DEFAULT_PAGE_SIZE_MOBILE,
  DESKTOP_MULTIPLIER,
} from "../../src/leaderboard-pagination.js";

describe("resolvePageSize", () => {
  test("unset/undefined override falls back to the responsive default", () => {
    assert.equal(resolvePageSize(undefined, true), DEFAULT_PAGE_SIZE_MOBILE);
    assert.equal(resolvePageSize(undefined, false), DEFAULT_PAGE_SIZE_MOBILE * DESKTOP_MULTIPLIER);
  });

  for (const bad of [0, -1, -100, NaN, null, "", "not a number", 12.5]) {
    test(`invalid override (${JSON.stringify(bad)}) falls back to the responsive default`, () => {
      assert.equal(resolvePageSize(bad, true), DEFAULT_PAGE_SIZE_MOBILE);
      assert.equal(resolvePageSize(bad, false), DEFAULT_PAGE_SIZE_MOBILE * DESKTOP_MULTIPLIER);
    });
  }

  test("a valid override sets the mobile figure and derives desktop at 5x", () => {
    assert.equal(resolvePageSize(50, true), 50);
    assert.equal(resolvePageSize(50, false), 250);
  });

  test("a numeric string override is coerced", () => {
    assert.equal(resolvePageSize("200", true), 200);
    assert.equal(resolvePageSize("200", false), 1000);
  });

  test("a hostile override is clamped before the desktop multiply", () => {
    const mobile = resolvePageSize(999999, true);
    const desktop = resolvePageSize(999999, false);
    assert.ok(mobile <= 2000, `expected mobile page size to be clamped, got ${mobile}`);
    assert.equal(desktop, mobile * DESKTOP_MULTIPLIER);
  });
});

describe("reindexPage", () => {
  test("unchanged size returns the same page", () => {
    assert.equal(reindexPage(5, 100, 100), 5);
  });

  test("crossing to a larger page size lands near the same first-row index", () => {
    // Page 40 (0-indexed) at 100/page starts at row 4,000; at 500/page that
    // row falls on page 8.
    assert.equal(reindexPage(40, 100, 500), 8);
  });

  test("crossing to a smaller page size lands near the same first-row index", () => {
    // Page 8 at 500/page starts at row 4,000; at 100/page that's page 40.
    assert.equal(reindexPage(8, 500, 100), 40);
  });

  test("page 0 stays page 0 regardless of size change", () => {
    assert.equal(reindexPage(0, 100, 500), 0);
    assert.equal(reindexPage(0, 500, 100), 0);
  });
});
