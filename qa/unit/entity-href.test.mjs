// Coverage for entity-href.js's link/path parsing, shared by
// badge-injector.js and scene-tooltips.js to tell performer links apart
// from scene links.
import { test, describe } from "vitest";
import assert from "node:assert/strict";

import { parseEntityHref, parseEntityPath } from "../../src/entity-href.js";

describe("parseEntityHref", () => {
  test("plain performer link", () => {
    assert.deepEqual(parseEntityHref("http://x/performers/7"), { battleType: "performers", id: "7" });
  });

  test("plain scene link", () => {
    assert.deepEqual(parseEntityHref("http://x/scenes/12"), { battleType: "scenes", id: "12" });
  });

  test("scene link with a timestamp query string", () => {
    assert.deepEqual(parseEntityHref("http://x/scenes/12?t=30"), { battleType: "scenes", id: "12" });
  });

  test("scene link with a queue-encoded query string", () => {
    assert.deepEqual(
      parseEntityHref("http://x/scenes/12?qs=eJyrVsrJT07MzC9RsjKytFEqSy0qzszPUwLxDA1M9GsBnpsMzQ"),
      { battleType: "scenes", id: "12" }
    );
  });

  test("relative href resolves against a base", () => {
    assert.deepEqual(parseEntityHref("/performers/3"), { battleType: "performers", id: "3" });
  });

  test("trailing slash", () => {
    assert.deepEqual(parseEntityHref("http://x/performers/3/"), { battleType: "performers", id: "3" });
  });

  test("subpath after the id does not confuse the id capture", () => {
    assert.deepEqual(parseEntityHref("http://x/performers/3/appearances"), { battleType: "performers", id: "3" });
  });

  test("non-entity href returns null", () => {
    assert.equal(parseEntityHref("http://x/studios/3"), null);
  });

  test("non-numeric id returns null", () => {
    assert.equal(parseEntityHref("http://x/performers/abc"), null);
  });
});

describe("parseEntityPath", () => {
  test("performer detail pathname", () => {
    assert.deepEqual(parseEntityPath("/performers/42"), { battleType: "performers", id: "42" });
  });

  test("scene detail pathname", () => {
    assert.deepEqual(parseEntityPath("/scenes/42"), { battleType: "scenes", id: "42" });
  });

  test("non-entity pathname returns null", () => {
    assert.equal(parseEntityPath("/scenes"), null);
  });
});
