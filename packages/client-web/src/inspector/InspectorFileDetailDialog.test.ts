import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  PANE_WINDOW_DEFAULT_HEIGHT,
  PANE_WINDOW_DEFAULT_WIDTH,
  PANE_WINDOW_MIN_HEIGHT,
  calculateInitialViewerGeometry,
  resizePaneWindowVertically,
} from "./InspectorFileDetailDialog";

describe("Inspector file viewer geometry", () => {
  test("scales the pane-window default height on large panes without becoming full-pane", () => {
    assert.equal(
      PANE_WINDOW_DEFAULT_HEIGHT,
      "min(68rem, max(42rem, 82%), calc(100% - 4rem))",
    );
  });

  test("reserves a left-side conversation lane beside the pane window", () => {
    assert.equal(
      PANE_WINDOW_DEFAULT_WIDTH,
      "min(52rem, max(22rem, calc(60% - 1rem)), calc(100% - 2rem))",
    );
  });

  test("centers the default window inside the actual chat bounds", () => {
    const anchor = { left: 280, top: 0, width: 760, height: 900 };
    const geometry = calculateInitialViewerGeometry(anchor, { width: 1440, height: 900 });

    assert.equal(geometry.x + geometry.width / 2, anchor.left + anchor.width / 2);
    assert.equal(geometry.y + geometry.height / 2, anchor.top + anchor.height / 2);
    assert.ok(geometry.x >= anchor.left);
    assert.ok(geometry.x + geometry.width <= anchor.left + anchor.width);
  });

  test("recomputes the center when the chat region grows", () => {
    const expandedAnchor = { left: 80, top: 0, width: 1120, height: 900 };
    const geometry = calculateInitialViewerGeometry(expandedAnchor, {
      width: 1440,
      height: 900,
    });

    assert.equal(geometry.width, 960);
    assert.equal(
      geometry.x + geometry.width / 2,
      expandedAnchor.left + expandedAnchor.width / 2,
    );
  });

  test("resizes a pane window vertically while keeping the opposite edge fixed", () => {
    const fromTop = resizePaneWindowVertically(
      { top: 120, height: 500 },
      "n",
      80,
      900,
    );
    assert.deepEqual(fromTop, { top: 200, height: 420 });
    assert.equal(fromTop.top + fromTop.height, 620);

    const fromBottom = resizePaneWindowVertically(
      { top: 120, height: 500 },
      "s",
      80,
      900,
    );
    assert.deepEqual(fromBottom, { top: 120, height: 580 });
  });

  test("clamps pane-window resizing to its readable minimum and pane bounds", () => {
    assert.deepEqual(
      resizePaneWindowVertically({ top: 120, height: 500 }, "n", 400, 900),
      { top: 340, height: PANE_WINDOW_MIN_HEIGHT },
    );
    assert.deepEqual(
      resizePaneWindowVertically({ top: 120, height: 500 }, "s", 900, 900),
      { top: 120, height: 764 },
    );
  });
});
