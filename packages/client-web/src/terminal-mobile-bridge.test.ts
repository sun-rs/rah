import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mobileBridgeFocusOptionsForSource } from "./terminal-mobile-bridge";

describe("terminal mobile input bridge", () => {
  test("lets terminal surface taps use browser viewport anchoring", () => {
    assert.deepEqual(mobileBridgeFocusOptionsForSource("surface"), {
      allowBrowserScroll: true,
      scrollBlock: "center",
    });
  });

  test("keeps shortcut taps from moving the viewport", () => {
    assert.deepEqual(mobileBridgeFocusOptionsForSource("shortcut"), {
      allowBrowserScroll: false,
      scrollBlock: "nearest",
    });
  });
});
