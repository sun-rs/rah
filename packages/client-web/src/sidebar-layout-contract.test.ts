import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { OVERLAY_SCROLL_AREA_LAYOUT } from "./components/OverlayScrollArea";
import { SIDEBAR_LAYOUT } from "./sidebar-layout-contract";
import {
  HEADER_SEGMENTED_BUTTON_ACTIVE_CLASS,
  HEADER_SEGMENTED_BUTTON_INACTIVE_CLASS,
  HEADER_SEGMENTED_CONTROL_BASE_CLASS,
} from "./components/workbench/header-button-styles";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("sidebar layout contract", () => {
  test("uses overlay scrollbars for the desktop sidebar content", () => {
    assert.match(OVERLAY_SCROLL_AREA_LAYOUT.viewportClassName, /\brah-scroll-overlay-area\b/);
    assert.doesNotMatch(SIDEBAR_LAYOUT.sidebarScrollClassName, /\brah-scroll-panel\b/);
    assert.doesNotMatch(SIDEBAR_LAYOUT.sidebarScrollClassName, /\brah-scroll-panel-y\b/);
    assert.match(OVERLAY_SCROLL_AREA_LAYOUT.shellClassName, /\brelative\b/);
    assert.match(OVERLAY_SCROLL_AREA_LAYOUT.trackClassName, /\babsolute\b/);
    assert.match(OVERLAY_SCROLL_AREA_LAYOUT.trackClassName, /\bright-0\b/);
    assert.match(OVERLAY_SCROLL_AREA_LAYOUT.trackClassName, /\btouch-none\b/);
    assert.match(OVERLAY_SCROLL_AREA_LAYOUT.thumbClassName, /\bw-1\b/);
    assert.match(OVERLAY_SCROLL_AREA_LAYOUT.thumbClassName, /\bcursor-grab\b/);
    assert.match(SIDEBAR_LAYOUT.sidebarScrollClassName, /\bh-full\b/);
    assert.match(SIDEBAR_LAYOUT.sidebarScrollClassName, /\bpr-0\.5\b/);
  });

  test("locks fixed action slots and row heights", () => {
    assert.match(SIDEBAR_LAYOUT.workspaceActionSlotClassName, /\babsolute\b/);
    assert.match(SIDEBAR_LAYOUT.workspaceActionSlotClassName, /\bright-0\b/);
    assert.match(SIDEBAR_LAYOUT.sessionPinButtonClassName, /\babsolute\b/);
    assert.match(SIDEBAR_LAYOUT.sessionPinButtonClassName, /\bright-1\b/);
    assert.match(SIDEBAR_LAYOUT.sessionPinButtonClassName, /\bh-7\b/);
    assert.match(SIDEBAR_LAYOUT.sessionPinButtonClassName, /\bw-7\b/);
    assert.match(SIDEBAR_LAYOUT.workspaceHeaderClassName, /\brelative\b/);
    assert.match(SIDEBAR_LAYOUT.workspaceHeaderClassName, /min-h-\[32px\]/);
    assert.match(SIDEBAR_LAYOUT.sessionRowBaseClassName, /min-h-\[32px\]/);
    assert.match(SIDEBAR_LAYOUT.sessionRowBaseClassName, /\bborder\b/);
  });

  test("locks sidebar indentation and meta width tokens", () => {
    assert.equal(SIDEBAR_LAYOUT.sessionListClassName, "space-y-0.5 pt-0.5 pl-0.5 pr-0.5");
    assert.match(SIDEBAR_LAYOUT.sessionTimeClassName, /min-w-\[2\.25rem\]/);
    assert.match(SIDEBAR_LAYOUT.sessionStatusBadgeBaseClassName, /text-\[10px\]/);
  });

  test("uses matched workspace and session icon slots for aligned titles", () => {
    assert.match(SIDEBAR_LAYOUT.workspaceToggleButtonClassName, /\bh-7\b/);
    assert.match(SIDEBAR_LAYOUT.workspaceToggleButtonClassName, /\bw-7\b/);
    assert.equal(SIDEBAR_LAYOUT.sessionIconSlotClassName, "inline-flex h-7 w-7 shrink-0 items-center justify-center");
    assert.equal(SIDEBAR_LAYOUT.sessionIconClassName, "h-4.5 w-4.5");
    assert.equal(SIDEBAR_LAYOUT.sessionTitleClassName, "min-w-0 flex-1 truncate text-[12px]");
    assert.match(SIDEBAR_LAYOUT.workspaceTitleButtonClassName, /\bpr-6\b/);
    assert.match(SIDEBAR_LAYOUT.workspaceTitleSelectedClassName, /font-semibold/);
  });

  test("gives selected sessions a modern neutral selection treatment", () => {
    assert.match(SIDEBAR_LAYOUT.sessionRowSelectedClassName, /color-mix\(in_oklab,var\(--app-subtle-bg\)/);
    assert.match(SIDEBAR_LAYOUT.sessionRowSelectedClassName, /0_8px_24px/);
    assert.doesNotMatch(SIDEBAR_LAYOUT.sessionRowSelectedClassName, /emerald/);
    assert.doesNotMatch(SIDEBAR_LAYOUT.sessionRowSelectedClassName, /inset_3px_0_0_0/);
  });

  test("keeps session status close to plain text instead of pill badges", () => {
    assert.doesNotMatch(SIDEBAR_LAYOUT.sessionStatusBadgeBaseClassName, /\bborder\b/);
    assert.doesNotMatch(SIDEBAR_LAYOUT.sessionStatusBadgeBaseClassName, /\brounded/);
    assert.doesNotMatch(SIDEBAR_LAYOUT.sessionStatusBadgeClassByStatus.ready, /\bbg-/);
  });

  test("keeps hidden hover actions non-interactive until revealed", () => {
    assert.match(SIDEBAR_LAYOUT.workspaceActionHiddenClassName, /pointer-events-none/);
    assert.match(SIDEBAR_LAYOUT.sessionPinHiddenClassName, /pointer-events-none/);
  });

  test("reveals hover-only actions for keyboard focus and coarse pointers", () => {
    assert.match(SIDEBAR_LAYOUT.workspaceActionHiddenClassName, /group-focus-within\/workspace:opacity-100/);
    assert.match(SIDEBAR_LAYOUT.workspaceActionHiddenClassName, /coarse-pointer-action-visible/);
    assert.match(SIDEBAR_LAYOUT.sessionPinHiddenClassName, /group-focus-within\/session:opacity-100/);
    assert.match(SIDEBAR_LAYOUT.sessionPinHiddenClassName, /coarse-pointer-action-visible/);
  });

  test("routes session and council pages through shared conversation chrome", () => {
    const sessionSource = readSource("./components/workbench/panes/WorkbenchSelectedPane.tsx");
    const councilSource = readSource("./council/CouncilPage.tsx");
    const headerSource = readSource("./components/workbench/shells/ConversationHeader.tsx");

    assert.match(sessionSource, /ConversationHeader/);
    assert.match(sessionSource, /ConversationPageShell/);
    assert.match(councilSource, /ConversationHeader/);
    assert.match(councilSource, /ConversationPageShell/);
    assert.match(headerSource, /closeAction/);
    assert.match(headerSource, /reserveRightPanelBreakpoint/);
    assert.match(headerSource, /ConversationHeaderIconButton/);
    assert.match(headerSource, /ConversationHeaderStopButton/);
    assert.match(headerSource, /ConversationHeaderMoreButton/);
    assert.match(headerSource, /ConversationHeaderPanelToggleButton/);
    assert.doesNotMatch(sessionSource, /HEADER_ICON_BUTTON_CLASS/);
    assert.doesNotMatch(councilSource, /HEADER_ICON_BUTTON_CLASS/);
  });

  test("uses a flat shared segmented control selected state", () => {
    const sessionSource = readSource("./components/workbench/panes/WorkbenchSelectedPane.tsx");
    const canvasSource = readSource("./components/workbench/canvas/CanvasWorkbench.tsx");

    assert.match(HEADER_SEGMENTED_CONTROL_BASE_CLASS, /color-mix\(in_oklab,var\(--app-border\)_78%/);
    assert.match(HEADER_SEGMENTED_BUTTON_ACTIVE_CLASS, /shadow-none/);
    assert.doesNotMatch(HEADER_SEGMENTED_BUTTON_ACTIVE_CLASS, /shadow-sm/);
    assert.match(HEADER_SEGMENTED_BUTTON_INACTIVE_CLASS, /hover:bg-/);
    assert.match(sessionSource, /HEADER_SEGMENTED_BUTTON_ACTIVE_CLASS/);
    assert.match(canvasSource, /HEADER_SEGMENTED_BUTTON_ACTIVE_CLASS/);
  });
});
