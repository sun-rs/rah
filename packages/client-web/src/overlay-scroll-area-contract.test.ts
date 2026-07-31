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
    assert.match(OVERLAY_SCROLL_AREA_LAYOUT.fillShellClassName, /\boverflow-hidden\b/);
    assert.match(OVERLAY_SCROLL_AREA_LAYOUT.fillViewportClassName, /\babsolute\b/);
    assert.match(OVERLAY_SCROLL_AREA_LAYOUT.fillViewportClassName, /\binset-0\b/);
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
    assert.match(source, /fill\?: boolean/);
    assert.match(source, /data-rah-scroll-viewport="true"/);
    assert.match(source, /data-rah-scroll-fill=/);
  });

  test("keeps bounded picker lists inside their assigned flex area", () => {
    const filePickerSource = readSource("./components/FileReferencePicker.tsx");
    const workspacePickerSource = readSource("./components/WorkspacePicker.tsx");

    for (const source of [filePickerSource, workspacePickerSource]) {
      assert.match(source, /h-\[min\(85dvh,46rem\)\]/);
      assert.match(source, /max-h-\[calc\(100dvh-2rem\)\]/);
      assert.match(source, /flex-col overflow-hidden/);
      assert.match(source, /<OverlayScrollArea\s+fill/);
      assert.doesNotMatch(source, /viewportClassName="h-full px-4 pb-2"/);
    }
    assert.match(filePickerSource, /data-file-reference-picker-dialog=/);
    assert.match(filePickerSource, /data-file-reference-picker-footer=/);
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
    const newCouncilSource = readSource("./council/NewCouncilDialog.tsx");
    assert.match(councilSource, /scrollAriaLabel="Council agents"/);
    assert.match(newCouncilSource, /scrollAriaLabel="New Council settings"/);
    assert.match(newCouncilSource, /viewportRef=\{bodyRef\}/);
    assert.match(councilSource, /scrollAriaLabel="Add agents"/);
    assert.match(councilSource, /scrollAriaLabel="Council mentions"/);
    assert.match(
      councilSource,
      /viewportClassName="max-h-\[calc\(84vh-8rem\)\] p-3"/,
    );
    assert.match(councilSource, /aria-label="Search Councils"/);
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
    const newSessionComposerSource = readSource(
      "./components/workbench/panes/NewSessionComposer.tsx",
    );
    assert.match(newSessionComposerSource, /OverlayScrollArea/);
    assert.match(newSessionComposerSource, /workspacePickerOpen/);
    assert.doesNotMatch(
      newSessionComposerSource,
      /rah-popover-panel rah-scroll-panel rah-scroll-panel-y absolute bottom-full/,
    );
    assert.match(
      readSource("./components/workbench/panes/WorkbenchEmptyPane.tsx"),
      /NewSessionComposer/,
    );
    assert.match(
      readSource("./components/workbench/canvas/CanvasNewSessionPane.tsx"),
      /NewSessionComposer/,
    );
    assert.match(councilSource, /\brah-scroll-main\b/);
    assert.match(readSource("./components/chat/ChatThread.tsx"), /\brah-scroll-main\b/);
    assert.match(readSource("./components/terminal/TerminalSurface.tsx"), /\brah-scroll-code\b/);
  });

  test("chat thread restores sticky-bottom position after a background tab resumes", () => {
    const source = readSource("./components/chat/ChatThread.tsx");

    assert.match(source, /returnToBottomOnVisibleRef/);
    assert.match(source, /pendingVisibleBottomRestoreRef/);
    assert.match(source, /restoreBottomAfterForeground/);
    assert.match(source, /visibilitychange/);
    assert.match(source, /pageshow/);
    assert.match(source, /window\.addEventListener\("focus"/);
    assert.match(source, /isDocumentHidden\(\)/);
  });

  test("chat thread lets intentional upward scrolling break live bottom follow", () => {
    const source = readSource("./components/chat/ChatThread.tsx");

    assert.match(source, /userDetachedFromBottomRef/);
    assert.match(source, /detachBottomFollowing/);
    assert.match(source, /event\.deltaY < 0/);
    assert.match(source, /touchmove/);
    assert.match(source, /bottomFollowRafRef/);
    assert.match(source, /\[overflow-anchor:none\]/);
  });

  test("chat thread keeps bottom-follow stable when the viewport resizes", () => {
    const source = readSource("./components/chat/ChatThread.tsx");

    assert.match(source, /lastClientHeightRef/);
    assert.match(source, /VIEWPORT_RESIZE_EPSILON_PX/);
    assert.match(source, /settleScrollToBottomAfterResize/);
    assert.match(source, /const shouldFollowBottom =/);
    assert.match(source, /returnToBottomOnVisibleRef\.current/);
    assert.match(source, /scrollToBottomNow\(\)/);
  });

  test("chat thread virtual rows own their spacing so spacer math matches the DOM", () => {
    const source = readSource("./components/chat/ChatThread.tsx");

    assert.match(source, /VIRTUAL_FEED_ROW_GAP_PX/);
    assert.match(source, /const PROCESS_TO_FINAL_ROW_GAP_PX = 10/);
    assert.match(source, /return PROCESS_TO_FINAL_ROW_GAP_PX/);
    assert.match(source, /rowGapPx/);
    assert.match(source, /paddingBottom: `\$\{props\.rowGapPx\}px`/);
    assert.doesNotMatch(source, /space-y-5/);
  });

  test("chat thread preserves the visible row while prepending and only chains underfilled history", () => {
    const source = readSource("./components/chat/ChatThread.tsx");

    assert.match(source, /requestOlderHistoryLoad/);
    assert.match(source, /scheduleTopHistoryLoad/);
    assert.match(source, /isInTopHistoryLoadZone/);
    assert.match(source, /captureVisiblePrependAnchor/);
    assert.match(source, /restoreVisiblePrependAnchor/);
    assert.match(source, /schedulePrependAnchorRestore/);
    assert.match(source, /\[data-feed-entry-key\]/);
    assert.match(
      source,
      /props\.onLoadOlderHistory &&\n\s+hasTooLittleHistoryContent\(node\)/,
    );
    assert.doesNotMatch(
      source,
      /props\.onLoadOlderHistory &&\n\s+isInTopHistoryLoadZone\(node\)\n\s+\) \{\n\s+topHistoryAutoLoadArmedRef\.current = true;\n\s+scheduleTopHistoryLoad\(\)/,
    );
  });

  test("explicit conversation navigation resets to latest before layout positioning", () => {
    const source = readSource("./components/chat/ChatThread.tsx");

    assert.match(source, /navigationRevision\?: number/);
    assert.match(
      source,
      /useLayoutEffect\(\(\) => \{\n\s+previousEntryCountRef\.current = 0;[\s\S]*?sessionSwitchBottomLockRef\.current = true;[\s\S]*?node\.scrollTop = node\.scrollHeight;[\s\S]*?\}, \[props\.navigationRevision, props\.sessionId\]\)/,
    );
  });
});
