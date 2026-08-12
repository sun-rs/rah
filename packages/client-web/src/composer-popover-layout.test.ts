import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  resolveComposerPopoverLayout,
  resolveComposerVisualViewportBounds,
} from "./composer-popover-layout";

describe("composer popover layout", () => {
  test("uses the visual viewport instead of placing a menu behind the iOS keyboard", () => {
    const viewport = resolveComposerVisualViewportBounds({
      layoutWidth: 390,
      layoutHeight: 844,
      visualViewport: {
        offsetLeft: 0,
        offsetTop: 0,
        width: 390,
        height: 452,
      },
    });
    const layout = resolveComposerPopoverLayout({
      anchor: {
        left: 52,
        top: 392,
        right: 92,
        bottom: 432,
        width: 40,
        height: 40,
      },
      viewport,
      desiredWidth: 320,
      desiredHeight: 132,
      maximumHeight: 420,
    });

    assert.equal(layout.placement, "above");
    assert.equal(layout.top, 254);
    assert.ok(layout.top + layout.height <= viewport.bottom - 8);
  });

  test("accounts for a scrolled visual viewport and clamps both axes", () => {
    const viewport = resolveComposerVisualViewportBounds({
      layoutWidth: 1024,
      layoutHeight: 900,
      visualViewport: {
        offsetLeft: 40,
        offsetTop: 120,
        width: 360,
        height: 420,
      },
    });
    const layout = resolveComposerPopoverLayout({
      anchor: {
        left: 370,
        top: 180,
        right: 410,
        bottom: 220,
        width: 40,
        height: 40,
      },
      viewport,
      desiredWidth: 320,
      desiredHeight: 260,
      maximumHeight: 420,
    });

    assert.equal(layout.left, 72);
    assert.equal(layout.placement, "below");
    assert.ok(layout.top >= viewport.top + 8);
    assert.ok(layout.top + layout.height <= viewport.bottom - 8);
  });
});
