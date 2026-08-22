import assert from "node:assert/strict";
import { test } from "node:test";
import type { CanvasPaneTarget } from "../canvas-state";
import { reviewRequestBelongsToOwner } from "../inspector/ReviewOverlay";
import {
  inspectionContextClearsCanvasPreviews,
  inspectionContextReviewOwner,
  workbenchInspectionContextKey,
} from "./useWorkbenchInspectionLifecycle";

function context(overrides: Partial<{
  mode: "single" | "canvas" | "council";
  selectedSessionId: string | null;
  selectedCouncilId: string | null;
  selectedWorkspaceDir: string | null;
  activeCanvasPaneId: string;
  activeCanvasTarget: CanvasPaneTarget;
  activeCanvasSessionId: string | null;
  settingsOpen: boolean;
  terminalOpen: boolean;
  fileReferenceOpen: boolean;
  workspacePickerOpen: boolean;
  newCouncilDialogOpen: boolean;
}> = {}) {
  return {
    mode: "single" as const,
    selectedSessionId: "session-a",
    selectedCouncilId: null,
    selectedWorkspaceDir: "/tmp/rah-a",
    activeCanvasPaneId: "canvas-1",
    activeCanvasTarget: { kind: "session", sessionId: "session-a" } as CanvasPaneTarget,
    activeCanvasSessionId: "session-a",
    settingsOpen: false,
    terminalOpen: false,
    fileReferenceOpen: false,
    workspacePickerOpen: false,
    newCouncilDialogOpen: false,
    ...overrides,
  };
}

test("changes the inspection context across session and top-level dialog navigation", () => {
  const sessionA = context();
  const sessionB = context({ selectedSessionId: "session-b" });
  const settings = context({ settingsOpen: true });

  assert.notEqual(
    workbenchInspectionContextKey(sessionA),
    workbenchInspectionContextKey(sessionB),
  );
  assert.notEqual(
    workbenchInspectionContextKey(sessionA),
    workbenchInspectionContextKey(settings),
  );
  assert.deepEqual(inspectionContextReviewOwner(sessionB), {
    kind: "session",
    sessionId: "session-b",
  });
  assert.equal(inspectionContextReviewOwner(settings), null);
});

test("keeps pane viewers independent while making each active Canvas pane a distinct context", () => {
  const paneA = context({ mode: "canvas" });
  const paneB = context({
    mode: "canvas",
    activeCanvasPaneId: "canvas-2",
    activeCanvasTarget: { kind: "session", sessionId: "session-b" },
    activeCanvasSessionId: "session-b",
  });

  assert.notEqual(
    workbenchInspectionContextKey(paneA),
    workbenchInspectionContextKey(paneB),
  );
  assert.equal(inspectionContextClearsCanvasPreviews(paneA), false);
  assert.equal(inspectionContextClearsCanvasPreviews(paneB), false);
  assert.equal(inspectionContextClearsCanvasPreviews(context()), true);
  assert.equal(
    inspectionContextClearsCanvasPreviews(context({ mode: "canvas", settingsOpen: true })),
    true,
  );
});

test("retains only a Review owned by the destination context", () => {
  const request = {
    scope: {
      kind: "turn" as const,
      sessionId: "session-b",
      turnId: "turn-1",
      workspaceRoot: "/tmp/rah-b",
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
      truncated: false,
    },
  };

  assert.equal(
    reviewRequestBelongsToOwner(request, { kind: "session", sessionId: "session-b" }),
    true,
  );
  assert.equal(
    reviewRequestBelongsToOwner(request, { kind: "session", sessionId: "session-a" }),
    false,
  );
  assert.equal(reviewRequestBelongsToOwner(request, null), false);
});
