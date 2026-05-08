import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mobileBridgeFocusOptionsForSource } from "./terminal-mobile-bridge";

describe("terminal mobile input bridge", () => {
  test("keeps terminal surface taps from moving the viewport", () => {
    assert.deepEqual(mobileBridgeFocusOptionsForSource("surface"), {
      allowBrowserScroll: false,
      scrollBlock: "nearest",
    });
  });

  test("keeps shortcut taps from moving the viewport", () => {
    assert.deepEqual(mobileBridgeFocusOptionsForSource("shortcut"), {
      allowBrowserScroll: false,
      scrollBlock: "nearest",
    });
  });
});
