import assert from "node:assert/strict";
import { test } from "node:test";
import { selectedTextOverlayPosition } from "./SelectedTextOverlay";

test("places the selected-text toolbar above the selection and clamps it to the viewport", () => {
  assert.deepEqual(
    selectedTextOverlayPosition({
      anchor: { left: 120, top: 180, bottom: 204 },
      viewportWidth: 390,
      viewportHeight: 844,
      estimatedWidth: 184,
      estimatedHeight: 42,
    }),
    { left: 120, top: 132 },
  );
  assert.deepEqual(
    selectedTextOverlayPosition({
      anchor: { left: 380, top: 20, bottom: 44 },
      viewportWidth: 390,
      viewportHeight: 844,
      estimatedWidth: 184,
      estimatedHeight: 42,
    }),
    { left: 198, top: 50 },
  );
});
