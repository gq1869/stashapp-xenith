// Coverage for rank-cache.js's per-battle-type ranked ordering.
// Mocks src/api.js's gql() the same way qa/unit/matchmaking-integration.test.mjs
// does, so getRankedItems() runs its real fetch/map/sort/rank body against
// an in-memory pool instead of a live Stash GraphQL endpoint.
import { vi, test, describe, beforeEach } from "vitest";
import assert from "node:assert/strict";

vi.mock("../../src/api.js", () => ({
  gql: async (query, variables) => mockGql(query, variables),
  FIND_PERFORMERS_RANK: "FIND_PERFORMERS_RANK",
  FIND_SCENES_RANK: "FIND_SCENES_RANK",
}));

const { getRankedItems, invalidateRankCache } = await import(
  "../../src/rank-cache.js"
);

let performerPool = [];
let scenePool = [];
let performerCalls = 0;
let sceneCalls = 0;

function mockGql(query, variables) {
  // rank-cache.js imports FIND_PERFORMERS_RANK/FIND_SCENES_RANK from api.js,
  // which is mocked above, so query is just the mocked placeholder string.
  if (query === "FIND_PERFORMERS_RANK") {
    performerCalls++;
    return { findPerformers: { count: performerPool.length, performers: performerPool } };
  }
  if (query === "FIND_SCENES_RANK") {
    sceneCalls++;
    return { findScenes: { count: scenePool.length, scenes: scenePool } };
  }
  throw new Error(`unexpected query in mockGql: ${query}`);
}

function makePerformer(id, rating, gender) {
  return { id: String(id), name: `P${id}`, rating100: rating, gender, custom_fields: {} };
}

function makeScene(id, rating, title) {
  return { id: String(id), title, rating100: rating, custom_fields: {} };
}

beforeEach(() => {
  performerPool = [];
  scenePool = [];
  performerCalls = 0;
  sceneCalls = 0;
  invalidateRankCache();
});

describe("getRankedItems", () => {
  test("scenes sort by composite descending and get 1-based rank", async () => {
    scenePool = [makeScene(1, 40, "Low"), makeScene(2, 90, "High"), makeScene(3, 65, "Mid")];
    const rows = await getRankedItems("scenes");
    assert.deepEqual(rows.map((r) => r.id), ["2", "3", "1"]);
    assert.deepEqual(rows.map((r) => r.rank), [1, 2, 3]);
    assert.ok(rows[0].composite >= rows[1].composite && rows[1].composite >= rows[2].composite);
  });

  test("normalizes scene title to name, falling back to an id label when untitled", async () => {
    scenePool = [makeScene(1, 50, "Real Title"), makeScene(2, 50, "")];
    const rows = await getRankedItems("scenes");
    const byId = new Map(rows.map((r) => [r.id, r]));
    assert.equal(byId.get("1").name, "Real Title");
    assert.equal(byId.get("2").name, "Scene 2");
    // title itself survives the spread, untouched
    assert.equal(byId.get("1").title, "Real Title");
  });

  test("performers keep their own name field untouched", async () => {
    performerPool = [makePerformer(1, 50)];
    const rows = await getRankedItems("performers");
    assert.equal(rows[0].name, "P1");
  });

  // Gender is carried through onto ranked rows so matchmaking.js's
  // startGauntletRun can filter its ladder snapshot by the live gender
  // filter without a second fetch.
  test("carries gender through onto ranked performer rows", async () => {
    performerPool = [makePerformer(1, 50, "FEMALE"), makePerformer(2, 60, "MALE")];
    const rows = await getRankedItems("performers");
    const byId = new Map(rows.map((r) => [r.id, r]));
    assert.equal(byId.get("1").gender, "FEMALE");
    assert.equal(byId.get("2").gender, "MALE");
  });

  test("each battle type has its own cache — a performers fetch doesn't satisfy a scenes call", async () => {
    performerPool = [makePerformer(1, 50)];
    scenePool = [makeScene(1, 50, "S1")];

    await getRankedItems("performers");
    assert.equal(performerCalls, 1);
    assert.equal(sceneCalls, 0);

    const sceneRows = await getRankedItems("scenes");
    assert.equal(sceneCalls, 1);
    assert.equal(sceneRows[0].name, "S1");

    // both now warm — repeat calls within the TTL hit cache, not gql
    await getRankedItems("performers");
    await getRankedItems("scenes");
    assert.equal(performerCalls, 1);
    assert.equal(sceneCalls, 1);
  });

  test("concurrent calls for the same battle type share one in-flight request", async () => {
    scenePool = [makeScene(1, 50, "S1")];
    const [a, b] = await Promise.all([getRankedItems("scenes"), getRankedItems("scenes")]);
    assert.equal(sceneCalls, 1);
    assert.equal(a, b); // same array reference, not just equal content
  });

  test("invalidateRankCache() clears both battle types", async () => {
    performerPool = [makePerformer(1, 50)];
    scenePool = [makeScene(1, 50, "S1")];
    await getRankedItems("performers");
    await getRankedItems("scenes");
    assert.equal(performerCalls, 1);
    assert.equal(sceneCalls, 1);

    invalidateRankCache();

    await getRankedItems("performers");
    await getRankedItems("scenes");
    assert.equal(performerCalls, 2);
    assert.equal(sceneCalls, 2);
  });
});
