import { test, describe, beforeEach, afterEach, vi } from "vitest";
import assert from "node:assert/strict";

import { queueStashLog, flushStashLog } from "../../src/stash-log.js";

function mockFetch(impl) {
  globalThis.fetch = vi.fn(impl);
}

function okResponse(data = {}) {
  return { ok: true, json: async () => ({ data }) };
}

describe("stash-log", () => {
  beforeEach(() => {
    // buffer is module-scoped, not test-scoped — drain any leftover lines
    // from a prior test before each one starts.
    mockFetch(async () => okResponse());
    flushStashLog();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("does not flush before FLUSH_AT lines and no idle timer has fired", () => {
    mockFetch(async () => okResponse());
    for (let i = 0; i < 5; i++) queueStashLog(`line ${i}`);
    assert.equal(fetch.mock.calls.length, 0);
  });

  test("flushes immediately once 10 lines are buffered", () => {
    mockFetch(async () => okResponse());
    for (let i = 0; i < 10; i++) queueStashLog(`line ${i}`);
    assert.equal(fetch.mock.calls.length, 1);
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    assert.deepEqual(body.variables.args.lines, Array.from({ length: 10 }, (_, i) => `line ${i}`));
    assert.equal(body.variables.plugin_id, "xenith");
  });

  test("idle timer flushes a partial buffer after 5s", () => {
    mockFetch(async () => okResponse());
    queueStashLog("only line");
    assert.equal(fetch.mock.calls.length, 0);
    vi.advanceTimersByTime(5000);
    assert.equal(fetch.mock.calls.length, 1);
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    assert.deepEqual(body.variables.args.lines, ["only line"]);
  });

  test("a rejected flush is swallowed and does not re-queue the lines", async () => {
    mockFetch(async () => {
      throw new Error("network down");
    });
    queueStashLog("lost line");
    flushStashLog();
    // Buffer was drained before the (failing) request, so a second flush
    // with nothing new queued sends nothing.
    await vi.waitFor(() => assert.equal(fetch.mock.calls.length, 1));
    flushStashLog();
    assert.equal(fetch.mock.calls.length, 1);
  });

  test("flushStashLog with an empty buffer does not call fetch", () => {
    mockFetch(async () => okResponse());
    flushStashLog();
    assert.equal(fetch.mock.calls.length, 0);
  });

  test("a long run of lines flushes in batches of 10, never more", () => {
    mockFetch(async () => okResponse());
    for (let i = 0; i < 47; i++) queueStashLog(`line ${i}`);
    // 47 lines: 4 full flushes of 10, 7 left buffered for the idle timer.
    assert.equal(fetch.mock.calls.length, 4);
    for (const call of fetch.mock.calls) {
      const body = JSON.parse(call[1].body);
      assert.equal(body.variables.args.lines.length, 10);
    }
    vi.advanceTimersByTime(5000);
    assert.equal(fetch.mock.calls.length, 5);
    const lastBody = JSON.parse(fetch.mock.calls[4][1].body);
    assert.equal(lastBody.variables.args.lines.length, 7);
  });
});
