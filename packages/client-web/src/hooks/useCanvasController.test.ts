import assert from "node:assert/strict";
import test from "node:test";
import {
  activateCanvasPaneFilePreview,
  type CanvasPaneFilePreview,
} from "./useCanvasController";

const currentPreview: CanvasPaneFilePreview = {
  requestId: 4,
  sessionId: "session-a",
  workspaceRoot: "/workspace/a",
  selection: {
    path: "/workspace/a/first.ts",
    source: "local",
    sessionId: "session-a",
  },
  collapsed: true,
  presentation: "windowed",
};

test("retargeting a collapsed Canvas viewer expands it and preserves its presentation", () => {
  assert.deepEqual(
    activateCanvasPaneFilePreview(
      currentPreview,
      5,
      "session-a",
      "/workspace/a",
      "/workspace/a/second.ts",
    ),
    {
      requestId: 5,
      sessionId: "session-a",
      workspaceRoot: "/workspace/a",
      selection: {
        path: "/workspace/a/second.ts",
        source: "local",
        sessionId: "session-a",
      },
      collapsed: false,
      presentation: "windowed",
    },
  );
});

test("reactivating the same Canvas file refreshes its identity and expands the viewer", () => {
  const activePreview = { ...currentPreview, collapsed: false };
  const next = activateCanvasPaneFilePreview(
    activePreview,
    6,
    "session-a",
    "/workspace/a",
    "/workspace/a/first.ts",
  );

  assert.equal(next.requestId, 6);
  assert.equal(next.selection.path, activePreview.selection.path);
  assert.equal(next.collapsed, false);
  assert.equal(next.presentation, "windowed");
});
