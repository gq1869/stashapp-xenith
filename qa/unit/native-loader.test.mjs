// Coverage for native-loader.js's handleNativeCardClick: it must only
// intercept clicks that land on an anchor, so clicks on any other control
// injected into the native card subtree (e.g. a theme's card-flip button)
// reach their own bubble-phase listener undisturbed. See src/native-loader.js
// for the capture-vs-bubble rationale.
import { test, describe, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";

import { handleNativeCardClick } from "../../src/native-loader.js";

function fakeEvent({ anchor = null, wrap = null } = {}) {
  const calls = { preventDefault: 0, stopPropagation: 0 };
  return {
    calls,
    target: {
      closest: (sel) => (sel === "a[href]" ? anchor : null),
    },
    preventDefault: () => { calls.preventDefault++; },
    stopPropagation: () => { calls.stopPropagation++; },
  };
}

function fakeAnchor(href, wrap) {
  return {
    href,
    closest: (sel) => (sel === ".hon-card-native-wrap" ? wrap : null),
  };
}

function fakeWrap() {
  const dispatched = [];
  return {
    dispatchEvent: (evt) => dispatched.push(evt),
    dispatched,
  };
}

describe("handleNativeCardClick", () => {
  let opened;
  let originalOpen;
  let originalMouseEvent;

  beforeEach(() => {
    opened = [];
    originalOpen = globalThis.window.open;
    originalMouseEvent = globalThis.MouseEvent;
    globalThis.window.open = (href, target) => opened.push({ href, target });
    globalThis.MouseEvent = class MouseEvent {
      constructor(type, opts) {
        this.type = type;
        this.opts = opts;
      }
    };
  });

  afterEach(() => {
    globalThis.window.open = originalOpen;
    globalThis.MouseEvent = originalMouseEvent;
  });

  test("non-anchor click is left alone", () => {
    const e = fakeEvent({ anchor: null });
    handleNativeCardClick(e);
    assert.equal(e.calls.preventDefault, 0);
    assert.equal(e.calls.stopPropagation, 0);
    assert.deepEqual(opened, []);
  });

  test("anchor click is intercepted and redirected to a new tab", () => {
    const wrap = fakeWrap();
    const anchor = fakeAnchor("http://x/performers/7", wrap);
    const e = fakeEvent({ anchor });

    handleNativeCardClick(e);

    assert.equal(e.calls.preventDefault, 1);
    assert.equal(e.calls.stopPropagation, 1);
    assert.deepEqual(opened, [{ href: "http://x/performers/7", target: "_blank" }]);
    assert.equal(wrap.dispatched.length, 1);
    assert.equal(wrap.dispatched[0].type, "mouseleave");
  });

  test("anchor click with no enclosing wrap still redirects", () => {
    const anchor = fakeAnchor("http://x/scenes/3", null);
    const e = fakeEvent({ anchor });

    handleNativeCardClick(e);

    assert.equal(e.calls.preventDefault, 1);
    assert.deepEqual(opened, [{ href: "http://x/scenes/3", target: "_blank" }]);
  });
});
