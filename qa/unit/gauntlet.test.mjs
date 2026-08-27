import { test, describe, vi } from "vitest";
import assert from "node:assert/strict";

import {
  MIN_MATCHES,
  MAX_MATCHES,
  createRun,
  nextProbe,
  applyResult,
  runStatus,
  runProgress,
} from "../../src/gauntlet.js";

// Synthetic ladder: 100 entries, ratings linearly spaced 90 (index 0) down
// to 10 (index 99) — descending, matching what rank-cache.js's sort
// produces. Challenger is excluded by the caller (matchmaking.js), so it
// never appears here.
function makeLadder(size = 100) {
  const ladder = [];
  for (let i = 0; i < size; i++) {
    const rating = 90 - (i * 80) / (size - 1);
    ladder.push({ id: `p${i}`, rating });
  }
  return ladder;
}

function sum(arr) {
  return arr.reduce((a, b) => a + b, 0);
}

describe("gauntlet.js — createRun", () => {
  test("throws on a ladder shorter than 2", () => {
    assert.throws(() => createRun({ challengerId: "c1", ladder: [{ id: "p0", rating: 50 }] }));
    assert.throws(() => createRun({ challengerId: "c1", ladder: [] }));
  });

  test("uniform prior sums to 1", () => {
    const run = createRun({ challengerId: "c1", ladder: makeLadder() });
    assert.ok(Math.abs(sum(run.posterior) - 1) < 1e-9);
    // Every hypothesis equally likely at the start.
    const expected = 1 / run.ladder.length;
    for (const p of run.posterior) {
      assert.ok(Math.abs(p - expected) < 1e-12);
    }
  });
});

describe("gauntlet.js — applyResult", () => {
  test("posterior stays normalized after every update", () => {
    const ladder = makeLadder();
    let run = createRun({ challengerId: "c1", ladder });
    for (const outcome of [1, 0, 0.5, 1, 0]) {
      run = applyResult(run, { probeIndex: 50, outcome });
      assert.ok(Math.abs(sum(run.posterior) - 1) < 1e-9, `sum should be 1, got ${sum(run.posterior)}`);
    }
  });

  test("a win against the median shifts the median toward higher ratings (lower index)", () => {
    const ladder = makeLadder();
    let run = createRun({ challengerId: "c1", ladder });
    const before = runProgress(run).medianIndex;
    run = applyResult(run, { probeIndex: before, outcome: 1 });
    const after = runProgress(run).medianIndex;
    assert.ok(after < before, `expected median to move up (lower index): before=${before} after=${after}`);
  });

  test("a loss against the median shifts the median toward lower ratings (higher index)", () => {
    const ladder = makeLadder();
    let run = createRun({ challengerId: "c1", ladder });
    const before = runProgress(run).medianIndex;
    run = applyResult(run, { probeIndex: before, outcome: 0 });
    const after = runProgress(run).medianIndex;
    assert.ok(after > before, `expected median to move down (higher index): before=${before} after=${after}`);
  });

  test("a draw against the median is directionally neutral", () => {
    const ladder = makeLadder();
    let run = createRun({ challengerId: "c1", ladder });
    const before = runProgress(run).medianIndex;
    run = applyResult(run, { probeIndex: before, outcome: 0.5 });
    const after = runProgress(run).medianIndex;
    // The draw likelihood is symmetric around the probe index, so against a
    // uniform prior centered there, the median shouldn't move meaningfully.
    assert.ok(Math.abs(after - before) <= 1, `expected draw to leave median ~unchanged: before=${before} after=${after}`);
  });

  test("records the probe id in facedIds and increments matchesPlayed", () => {
    const ladder = makeLadder();
    let run = createRun({ challengerId: "c1", ladder });
    run = applyResult(run, { probeIndex: 10, outcome: 1 });
    assert.equal(run.matchesPlayed, 1);
    assert.deepEqual(run.facedIds, ["p10"]);
  });

  test("does not mutate the input run", () => {
    const ladder = makeLadder();
    const run = createRun({ challengerId: "c1", ladder });
    const originalPosterior = run.posterior;
    applyResult(run, { probeIndex: 40, outcome: 1 });
    assert.equal(run.posterior, originalPosterior);
    assert.equal(run.matchesPlayed, 0);
  });
});

describe("gauntlet.js — credible interval narrows with evidence", () => {
  test("consistent wins narrow the 80% credible interval", () => {
    const ladder = makeLadder();
    let run = createRun({ challengerId: "c1", ladder });
    const initialWidth = runProgress(run).intervalHi - runProgress(run).intervalLo;

    for (let i = 0; i < MIN_MATCHES; i++) {
      const { medianIndex } = runProgress(run);
      run = applyResult(run, { probeIndex: medianIndex, outcome: 1 });
    }

    const finalWidth = runProgress(run).intervalHi - runProgress(run).intervalLo;
    assert.ok(finalWidth < initialWidth, `expected interval to narrow: initial=${initialWidth} final=${finalWidth}`);
  });
});

describe("gauntlet.js — recovers from an unlucky early loss", () => {
  test("a surprising first-probe loss doesn't cap the final placement", () => {
    const ladder = makeLadder();
    const trueIndex = 20; // challenger's true rating equals ladder[20]'s rating
    const trueRating = ladder[trueIndex].rating;

    let run = createRun({ challengerId: "c1", ladder });

    // Forced surprising loss: probe at index 50 (much lower-rated than the
    // challenger's true position) but the challenger loses anyway — the
    // kind of single misclick/upset a hard bracket can never recover from.
    run = applyResult(run, { probeIndex: 50, outcome: 0 });

    // Everything after follows an honest oracle: win iff the challenger's
    // true rating beats the probe's rating.
    let guard = 0;
    while (runStatus(run) === "active" && guard < MAX_MATCHES) {
      const probe = nextProbe(run);
      if (!probe) break;
      const outcome = trueRating > ladder[probe.index].rating ? 1 : 0;
      run = applyResult(run, { probeIndex: probe.index, outcome });
      guard++;
    }

    const { medianIndex } = runProgress(run);
    assert.ok(
      Math.abs(medianIndex - trueIndex) <= 5,
      `expected recovery near true index ${trueIndex}, landed at ${medianIndex}`
    );
  });
});

describe("gauntlet.js — termination bounds", () => {
  test("a run terminates within [MIN_MATCHES, MAX_MATCHES]", () => {
    const ladder = makeLadder();
    const trueIndex = 65;
    const trueRating = ladder[trueIndex].rating;
    let run = createRun({ challengerId: "c1", ladder });

    let guard = 0;
    while (runStatus(run) === "active" && guard < MAX_MATCHES + 1) {
      const probe = nextProbe(run);
      if (!probe) break;
      const outcome = trueRating > ladder[probe.index].rating ? 1 : 0;
      run = applyResult(run, { probeIndex: probe.index, outcome });
      guard++;
    }

    assert.ok(run.matchesPlayed >= MIN_MATCHES, `expected at least ${MIN_MATCHES} matches, got ${run.matchesPlayed}`);
    assert.ok(run.matchesPlayed <= MAX_MATCHES, `expected at most ${MAX_MATCHES} matches, got ${run.matchesPlayed}`);
    assert.notEqual(runStatus(run), "active");
  });
});

describe("gauntlet.js — nextProbe", () => {
  test("never re-serves an already-faced opponent", () => {
    const ladder = makeLadder();
    let run = createRun({ challengerId: "c1", ladder });
    const faced = new Set();

    for (let i = 0; i < MIN_MATCHES; i++) {
      const probe = nextProbe(run);
      assert.ok(probe, "expected a probe while run is active");
      assert.ok(!faced.has(probe.id), `probe ${probe.id} was already faced this run`);
      faced.add(probe.id);
      run = applyResult(run, { probeIndex: probe.index, outcome: i % 2 === 0 ? 1 : 0 });
    }
  });

  test("returns null once the run has terminated", () => {
    const ladder = makeLadder();
    let run = createRun({ challengerId: "c1", ladder });
    for (let i = 0; i < MAX_MATCHES; i++) {
      const probe = nextProbe(run);
      if (!probe) break;
      run = applyResult(run, { probeIndex: probe.index, outcome: 1 });
    }
    assert.equal(nextProbe(run), null);
  });
});

// matchmaking.js's selectGauntletPair passes excludeIds when a
// gender filter narrowed mid-run leaves some ladder entries out of scope.
// The ladder itself must stay frozen (posterior[i] <-> ladder[i] is
// positional), so exclusion happens here, at selection time, not by
// rebuilding the ladder.
describe("gauntlet.js — nextProbe excludeIds", () => {
  test("with no options, behaves identically to before (regression guard on the optional param)", () => {
    // nextProbe's weightedPick draws on Math.random, so pin it for a
    // deterministic comparison across the three call shapes.
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.42);
    try {
      const ladder = makeLadder();
      const run = createRun({ challengerId: "c1", ladder });
      assert.deepEqual(nextProbe(run), nextProbe(run, {}));
      assert.deepEqual(nextProbe(run), nextProbe(run, { excludeIds: undefined }));
    } finally {
      randomSpy.mockRestore();
    }
  });

  test("never returns an excluded id", () => {
    const ladder = makeLadder();
    let run = createRun({ challengerId: "c1", ladder });
    const { medianIndex } = runProgress(run);
    // Exclude everyone but the single ladder entry nearest the median —
    // any pick must be forced onto that one id.
    const keepId = ladder[medianIndex].id;
    const excludeIds = ladder.filter((e) => e.id !== keepId).map((e) => e.id);

    const probe = nextProbe(run, { excludeIds });
    assert.ok(probe, "expected a probe — one candidate remains eligible");
    assert.equal(probe.id, keepId);
  });

  test("returns null once excludeIds plus facedIds cover the whole ladder", () => {
    const ladder = makeLadder(6); // small ladder: easy to exhaust
    const run = createRun({ challengerId: "c1", ladder });
    const excludeIds = ladder.map((e) => e.id);
    assert.equal(nextProbe(run, { excludeIds }), null);
  });

  test("excluding ids does not mutate run state, and a filtered pick's id/index stay consistent with the ladder", () => {
    const ladder = makeLadder();
    let run = createRun({ challengerId: "c1", ladder });
    // Play a couple of matches so the posterior isn't uniform, exercising a
    // more realistic mid-run state.
    run = applyResult(run, { probeIndex: 40, outcome: 1 });
    run = applyResult(run, { probeIndex: 60, outcome: 0 });

    const before = runProgress(run);
    const { medianIndex } = before;
    const keepId = ladder[medianIndex].id;
    const excludeIds = ladder.filter((e) => e.id !== keepId).map((e) => e.id);

    const filteredProbe = nextProbe(run, { excludeIds });

    assert.deepEqual(runProgress(run), before, "excludeIds must not mutate or otherwise affect run state");
    assert.ok(filteredProbe, "expected a probe — one candidate remains eligible");
    assert.equal(filteredProbe.id, keepId);
    assert.equal(ladder[filteredProbe.index].id, keepId, "returned index must still map to the same ladder entry");
  });
});
