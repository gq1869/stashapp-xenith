import { test, describe } from "vitest";
import assert from "node:assert/strict";

import {
  MAX_DEFENSES,
  createReign,
  applyReignResult,
  reignStatus,
} from "../../src/champion.js";

describe("champion.js — createReign", () => {
  test("starts at 0 defenses for the given champion", () => {
    const run = createReign("c1");
    assert.equal(run.championId, "c1");
    assert.equal(run.defenses, 0);
  });
});

describe("champion.js — applyReignResult", () => {
  test("a champion win increments defenses", () => {
    const run = createReign("c1");
    const next = applyReignResult(run, { outcome: 1, challengerId: "x1" });
    assert.equal(next.championId, "c1");
    assert.equal(next.defenses, 1);
  });

  test("does not mutate the input run", () => {
    const run = createReign("c1");
    applyReignResult(run, { outcome: 1, challengerId: "x1" });
    assert.equal(run.defenses, 0);
  });

  test("a draw holds the reign without incrementing defenses", () => {
    const run = createReign("c1");
    const next = applyReignResult(run, { outcome: 0.5, challengerId: "x1" });
    assert.equal(next.championId, "c1");
    assert.equal(next.defenses, 0);
  });

  test("a challenger win re-roots the reign at the challenger, resetting defenses", () => {
    let run = createReign("c1");
    run = applyReignResult(run, { outcome: 1, challengerId: "x1" });
    run = applyReignResult(run, { outcome: 1, challengerId: "x2" });
    assert.equal(run.defenses, 2);

    const dethroned = applyReignResult(run, { outcome: 0, challengerId: "x3" });
    assert.equal(dethroned.championId, "x3");
    assert.equal(dethroned.defenses, 0);
  });

  test("reaching MAX_DEFENSES retires the reign (returns null)", () => {
    let run = createReign("c1");
    for (let i = 0; i < MAX_DEFENSES - 1; i++) {
      run = applyReignResult(run, { outcome: 1, challengerId: `x${i}` });
      assert.ok(run !== null, `should still be active after defense ${i + 1}`);
    }
    const retired = applyReignResult(run, { outcome: 1, challengerId: "final" });
    assert.equal(retired, null);
  });
});

describe("champion.js — reignStatus", () => {
  test("reports defenses and remaining", () => {
    let run = createReign("c1");
    run = applyReignResult(run, { outcome: 1, challengerId: "x1" });
    run = applyReignResult(run, { outcome: 1, challengerId: "x2" });
    const status = reignStatus(run);
    assert.equal(status.defenses, 2);
    assert.equal(status.remaining, MAX_DEFENSES - 2);
  });
});
