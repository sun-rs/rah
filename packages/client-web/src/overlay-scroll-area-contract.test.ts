import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { OVERLAY_SCROLL_AREA_LAYOUT } from "./components/OverlayScrollArea";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("overlay scroll area contract", () => {
  test("defines a hidden-native overlay scrollbar protocol", () => {
    const css = readSource("./index.css");

    assert.match(OVERLAY_SCROLL_AREA_LAYOUT.viewportClassName, /\brah-scroll-overlay-area\b/);
    assert.doesNotMatch(OVERLAY_SCROLL_AREA_LAYOUT.viewportClassName, /\brah-scroll-panel\b/);
    assert.match(OVERLAY_SCROLL_AREA_LAYOUT.trackClassName, /\btouch-none\b/);
    assert.match(OVERLAY_SCROLL_AREA_LAYOUT.trackClassName, /group-hover\/overlay-scroll:opacity-100/);
    assert.match(OVERLAY_SCROLL_AREA_LAYOUT.trackClassName, /group-focus-within\/overlay-scroll:opacity-100/);
    assert.match(OVERLAY_SCROLL_AREA_LAYOUT.thumbClassName, /\bw-1\b/);
    assert.match(OVERLAY_SCROLL_AREA_LAYOUT.thumbClassName, /\bcursor-grab\b/);
    assert.match(css, /\.rah-scroll-overlay-area\b/);
    assert.match(css, /scrollbar-width:\s*none/);
    assert.match(css, /display:\s*none/);
  });

  test("keeps the overlay thumb draggable while preserving native scroll behavior", () => {
    const source = readSource("./components/OverlayScrollArea.tsx");

    assert.match(source, /scrollTop/);
    assert.match(source, /ResizeObserver/);
    assert.match(source, /setPointerCapture/);
    assert.match(source, /releasePointerCapture/);
    assert.match(source, /onLostPointerCapture/);
    assert.match(source, /onKeyDown/);
    assert.match(source, /tabIndex=\{0\}/);
    assert.match(source, /role="scrollbar"/);
    assert.match(source, /aria-valuenow/);
    assert.match(source, /assignRef/);
    assert.match(source, /viewportRef\?: Ref<HTMLDivElement>/);
    assert.match(source, /contentRef\?: Ref<HTMLDivElement>/);
  });

  test("uses OverlayScrollArea for utility panels, not main reading surfaces", () => {
    const utilityPanels = [
      "./components/SessionHistoryDialog.tsx",
      "./components/SettingsPane.tsx",
      "./components/workbench/dialogs/SessionInfoDialog.tsx",
      "./components/SessionModelControls.tsx",
      "./components/SessionModeControls.tsx",
      "./components/WorkspacePicker.tsx",
      "./components/FileReferencePicker.tsx",
      "./InspectorPane.tsx",
    ];
    for (const relativePath of utilityPanels) {
      const source = readSource(relativePath);
      assert.match(source, /OverlayScrollArea/);
      assert.doesNotMatch(source, /rah-scroll-panel rah-scroll-panel-y/);
    }

    const councilSource = readSource("./council/CouncilPage.tsx");
    const newCouncilRoomSource = readSource("./council/NewCouncilRoomDialog.tsx");
    assert.match(councilSource, /scrollAriaLabel="Council agents"/);
    assert.match(newCouncilRoomSource, /scrollAriaLabel="New room settings"/);
    assert.match(newCouncilRoomSource, /viewportRef=\{bodyRef\}/);
    assert.match(councilSource, /scrollAriaLabel="Add agents"/);
    assert.match(councilSource, /scrollAriaLabel="Council mentions"/);
    assert.match(
      councilSource,
      /viewportClassName="max-h-\[calc\(84vh-4\.5rem\)\] p-3"/,
    );
    assert.match(
      councilSource,
      /viewportClassName="max-h-\[calc\(84vh-4\.5rem\)\] p-4"/,
    );
    assert.doesNotMatch(
      councilSource,
      /min-h-0 flex-1 overflow-y-auto rah-scroll-panel rah-scroll-panel-y p-3/,
    );
    assert.doesNotMatch(
      councilSource,
      /min-h-0 flex-1 space-y-3 overflow-y-auto rah-scroll-panel rah-scroll-panel-y p-4/,
    );
    assert.doesNotMatch(
      councilSource,
      /rah-popover-panel rah-scroll-panel rah-scroll-panel-y absolute bottom-full/,
    );
    for (const relativePath of [
      "./components/workbench/panes/WorkbenchEmptyPane.tsx",
      "./components/workbench/canvas/CanvasNewSessionPane.tsx",
    ]) {
      const source = readSource(relativePath);
      assert.match(source, /OverlayScrollArea/);
      assert.match(source, /scrollAriaLabel="Workspaces"/);
      assert.doesNotMatch(
        source,
        /rah-popover-panel rah-scroll-panel rah-scroll-panel-y absolute bottom-full/,
      );
    }
    assert.match(councilSource, /\brah-scroll-main\b/);
    assert.match(readSource("./components/chat/ChatThread.tsx"), /\brah-scroll-main\b/);
    assert.match(readSource("./components/terminal/TerminalSurface.tsx"), /\brah-scroll-code\b/);
  });
});
