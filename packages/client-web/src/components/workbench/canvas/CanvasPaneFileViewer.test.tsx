import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CANVAS_PANE_FILE_VIEWER_MIN_WINDOW_HEIGHT,
  CANVAS_PANE_FILE_VIEWER_MIN_WINDOW_WIDTH,
  CanvasPaneFileViewer,
  resolveCanvasPaneFileViewerPresentation,
} from "./CanvasPaneFileViewer";

test("chooses the automatic presentation from the pane's own usable size", () => {
  assert.equal(
    resolveCanvasPaneFileViewerPresentation("auto", {
      width: CANVAS_PANE_FILE_VIEWER_MIN_WINDOW_WIDTH,
      height: CANVAS_PANE_FILE_VIEWER_MIN_WINDOW_HEIGHT,
    }),
    "windowed",
  );
  assert.equal(
    resolveCanvasPaneFileViewerPresentation("auto", {
      width: CANVAS_PANE_FILE_VIEWER_MIN_WINDOW_WIDTH - 1,
      height: CANVAS_PANE_FILE_VIEWER_MIN_WINDOW_HEIGHT,
    }),
    "maximized",
  );
  assert.equal(
    resolveCanvasPaneFileViewerPresentation("auto", {
      width: CANVAS_PANE_FILE_VIEWER_MIN_WINDOW_WIDTH,
      height: CANVAS_PANE_FILE_VIEWER_MIN_WINDOW_HEIGHT - 1,
    }),
    "maximized",
  );
});

test("keeps an explicit presentation when the pane crosses the automatic threshold", () => {
  assert.equal(
    resolveCanvasPaneFileViewerPresentation("maximized", { width: 1200, height: 900 }),
    "maximized",
  );
  assert.equal(
    resolveCanvasPaneFileViewerPresentation("windowed", { width: 390, height: 420 }),
    "windowed",
  );
});

test("renders a collapsed file viewer as pane-local chrome", () => {
  const markup = renderToStaticMarkup(
    createElement(CanvasPaneFileViewer, {
      preview: {
        requestId: 2,
        sessionId: "session-b",
        workspaceRoot: "/workspace/b",
        selection: {
          path: "/workspace/b/src/pane-b.ts",
          source: "local",
          sessionId: "session-b",
        },
        collapsed: true,
        presentation: "windowed",
      },
      onCollapsedChange: () => undefined,
      onPresentationChange: () => undefined,
      onClose: () => undefined,
    }),
  );

  assert.match(markup, /data-testid="canvas-pane-file-viewer-collapsed"/);
  assert.match(markup, />pane-b\.ts</);
  assert.match(markup, /aria-label="Expand file viewer for pane-b\.ts"/);
  assert.match(markup, /class="pointer-events-auto absolute right-2 top-10/);
  assert.doesNotMatch(markup, /fixed inset-0/);
});
