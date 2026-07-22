import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { calculateInitialViewerGeometry } from "./InspectorFileDetailDialog";

describe("Inspector file viewer geometry", () => {
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
});
