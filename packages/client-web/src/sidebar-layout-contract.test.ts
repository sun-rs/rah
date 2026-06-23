import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { OVERLAY_SCROLL_AREA_LAYOUT } from "./components/OverlayScrollArea";
import { SIDEBAR_LAYOUT } from "./sidebar-layout-contract";
import {
  SEGMENTED_CONTROL_ACTIVE_CLASS,
  SEGMENTED_CONTROL_NEUTRAL_ACTIVE_CLASS,
  SEGMENTED_CONTROL_SIZE_CLASSES,
} from "./components/segmented-control-styles";
import {
  HEADER_EDGE_TOGGLE_BUTTON_CLASS,
  HEADER_EDGE_TOGGLE_ICON_SIZE,
  HEADER_ICON_BUTTON_BASE_CLASS,
  HEADER_SEGMENTED_BUTTON_ACTIVE_CLASS,
  HEADER_SEGMENTED_BUTTON_BASE_CLASS,
  HEADER_SEGMENTED_BUTTON_INACTIVE_CLASS,
  HEADER_SEGMENTED_CONTROL_BASE_CLASS,
  HEADER_SEGMENTED_LABEL_CLASS,
  HEADER_SIDE_PANEL_TOGGLE_BUTTON_CLASS,
  HEADER_TEXT_BUTTON_BASE_CLASS,
  HEADER_RESPONSIVE_TEXT_BUTTON_CLASS,
  SIDEBAR_HEADER_ICON_BUTTON_CLASS,
  SIDEBAR_HEADER_ICON_SIZE,
  SIDEBAR_HEADER_LOGO_CLASS,
} from "./components/workbench/header-button-styles";
import {
  CONVERSATION_HEADER_META_ORDER,
  CONVERSATION_META_BADGE_BASE_CLASS,
  CONVERSATION_META_BADGE_ICON_CLASS,
  CONVERSATION_META_BADGE_LABEL_CLASS,
  CONVERSATION_META_BADGE_PADDING_CLASS,
  CONVERSATION_META_BADGE_TRAILING_SPACE_PADDING_CLASS,
  CONVERSATION_STATE_META_BADGE_ICON_CLASS,
  CONVERSATION_STATE_META_BADGE_LABEL_CLASS,
  CONVERSATION_STATE_META_BADGE_CLASS,
  orderConversationHeaderMetaItems,
} from "./components/workbench/ConversationMetaBadge";

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

  test("lets narrow sidebars give action buttons priority over labels", () => {
    const cssSource = readSource("./index.css");
    const shellSource = readSource("./components/workbench/shells/WorkbenchSidebarShell.tsx");
    const desktopHeaderSource = readSource("./components/workbench/actions/DesktopWorkbenchSidebarHeader.tsx");
    const mobileHeaderSource = readSource("./components/workbench/actions/MobileWorkbenchHeaderActions.tsx");
    const sidebarSource = readSource("./SessionSidebar.tsx");

    assert.match(shellSource, /rah-sidebar-header/);
    assert.match(shellSource, /aria-label="Collapse sidebar"/);
    assert.match(desktopHeaderSource, /rah-sidebar-header-actions/);
    assert.doesNotMatch(desktopHeaderSource, /onCollapseSidebar/);
    assert.doesNotMatch(desktopHeaderSource, /rah-sidebar-header-actions ml-auto/);
    assert.doesNotMatch(desktopHeaderSource, /rah-sidebar-header-brand/);
    assert.match(desktopHeaderSource, /SIDEBAR_HEADER_ICON_BUTTON_CLASS/);
    assert.match(desktopHeaderSource, /SIDEBAR_HEADER_ICON_SIZE/);
    assert.match(desktopHeaderSource, /SIDEBAR_HEADER_LOGO_CLASS/);
    assert.match(mobileHeaderSource, /SIDEBAR_HEADER_ICON_BUTTON_CLASS/);
    assert.match(mobileHeaderSource, /SIDEBAR_HEADER_ICON_SIZE/);
    assert.match(mobileHeaderSource, /SIDEBAR_HEADER_LOGO_CLASS/);
    assert.match(shellSource, /headerLayout="inline"/);
    assert.match(shellSource, /closePlacement="start"/);
    assert.match(shellSource, /viewportClassName="md:hidden"/);
    assert.match(shellSource, /SIDEBAR_HEADER_ICON_BUTTON_CLASS/);
    assert.match(shellSource, /SIDEBAR_HEADER_ICON_SIZE/);
    assert.match(SIDEBAR_HEADER_ICON_BUTTON_CLASS, /\bh-8\b/);
    assert.match(SIDEBAR_HEADER_ICON_BUTTON_CLASS, /\bw-8\b/);
    assert.match(SIDEBAR_HEADER_ICON_BUTTON_CLASS, /\bshrink-0\b/);
    assert.equal(SIDEBAR_HEADER_ICON_SIZE, 20);
    assert.equal(SIDEBAR_HEADER_LOGO_CLASS, "h-5 w-5");
    assert.match(SIDEBAR_LAYOUT.rootClassName, /rah-sidebar-content/);
    assert.match(sidebarSource, /toolbarLabelFullClassName/);
    assert.match(sidebarSource, /toolbarLabelShortClassName/);
    assert.doesNotMatch(shellSource, /gap-1/);
    assert.match(cssSource, /--rah-sidebar-header-gap/);
    assert.match(cssSource, /calc\(\(var\(--rah-sidebar-width, 288px\) - 208px\) \/ 20\)/);
    assert.match(cssSource, /@container rah-sidebar-header \(max-width: 224px\)/);
    assert.doesNotMatch(cssSource, /\.rah-sidebar-header-brand/);
    assert.match(cssSource, /justify-content:\s*flex-start/);
    assert.match(cssSource, /@container rah-sidebar-content \(max-width: 212px\)/);
    assert.match(cssSource, /\.rah-sidebar-workspaces-label-full/);
    assert.match(cssSource, /\.rah-sidebar-workspaces-label-short/);
  });

  test("keeps sidebar resizing out of the React render hot path", () => {
    const shellSource = readSource("./components/workbench/shells/WorkbenchSidebarShell.tsx");
    const chromeStateSource = readSource("./hooks/useWorkbenchChromeState.ts");

    assert.match(shellSource, /var\(--rah-sidebar-width/);
    assert.match(shellSource, /props\.isResizing \? "duration-0" : "duration-200"/);
    assert.match(chromeStateSource, /SIDEBAR_WIDTH_CSS_VAR = "--rah-sidebar-width"/);
    assert.match(chromeStateSource, /SIDEBAR_MIN_WIDTH = 208/);
    assert.match(chromeStateSource, /requestAnimationFrame/);
    assert.match(chromeStateSource, /applySidebarWidthCss\(nextWidth\)|pendingSidebarWidthRef/);
    assert.doesNotMatch(
      chromeStateSource,
      /setSidebarWidth\(Math\.max\(200,\s*Math\.min\(480,\s*event\.clientX\)\)\)/,
    );
  });

  test("keeps mobile sheets from coexisting with desktop sidebars after rotation", () => {
    const appSource = readSource("./App.tsx");
    const sheetSource = readSource("./components/Sheet.tsx");
    const shellSource = readSource("./components/workbench/shells/WorkbenchSidebarShell.tsx");
    const sidePanelSource = readSource("./components/workbench/shells/ConversationSidePanelShell.tsx");
    const chromeStateSource = readSource("./hooks/useWorkbenchChromeState.ts");

    assert.match(sheetSource, /viewportClassName/);
    assert.match(sheetSource, /Dialog\.Overlay[\s\S]*props\.viewportClassName/);
    assert.match(sheetSource, /Dialog\.Content[\s\S]*props\.viewportClassName/);
    assert.match(shellSource, /viewportClassName="md:hidden"/);
    assert.match(sidePanelSource, /mobileViewportClassName/);
    assert.match(sidePanelSource, /breakpoint === "wide" \? "min-\[900px\]:hidden" : "md:hidden"/);
    assert.match(sidePanelSource, /viewportClassName=\{mobileViewportClassName\}/);
    assert.match(chromeStateSource, /DESKTOP_SHEET_BREAKPOINT_PX = 768/);
    assert.match(chromeStateSource, /viewportWidthPx < DESKTOP_SHEET_BREAKPOINT_PX/);
    assert.match(chromeStateSource, /setLeftOpen\(\(current\) => \(current \? false : current\)\)/);
    assert.match(chromeStateSource, /setRightOpen\(\(current\) => \(current \? false : current\)\)/);
    assert.match(appSource, /showPrimaryLeftSidebarControls = !leftOpen/);
    assert.match(appSource, /showLeftSidebarControls=\{showPrimaryLeftSidebarControls\}/);
  });

  test("overlays the sidebar resize target on the boundary without a visible gutter", () => {
    const cssSource = readSource("./index.css");
    const shellSource = readSource("./components/workbench/shells/WorkbenchSidebarShell.tsx");

    assert.match(shellSource, /props\.sidebarOpen \? "border-r border-\[var\(--app-border\)\]" : "border-r-0"/);
    assert.match(cssSource, /\.resize-handle\s*\{[^}]*margin-left:\s*-6px/s);
    assert.match(cssSource, /\.resize-handle\s*\{[^}]*margin-right:\s*-6px/s);
    assert.match(cssSource, /\.resize-handle\s*\{[^}]*z-index:\s*30/s);
    assert.match(cssSource, /\.resize-handle::after\s*\{[^}]*opacity:\s*0;/s);
    assert.match(cssSource, /\.resize-handle:hover::after,\s*\.resize-handle\.dragging::after\s*\{[^}]*opacity:\s*0\.35;/s);
  });

  test("overlays shared right side panel dividers without a visible gutter", () => {
    const cssSource = readSource("./index.css");
    const sidePanelSource = readSource("./components/workbench/shells/ConversationSidePanelShell.tsx");

    assert.match(sidePanelSource, /inspector-divider/);
    assert.match(sidePanelSource, /props\.desktopOpen \? "border-l border-\[var\(--app-border\)\]" : "border-l-0"/);
    assert.match(cssSource, /\.inspector-divider\s*\{[^}]*margin-left:\s*-6px/s);
    assert.match(cssSource, /\.inspector-divider\s*\{[^}]*margin-right:\s*-6px/s);
    assert.match(cssSource, /\.inspector-divider\s*\{[^}]*z-index:\s*30/s);
    assert.match(cssSource, /\.inspector-divider::after\s*\{[^}]*opacity:\s*0;/s);
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
    assert.match(headerSource, /compactCloseAction/);
    assert.match(sessionSource, /compactCloseAction=\{isPwaDisplayMode\}/);
    assert.match(councilSource, /compactCloseAction=\{isPwaDisplayMode\}/);
    assert.match(headerSource, /reserveRightPanelBreakpoint/);
    assert.match(headerSource, /ConversationHeaderIconButton/);
    assert.match(headerSource, /ConversationHeaderStopButton/);
    assert.match(headerSource, /ConversationHeaderMoreButton/);
    assert.match(headerSource, /ConversationHeaderPanelToggleButton/);
    assert.doesNotMatch(sessionSource, /HEADER_ICON_BUTTON_CLASS/);
    assert.doesNotMatch(councilSource, /HEADER_ICON_BUTTON_CLASS/);
  });

  test("uses a clear non-raised shared segmented control selected state", () => {
    const sessionSource = readSource("./components/workbench/panes/WorkbenchSelectedPane.tsx");
    const canvasSource = readSource("./components/workbench/canvas/CanvasWorkbench.tsx");

    assert.match(HEADER_SEGMENTED_CONTROL_BASE_CLASS, /color-mix\(in_oklab,var\(--app-border\)_78%/);
    assert.match(HEADER_SEGMENTED_BUTTON_BASE_CLASS, /leading-none/);
    assert.match(HEADER_SEGMENTED_LABEL_CLASS, /-top-px/);
    assert.match(HEADER_SEGMENTED_LABEL_CLASS, /leading-none/);
    assert.match(HEADER_SEGMENTED_BUTTON_ACTIVE_CLASS, /shadow-none/);
    assert.match(HEADER_SEGMENTED_BUTTON_ACTIVE_CLASS, /ring-inset/);
    assert.match(HEADER_SEGMENTED_BUTTON_ACTIVE_CLASS, /sky-/);
    assert.doesNotMatch(HEADER_SEGMENTED_BUTTON_ACTIVE_CLASS, /shadow-sm/);
    assert.match(HEADER_SEGMENTED_BUTTON_INACTIVE_CLASS, /hover:bg-/);
    assert.match(sessionSource, /HEADER_SEGMENTED_BUTTON_ACTIVE_CLASS/);
    assert.match(sessionSource, /HEADER_SEGMENTED_LABEL_CLASS/);
    assert.match(canvasSource, /HEADER_SEGMENTED_BUTTON_ACTIVE_CLASS/);
    assert.match(canvasSource, /HEADER_SEGMENTED_LABEL_CLASS/);
  });

  test("keeps stable-border header buttons from drawing double borders", () => {
    for (const className of [
      HEADER_ICON_BUTTON_BASE_CLASS,
      HEADER_TEXT_BUTTON_BASE_CLASS,
      HEADER_RESPONSIVE_TEXT_BUTTON_CLASS,
    ]) {
      assert.match(className, /\brah-stable-border\b/);
      assert.match(className, /\bborder-transparent\b/);
      assert.doesNotMatch(className, /\bborder-\[var\(--app-border\)\]/);
    }
  });

  test("uses one edge-toggle protocol for sidebar and side-panel controls", () => {
    const appSource = readSource("./App.tsx");
    const councilSource = readSource("./council/CouncilPage.tsx");
    const sheetSource = readSource("./components/Sheet.tsx");
    const shellSource = readSource("./components/workbench/shells/WorkbenchSidebarShell.tsx");
    const headerSource = readSource("./components/workbench/shells/ConversationHeader.tsx");
    const sidePanelSource = readSource("./components/workbench/shells/ConversationSidePanelShell.tsx");
    const emptyPaneSource = readSource("./components/workbench/panes/WorkbenchEmptyPane.tsx");
    const openingPaneSource = readSource("./components/workbench/panes/WorkbenchOpeningPane.tsx");
    const canvasSource = readSource("./components/workbench/canvas/CanvasWorkbench.tsx");
    const inspectorHeaderSource = readSource("./inspector/InspectorHeader.tsx");

    assert.equal(HEADER_EDGE_TOGGLE_ICON_SIZE, 20);
    assert.match(HEADER_EDGE_TOGGLE_BUTTON_CLASS, /\bh-8\b/);
    assert.match(HEADER_EDGE_TOGGLE_BUTTON_CLASS, /\bw-8\b/);
    assert.match(HEADER_EDGE_TOGGLE_BUTTON_CLASS, /\bshrink-0\b/);
    assert.doesNotMatch(HEADER_EDGE_TOGGLE_BUTTON_CLASS, /\bborder\b/);
    assert.doesNotMatch(HEADER_EDGE_TOGGLE_BUTTON_CLASS, /\brah-stable-border\b/);
    assert.equal(HEADER_SIDE_PANEL_TOGGLE_BUTTON_CLASS, HEADER_EDGE_TOGGLE_BUTTON_CLASS);

    for (const source of [
      sheetSource,
      shellSource,
      headerSource,
      sidePanelSource,
      emptyPaneSource,
      openingPaneSource,
      canvasSource,
    ]) {
      assert.match(source, /HEADER_EDGE_TOGGLE_ICON_SIZE/);
    }

    assert.match(headerSource, /md:pr-11/);
    assert.match(headerSource, /min-\[900px\]:pr-11/);
    assert.match(emptyPaneSource, /md:pr-11/);
    assert.match(openingPaneSource, /md:pr-11/);
    assert.match(appSource, /pr-11/);
    assert.match(councilSource, /pr-11/);
    assert.match(inspectorHeaderSource, /pr-11/);

    for (const source of [
      appSource,
      councilSource,
      shellSource,
      headerSource,
      emptyPaneSource,
      openingPaneSource,
      canvasSource,
      inspectorHeaderSource,
    ]) {
      assert.doesNotMatch(source, /<Menu size=\{18\}/);
      assert.doesNotMatch(source, /pr-14/);
      assert.doesNotMatch(source, /2\.75rem/);
      assert.doesNotMatch(source, /safe-area-inset-right\)\+2\.75rem/);
    }

    for (const source of [
      sheetSource,
      headerSource,
      sidePanelSource,
      emptyPaneSource,
      openingPaneSource,
    ]) {
      assert.doesNotMatch(source, /<PanelRight size=\{16\}/);
      assert.doesNotMatch(source, /<X size=\{16\}/);
    }
  });

  test("uses shared segmented controls for dialog and panel tabs", () => {
    const sources = [
      readSource("./components/SessionHistoryDialog.tsx"),
      readSource("./components/ThemeToggle.tsx"),
      readSource("./inspector/InspectorHeader.tsx"),
      readSource("./inspector/InspectorFileDetailDialog.tsx"),
    ];

    assert.match(SEGMENTED_CONTROL_ACTIVE_CLASS, /shadow-none/);
    assert.match(SEGMENTED_CONTROL_ACTIVE_CLASS, /ring-inset/);
    assert.match(SEGMENTED_CONTROL_ACTIVE_CLASS, /sky-/);
    assert.match(SEGMENTED_CONTROL_NEUTRAL_ACTIVE_CLASS, /bg-\[var\(--app-bg\)\]/);
    assert.match(SEGMENTED_CONTROL_NEUTRAL_ACTIVE_CLASS, /shadow-sm/);
    assert.doesNotMatch(SEGMENTED_CONTROL_NEUTRAL_ACTIVE_CLASS, /after:/);
    assert.doesNotMatch(SEGMENTED_CONTROL_NEUTRAL_ACTIVE_CLASS, /ring-/);
    assert.doesNotMatch(SEGMENTED_CONTROL_NEUTRAL_ACTIVE_CLASS, /sky-/);
    assert.match(SEGMENTED_CONTROL_SIZE_CLASSES.dialog.button, /min-h-9/);
    assert.match(SEGMENTED_CONTROL_SIZE_CLASSES.panel.button, /min-h-8/);
    assert.match(SEGMENTED_CONTROL_SIZE_CLASSES.compact.button, /min-h-7/);
    assert.equal(SEGMENTED_CONTROL_SIZE_CLASSES.header.active, SEGMENTED_CONTROL_ACTIVE_CLASS);
    assert.equal(SEGMENTED_CONTROL_SIZE_CLASSES.dialog.active, SEGMENTED_CONTROL_NEUTRAL_ACTIVE_CLASS);
    assert.equal(SEGMENTED_CONTROL_SIZE_CLASSES.panel.active, SEGMENTED_CONTROL_NEUTRAL_ACTIVE_CLASS);
    assert.equal(SEGMENTED_CONTROL_SIZE_CLASSES.compact.active, SEGMENTED_CONTROL_NEUTRAL_ACTIVE_CLASS);

    for (const source of sources) {
      assert.match(source, /SegmentedControl/);
      assert.match(source, /SegmentedButton/);
      assert.doesNotMatch(source, /shadow-sm/);
    }
  });

  test("keeps desktop right-panel toggles owned by the side panel shell", () => {
    const appSource = readSource("./App.tsx");
    const canvasSource = readSource("./components/workbench/canvas/CanvasSessionPane.tsx");
    const councilSource = readSource("./council/CouncilPage.tsx");
    const sidePanelSource = readSource("./components/workbench/shells/ConversationSidePanelShell.tsx");
    const emptyPaneSource = readSource("./components/workbench/panes/WorkbenchEmptyPane.tsx");
    const openingPaneSource = readSource("./components/workbench/panes/WorkbenchOpeningPane.tsx");
    const boundarySource = readSource("./components/workbench/WorkbenchErrorBoundary.tsx");

    assert.match(sidePanelSource, /props\.onToggle \?/);
    assert.doesNotMatch(sidePanelSource, /props\.onToggle && props\.desktopOpen/);
    assert.match(sidePanelSource, /SIDE_PANEL_TOGGLE_STYLE/);
    assert.match(sidePanelSource, /position:\s*"absolute"/);
    assert.match(sidePanelSource, /aria-pressed=\{props\.desktopOpen\}/);
    assert.match(sidePanelSource, /HEADER_SIDE_PANEL_TOGGLE_BUTTON_CLASS/);
    assert.match(emptyPaneSource, /HEADER_SIDE_PANEL_TOGGLE_BUTTON_CLASS/);
    assert.match(openingPaneSource, /HEADER_SIDE_PANEL_TOGGLE_BUTTON_CLASS/);
    assert.doesNotMatch(sidePanelSource, /HEADER_ICON_BUTTON_CLASS/);
    assert.doesNotMatch(emptyPaneSource, /border border-\[var\(--app-border\)\][\s\S]{0,160}PanelRight/);
    assert.doesNotMatch(openingPaneSource, /border border-\[var\(--app-border\)\][\s\S]{0,160}PanelRight/);
    assert.match(HEADER_SIDE_PANEL_TOGGLE_BUTTON_CLASS, /\bhover:bg-\[var\(--app-subtle-bg\)\]/);
    assert.doesNotMatch(HEADER_SIDE_PANEL_TOGGLE_BUTTON_CLASS, /\bborder\b/);
    assert.doesNotMatch(HEADER_SIDE_PANEL_TOGGLE_BUTTON_CLASS, /\brah-stable-border\b/);
    assert.match(appSource, /showInspectorToggle=\{!rightOpen && !rightSidebarOpen\}/);
    assert.match(appSource, /inspectorToggleClassName="md:hidden"/);
    assert.match(appSource, /reserveInspectorToggleSlot = !rightSidebarOpen && !rightOpen/);
    assert.match(appSource, /reserveRightPanelToggleSpace=\{reserveInspectorToggleSlot\}/);
    assert.doesNotMatch(appSource, /canvasMaximizedPaneId[\s\S]{0,320}setCanvasPaneRightPanelsOpen/);
    assert.doesNotMatch(appSource, /ProviderLogo[\s\S]{0,120}renderPaneToolbar/);
    assert.doesNotMatch(appSource, /renderPaneToolbar[\s\S]{0,360}ProviderLogo/);
    assert.match(canvasSource, /showInspectorToggle=\{!inspectorOpen\}/);
    assert.match(canvasSource, /inspectorToggleClassName=\{sidePanelAvailable \? "min-\[900px\]:hidden" : ""\}/);
    assert.match(canvasSource, /reserveRightPanelToggleSpace=\{sidePanelAvailable && !inspectorOpen\}/);
    assert.match(canvasSource, /reserveRightPanelBreakpoint="wide"/);
    assert.match(councilSource, /showAgentsToggle && !isCouncilWide/);
    assert.match(
      councilSource,
      /reserveRightPanelToggleSpace=\{showAgentsToggle && isCouncilWide && !councilSidebarOpen\}/,
    );
    assert.match(appSource, /loadInspectorPane/);
    assert.match(appSource, /importWithStaleReload/);
    assert.match(appSource, /FilePreviewDialogErrorBoundary/);
    assert.doesNotMatch(appSource, /loadInspectorFileDetailDialog/);
    assert.doesNotMatch(appSource, /FilePreviewDialogLoadingFallback/);
    assert.match(appSource, /title="Inspector crashed"/);
    assert.match(boundarySource, /isLikelyStaleDynamicImportError/);

    const apiSource = readSource("./api.ts");
    assert.match(apiSource, /function imagePreviewClientHint/);
    assert.match(apiSource, /imagePreviewClient/);
    assert.match(apiSource, /a === 192 && b === 168/);
    assert.match(apiSource, /readHostFile\(path: string\)/);
  });

  test("keeps constrained desktop home and council layouts responsive", () => {
    const emptyPaneSource = readSource("./components/workbench/panes/WorkbenchEmptyPane.tsx");
    const newComposerSource = readSource("./components/workbench/panes/NewSessionComposer.tsx");
    const councilSource = readSource("./council/CouncilPage.tsx");

    assert.match(emptyPaneSource, /providerSelectorMode="auto"/);
    assert.match(newComposerSource, /max-w-\[min\(42rem,100%\)\]/);
    assert.match(councilSource, /matchMedia\("\(min-width: 768px\)"\)/);
    assert.match(councilSource, /desktopBreakpoint="md"/);
    assert.match(councilSource, /mobileOpen=\{councilSidebarOpen && !isCouncilWide\}/);
  });

  test("routes session and council title pills through shared meta badge structure", () => {
    const sessionSource = readSource("./components/workbench/panes/WorkbenchSelectedPane.tsx");
    const councilSource = readSource("./council/CouncilPage.tsx");
    const headerSource = readSource("./components/workbench/shells/ConversationHeader.tsx");
    const metaSource = readSource("./components/workbench/ConversationMetaBadge.tsx");
    const cssSource = readSource("./index.css");

    assert.deepEqual(CONVERSATION_HEADER_META_ORDER, ["status", "context", "count", "source"]);
    assert.deepEqual(
      orderConversationHeaderMetaItems([
        { slot: "source", node: "source" },
        { slot: "count", node: "count" },
        { slot: "status", node: "status" },
        { slot: "context", node: "context" },
      ]).map((item) => item.slot),
      ["status", "context", "count", "source"],
    );
    assert.match(CONVERSATION_META_BADGE_BASE_CLASS, /conversation-meta-badge/);
    assert.match(CONVERSATION_META_BADGE_BASE_CLASS, /h-\[22px\]/);
    assert.match(CONVERSATION_META_BADGE_BASE_CLASS, /text-\[11px\]/);
    assert.match(CONVERSATION_META_BADGE_BASE_CLASS, /leading-none/);
    assert.match(cssSource, /\.conversation-meta-badge/);
    assert.doesNotMatch(cssSource, /\.conversation-meta-badge-pwa/);
    assert.doesNotMatch(cssSource, /--conversation-meta-label-y/);
    assert.match(cssSource, /--conversation-meta-label-optical-y:\s*0px/);
    assert.match(
      cssSource,
      /@media\s*\(hover:\s*hover\)\s*and\s*\(pointer:\s*fine\)\s*\{[^}]*\.conversation-meta-badge\s*\{[^}]*--conversation-meta-label-optical-y:\s*-0\.5px/s,
    );
    assert.match(cssSource, /translateY\(var\(--conversation-meta-label-optical-y\)\)/);
    assert.match(cssSource, /\.conversation-meta-badge-label/);
    assert.match(cssSource, /text-size-adjust:\s*100%/);
    assert.match(
      cssSource,
      /\.conversation-meta-badge\s*\{[^}]*font-family:\s*system-ui,\s*-apple-system,\s*BlinkMacSystemFont/s,
    );
    assert.doesNotMatch(
      cssSource,
      /\.conversation-meta-badge\s*\{[^}]*font-family:\s*var\(--font-sans\)/s,
    );
    assert.match(CONVERSATION_META_BADGE_ICON_CLASS, /items-center/);
    assert.match(CONVERSATION_META_BADGE_ICON_CLASS, /\[\&>svg\]:block/);
    assert.match(CONVERSATION_META_BADGE_ICON_CLASS, /h-3\.5/);
    assert.match(CONVERSATION_META_BADGE_ICON_CLASS, /w-3\.5/);
    assert.doesNotMatch(CONVERSATION_META_BADGE_ICON_CLASS, /\btop-/);
    assert.doesNotMatch(CONVERSATION_META_BADGE_ICON_CLASS, /-top-/);
    assert.match(CONVERSATION_META_BADGE_LABEL_CLASS, /conversation-meta-badge-label/);
    assert.match(CONVERSATION_META_BADGE_LABEL_CLASS, /block/);
    assert.match(CONVERSATION_META_BADGE_LABEL_CLASS, /leading-\[14px\]/);
    assert.doesNotMatch(CONVERSATION_META_BADGE_LABEL_CLASS, /\btop-/);
    assert.doesNotMatch(CONVERSATION_META_BADGE_LABEL_CLASS, /-top-/);
    assert.equal(CONVERSATION_META_BADGE_PADDING_CLASS, "px-1.5");
    assert.equal(CONVERSATION_META_BADGE_TRAILING_SPACE_PADDING_CLASS, "pl-1.5 pr-2.5");
    assert.match(
      metaSource,
      /paddingClassName=\{CONVERSATION_META_BADGE_TRAILING_SPACE_PADDING_CLASS\}/,
    );
    assert.doesNotMatch(metaSource, /props\.state\.icon === "running"/);
    assert.equal(CONVERSATION_STATE_META_BADGE_CLASS, "");
    assert.doesNotMatch(CONVERSATION_STATE_META_BADGE_CLASS, /w-\[4\.75rem\]/);
    assert.doesNotMatch(CONVERSATION_STATE_META_BADGE_CLASS, /w-16/);
    assert.equal(CONVERSATION_STATE_META_BADGE_ICON_CLASS, CONVERSATION_META_BADGE_ICON_CLASS);
    assert.equal(CONVERSATION_STATE_META_BADGE_LABEL_CLASS, CONVERSATION_META_BADGE_LABEL_CLASS);
    assert.doesNotMatch(CONVERSATION_STATE_META_BADGE_ICON_CLASS, /absolute/);
    assert.doesNotMatch(CONVERSATION_STATE_META_BADGE_LABEL_CLASS, /w-full/);
    assert.doesNotMatch(CONVERSATION_STATE_META_BADGE_LABEL_CLASS, /text-center/);
    assert.match(sessionSource, /ConversationHeaderMetaList/);
    assert.match(sessionSource, /CONVERSATION_META_BADGE_PADDING_CLASS/);
    assert.doesNotMatch(sessionSource, /CONVERSATION_META_BADGE_PWA_CLASS/);
    assert.doesNotMatch(sessionSource, /sessionMetaBadgeClassName/);
    assert.match(
      sessionSource,
      /compactSessionMeta\s+\?\s+CONVERSATION_META_BADGE_PADDING_CLASS\s+:\s+CONVERSATION_META_BADGE_TRAILING_SPACE_PADDING_CLASS/,
    );
    assert.match(councilSource, /ConversationHeaderMetaList/);
    assert.doesNotMatch(councilSource, /CONVERSATION_META_BADGE_PWA_CLASS/);
    assert.doesNotMatch(councilSource, /councilMetaBadgeClassName/);
    assert.match(councilSource, /Start or open a Council to coordinate agents\./);
    assert.match(councilSource, /CONVERSATION_META_BADGE_TRAILING_SPACE_PADDING_CLASS/);
    assert.match(headerSource, /min-h-\[22px\]/);
    assert.match(councilSource, /const compactCouncilMeta = isPwaDisplayMode \|\| !isCouncilWide;/);
    assert.match(councilSource, /presentation=\{selectedCouncil \? "conversation" : "page"\}/);
    assert.match(councilSource, /identity=\{selectedCouncil \? <CouncilLogo className="h-6 w-6" \/> : undefined\}/);
    assert.match(councilSource, /icon=\{<Bot className="h-3\.5 w-3\.5" aria-hidden="true" \/>\}/);
    assert.match(
      councilSource,
      /label=\{compactCouncilMeta \? selectedCouncil\.agents\.length : selectedCouncilAgentCountLabel\}\s+paddingClassName=\{CONVERSATION_META_BADGE_TRAILING_SPACE_PADDING_CLASS\}/,
    );
    assert.doesNotMatch(sessionSource, /function ConversationHeaderStateIconView/);
    assert.doesNotMatch(councilSource, /function ConversationHeaderStateIconView/);
    assert.match(metaSource, /ConversationHeaderStateIconView/);
  });

  test("keeps council icon tone scoped by surface", () => {
    const councilLogoSource = readSource("./components/CouncilLogo.tsx");
    const desktopHeaderSource = readSource("./components/workbench/actions/DesktopWorkbenchSidebarHeader.tsx");
    const mobileHeaderSource = readSource("./components/workbench/actions/MobileWorkbenchHeaderActions.tsx");
    const sidebarSource = readSource("./SessionSidebar.tsx");
    const councilSource = readSource("./council/CouncilPage.tsx");
    const appSource = readSource("./App.tsx");
    const canvasSource = readSource("./components/workbench/canvas/CanvasWorkbench.tsx");
    const emptyPaneSource = readSource("./components/workbench/panes/WorkbenchEmptyPane.tsx");
    const canvasNewPaneSource = readSource("./components/workbench/canvas/CanvasNewSessionPane.tsx");

    assert.match(councilLogoSource, /tone\?: "orange" \| "black"/);
    assert.match(councilLogoSource, /const tone = props\.tone \?\? "orange"/);
    assert.match(councilLogoSource, /import \{ UsersRound \} from "lucide-react"/);
    assert.doesNotMatch(councilLogoSource, /council\.png/);
    assert.match(councilLogoSource, /blackIconClassName/);
    assert.match(councilLogoSource, /text-black\/90/);
    assert.match(councilLogoSource, /h-full w-full text-current/);
    assert.doesNotMatch(councilLogoSource, /h-full w-full text-black\/90/);
    assert.match(councilLogoSource, /h-full w-full text-orange-700\/90/);
    assert.match(desktopHeaderSource, /<CouncilLogo className=\{SIDEBAR_HEADER_LOGO_CLASS\} tone="black" variant="bare" \/>/);
    assert.match(mobileHeaderSource, /<CouncilLogo className=\{SIDEBAR_HEADER_LOGO_CLASS\} tone="black" variant="bare" \/>/);
    assert.match(sidebarSource, /<CouncilLogo className="h-4 w-4" tone="black" variant="bare" \/>/);
    assert.match(emptyPaneSource, /<CouncilLogo className="h-4 w-4" tone="black" variant="bare" \/>/);
    assert.match(canvasNewPaneSource, /<CouncilLogo className="h-4 w-4" tone="black" variant="bare" \/>/);
    assert.doesNotMatch(councilSource, /COUNCIL_HEADER_ICON_CLASSNAME/);
    assert.match(councilSource, /identity=\{selectedCouncil \? <CouncilLogo className="h-6 w-6" \/> : undefined\}/);
    assert.doesNotMatch(appSource, /CouncilLogo/);
    assert.doesNotMatch(appSource, /renderPaneToolbar/);
    assert.doesNotMatch(canvasSource, /CouncilLogo/);
  });
});
