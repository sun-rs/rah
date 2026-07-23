import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { OVERLAY_SCROLL_AREA_LAYOUT } from "./components/OverlayScrollArea";
import { SIDEBAR_LAYOUT } from "./sidebar-layout-contract";
import {
  SEGMENTED_CONTROL_ACTIVE_CLASS,
  SEGMENTED_CONTROL_FLAT_ACTIVE_CLASS,
  SEGMENTED_CONTROL_NEUTRAL_ACTIVE_CLASS,
  SEGMENTED_CONTROL_SIZE_CLASSES,
} from "./components/segmented-control-styles";
import {
  HEADER_EDGE_TOGGLE_BUTTON_CLASS,
  HEADER_EDGE_TOGGLE_ICON_SIZE,
  HEADER_ICON_BUTTON_CLASS,
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
  CONVERSATION_META_INLINE_BASE_CLASS,
  CONVERSATION_META_INLINE_ICON_CLASS,
  CONVERSATION_META_INLINE_LABEL_CLASS,
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
    assert.match(SIDEBAR_LAYOUT.sessionActionSlotClassName, /\babsolute\b/);
    assert.match(SIDEBAR_LAYOUT.sessionActionSlotClassName, /\bflex\b/);
    assert.match(SIDEBAR_LAYOUT.sessionActionSlotClassName, /\bright-0\b/);
    assert.doesNotMatch(SIDEBAR_LAYOUT.sessionActionButtonClassName, /\babsolute\b/);
    assert.match(SIDEBAR_LAYOUT.sessionActionButtonClassName, /\bh-8\b/);
    assert.match(SIDEBAR_LAYOUT.sessionActionButtonClassName, /\bw-8\b/);
    assert.match(SIDEBAR_LAYOUT.sessionActionButtonClassName, /md:h-7/);
    assert.match(SIDEBAR_LAYOUT.sessionActionButtonClassName, /md:w-7/);
    assert.match(SIDEBAR_LAYOUT.sessionDualActionPaddingClassName, /group-hover\/session:pr-16/);
    assert.match(SIDEBAR_LAYOUT.sessionDualActionPaddingClassName, /md:group-hover\/session:pr-14/);
    assert.match(SIDEBAR_LAYOUT.sessionPinnedActionPaddingClassName, /\bpr-16\b/);
    assert.match(SIDEBAR_LAYOUT.sessionPinnedActionPaddingClassName, /md:pr-14/);
    assert.match(SIDEBAR_LAYOUT.workspaceHeaderClassName, /\brelative\b/);
    assert.match(SIDEBAR_LAYOUT.workspaceHeaderClassName, /min-h-\[34px\]/);
    assert.match(SIDEBAR_LAYOUT.workspaceHeaderClassName, /md:min-h-\[28px\]/);
    assert.match(SIDEBAR_LAYOUT.sessionRowBaseClassName, /min-h-\[34px\]/);
    assert.match(SIDEBAR_LAYOUT.sessionRowBaseClassName, /md:min-h-\[28px\]/);
    assert.match(SIDEBAR_LAYOUT.sessionRowBaseClassName, /\bborder\b/);
  });

  test("keeps blocked workspace removal inert without retargeting the tap", () => {
    const sidebarSource = readSource("./SessionSidebar.tsx");

    assert.match(sidebarSource, /aria-disabled=\{workspaceRemovalBlocked\}/);
    assert.match(
      sidebarSource,
      /onPointerDown=\{\(event\) => \{\s*event\.stopPropagation\(\);/,
    );
    assert.match(sidebarSource, /if \(workspaceRemovalBlocked\) \{\s*return;/);
    assert.doesNotMatch(
      sidebarSource,
      /disabled=\{props\.workspace\.hasBlockingRunningSessions\}/,
    );
    assert.match(SIDEBAR_LAYOUT.workspaceActionDisabledClassName, /cursor-not-allowed/);
    assert.match(SIDEBAR_LAYOUT.workspaceActionDisabledClassName, /opacity-30/);
  });

  test("uses a fixed header and vertical desktop navigation", () => {
    const cssSource = readSource("./index.css");
    const shellSource = readSource("./components/workbench/shells/WorkbenchSidebarShell.tsx");
    const navigationSource = readSource("./components/workbench/actions/WorkbenchSidebarNavigation.tsx");
    const sidebarSource = readSource("./SessionSidebar.tsx");

    assert.match(shellSource, /rah-sidebar-header/);
    assert.match(
      shellSource,
      /aria-label=\{props\.sidebarOpen \? "Collapse sidebar" : "Expand sidebar"\}/,
    );
    assert.match(shellSource, /fixed left-2 top-2 z-40 hidden md:inline-flex/);
    assert.match(shellSource, />RAH<\/span>/);
    assert.match(navigationSource, /aria-label="Primary navigation"/);
    assert.match(navigationSource, />New task<\/span>/);
    assert.match(navigationSource, />Council<\/span>/);
    assert.match(navigationSource, />Canvas<\/span>/);
    assert.match(navigationSource, /px-2 py-1/);
    assert.match(navigationSource, />Chats<\/span>/);
    assert.match(navigationSource, />Settings<\/span>/);
    assert.equal((shellSource.match(/<WorkbenchSidebarNavigation/g) ?? []).length, 2);
    assert.doesNotMatch(shellSource, /MobileWorkbenchHeaderActions/);
    assert.match(shellSource, /headerLayout="inline"/);
    assert.match(shellSource, /closePlacement="start"/);
    assert.match(shellSource, /viewportClassName="md:!hidden"/);
    assert.match(SIDEBAR_HEADER_ICON_BUTTON_CLASS, /\bh-8\b/);
    assert.match(SIDEBAR_HEADER_ICON_BUTTON_CLASS, /\bw-8\b/);
    assert.match(SIDEBAR_HEADER_ICON_BUTTON_CLASS, /\bshrink-0\b/);
    assert.equal(SIDEBAR_HEADER_ICON_SIZE, 20);
    assert.equal(SIDEBAR_HEADER_LOGO_CLASS, "h-5 w-5");
    assert.match(SIDEBAR_LAYOUT.rootClassName, /rah-sidebar-content/);
    assert.match(sidebarSource, /toolbarLabelFullClassName/);
    assert.match(sidebarSource, /toolbarLabelShortClassName/);
    assert.doesNotMatch(cssSource, /--rah-sidebar-header-gap/);
    assert.doesNotMatch(cssSource, /@container rah-sidebar-header \(max-width: 224px\)/);
    assert.match(cssSource, /@container rah-sidebar-content \(max-width: 212px\)/);
    assert.match(cssSource, /\.rah-sidebar-workspaces-label-full/);
    assert.match(cssSource, /\.rah-sidebar-workspaces-label-short/);
  });

  test("keeps sidebar resizing out of the React render hot path", () => {
    const shellSource = readSource("./components/workbench/shells/WorkbenchSidebarShell.tsx");
    const chromeStateSource = readSource("./hooks/useWorkbenchChromeState.ts");

    assert.match(shellSource, /var\(--rah-sidebar-width/);
    assert.match(
      shellSource,
      /props\.isResizing \? "" : "transition-\[width\] duration-150 ease-out"/,
    );
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
    const inspectorShellSource = readSource("./components/workbench/shells/WorkbenchInspectorShell.tsx");
    const chromeStateSource = readSource("./hooks/useWorkbenchChromeState.ts");

    assert.match(sheetSource, /viewportClassName/);
    assert.match(sheetSource, /Dialog\.Overlay[\s\S]*props\.viewportClassName/);
    assert.match(sheetSource, /Dialog\.Content[\s\S]*props\.viewportClassName/);
    assert.match(shellSource, /viewportClassName="md:!hidden"/);
    assert.match(sidePanelSource, /mobileViewportClassName/);
    assert.match(
      sidePanelSource,
      /breakpoint === "wide" \? "min-\[900px\]:!hidden" : "min-\[700px\]:!hidden"/,
    );
    assert.match(sidePanelSource, /viewportClassName=\{mobileViewportClassName\}/);
    assert.match(sheetSource, /fullScreen\?: boolean/);
    assert.match(sheetSource, /inset-0 h-\[100dvh\] w-screen max-w-none border-0/);
    assert.match(sidePanelSource, /fullScreen=\{props\.mobileFullScreen === true\}/);
    assert.match(sidePanelSource, /max-\[899px\]:!hidden min-\[900px\]:!flex/);
    assert.match(inspectorShellSource, /mobileFullScreen: true/);
    assert.match(inspectorShellSource, /mobileFloatingClose: false/);
    assert.doesNotMatch(inspectorShellSource, /props\.contained \|\|/);
    assert.match(appSource, /rightOpen=\{rightOpen\}/);
    assert.match(appSource, /onRightOpenChange=\{setRightOpen\}/);
    assert.match(appSource, /showDesktop=\{viewportTier === "wide"\}/);
    assert.match(chromeStateSource, /import \{ MEDIUM_MIN_WIDTH_PX \} from "\.\.\/responsive-layout"/);
    assert.match(chromeStateSource, /viewportWidthPx < MEDIUM_MIN_WIDTH_PX/);
    assert.match(chromeStateSource, /setLeftOpen\(\(current\) => \(current \? false : current\)\)/);
    assert.match(chromeStateSource, /setRightOpen\(\(current\) => \(current \? false : current\)\)/);
    assert.match(appSource, /showPrimaryLeftSidebarControls = !leftOpen/);
    assert.match(appSource, /showLeftSidebarControls=\{showPrimaryLeftSidebarControls\}/);
    assert.match(appSource, /resolveSidePanelOpenForTier\(/);
    assert.doesNotMatch(appSource, /rightSidebarOpen \|\| rightOpen/);
  });

  test("gives a mobile Side dock one sidebar control and one visible conversation surface", () => {
    const appSource = readSource("./App.tsx");
    const sideDockSource = readSource(
      "./components/workbench/session/SessionSideDock.tsx",
    );

    assert.match(appSource, /showMobileSidebarControl=\{showPrimaryLeftSidebarControls\}/);
    assert.match(appSource, /onOpenMobileSidebar=\{\(\) => setLeftOpen\(true\)\}/);
    assert.match(
      appSource,
      /showPrimaryLeftSidebarControls\s*&&\s*\(sideProjectionsByParentId\.get\(selectedSummary\.session\.id\)\?\.length \?\? 0\) === 0/,
    );
    assert.match(sideDockSource, /className="isolate h-full min-h-0 min-w-0 overflow-hidden/);
    assert.match(sideDockSource, /props\.showMobileSidebarControl && props\.onOpenMobileSidebar/);
    assert.match(sideDockSource, /md:!hidden/);
    assert.match(sideDockSource, /mobileSurfaceId === "main"\s*\? props\.main/);
    assert.doesNotMatch(sideDockSource, /lg:hidden[^\n]*absolute/);
  });

  test("uses shared draggable dividers for desktop Side tasks without a layout rail", () => {
    const sideDockSource = readSource(
      "./components/workbench/session/SessionSideDock.tsx",
    );
    const sessionPaneSource = readSource(
      "./components/workbench/panes/WorkbenchSelectedPane.tsx",
    );

    assert.match(sideDockSource, /function SideResizeHandle/);
    assert.match(sideDockSource, /role="separator"/);
    assert.match(sideDockSource, /Resize main task and Side tasks/);
    assert.match(sideDockSource, /startSideResize\(side\.id, nextSide\.id, event\)/);
    assert.match(sideDockSource, /onKeyboardResize/);
    assert.match(sideDockSource, /resizeMainWithKeyboard/);
    assert.match(sideDockSource, /resizeSidesWithKeyboard/);
    assert.match(sideDockSource, /"ArrowLeft"/);
    assert.match(sideDockSource, /"ArrowDown"/);
    assert.match(sideDockSource, /w-px -translate-x-1\/2/);
    assert.match(sideDockSource, /h-px -translate-y-1\/2/);
    assert.doesNotMatch(sideDockSource, /onLayoutChange/);
    assert.doesNotMatch(sideDockSource, /w-10[^\n]*Side layout/);
    assert.doesNotMatch(sessionPaneSource, />\s*Side layout\s*</);
    assert.match(sessionPaneSource, /Stack \$\{props\.sideTaskCount\} Side tasks/);
    assert.match(sessionPaneSource, /Show \$\{props\.sideTaskCount\} Side tasks side by side/);
    assert.match(sessionPaneSource, /props\.sideTaskLayout === "columns" \? "stack" : "columns"/);
  });

  test("overlays the sidebar resize target on the boundary without a visible gutter", () => {
    const cssSource = readSource("./index.css");
    const shellSource = readSource("./components/workbench/shells/WorkbenchSidebarShell.tsx");

    assert.match(shellSource, /rah-workbench-sidebar/);
    assert.match(shellSource, /data-sidebar-open=\{props\.sidebarOpen \? "true" : "false"\}/);
    assert.match(cssSource, /\.rah-workbench-sidebar\[data-sidebar-open="true"\][^{]*\{[^}]*box-shadow:/s);
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
    assert.doesNotMatch(sidePanelSource, /border-l border-\[var\(--app-border\)\]/);
    assert.match(cssSource, /\.inspector-divider\s*\{[^}]*margin-left:\s*-6px/s);
    assert.match(cssSource, /\.inspector-divider\s*\{[^}]*margin-right:\s*-6px/s);
    assert.match(cssSource, /\.inspector-divider\s*\{[^}]*z-index:\s*30/s);
    assert.match(cssSource, /\.inspector-divider::after\s*\{[^}]*opacity:\s*0;/s);
    assert.match(cssSource, /\.inspector-divider::before\s*\{[^}]*width:\s*1px;[^}]*var\(--app-border\)/s);
    assert.match(sidePanelSource, /role="separator"/);
    assert.match(sidePanelSource, /onPointerDown=\{startResize\}/);
    assert.match(sidePanelSource, /onKeyDown=\{resizeWithKeyboard\}/);
    assert.match(sidePanelSource, /requestAnimationFrame\(flushPointerPosition\)/);
    assert.match(sidePanelSource, /cancelAnimationFrame\(frameId\)/);
    assert.match(sidePanelSource, /localStorage\.setItem/);
  });

  test("routes turn changes through shared review and file preview paths", () => {
    const cardSource = readSource("./components/chat/ConversationFileChangesCard.tsx");
    const threadSource = readSource("./components/chat/ChatThread.tsx");

    assert.match(cardSource, /onOpenFile\?: \(path: string\) => void/);
    assert.match(cardSource, /onClick=\{\(\) => props\.onOpenFile\?\.\(file\.path\)\}/);
    assert.match(cardSource, /onReview\?: \(\) => void/);
    assert.match(cardSource, /onClick=\{props\.onReview\}/);
    assert.match(threadSource, /onOpenTurnFileChange\?: \(turnId: string, path: string\) => void/);
    assert.match(
      threadSource,
      /setReviewScope\(\{\s*kind:\s*"turn",[\s\S]*?turnId:\s*row\.turnId,/,
    );
    assert.match(
      threadSource,
      /onOpenFile:\s*\(path:\s*string\)\s*=>\s*props\.onOpenTurnFileChange\?\.\(row\.turnId,\s*path\)/,
    );
    assert.match(threadSource, /<ReviewDialog[\s\S]*?scope=\{reviewScope\}/);
  });

  test("keeps the Inspector file viewer nonmodal, persistent, resizable, and horizontally scrollable", () => {
    const dialogSource = readSource("./inspector/InspectorFileDetailDialog.tsx");
    const previewSource = readSource("./inspector/InspectorPreviewDisplays.tsx");

    assert.match(dialogSource, /<Dialog\.Root open modal=\{false\}/);
    assert.doesNotMatch(dialogSource, /<Dialog\.Overlay/);
    assert.match(dialogSource, /onInteractOutside=\{\(event\) => event\.preventDefault\(\)\}/);
    assert.match(dialogSource, /data-inspector-file-viewer="true"/);
    assert.match(dialogSource, /RESIZE_HANDLES\.map/);
    assert.match(dialogSource, /beginInteraction\(event, "resize", handle\.direction\)/);
    assert.match(
      dialogSource,
      /data-testid="inspector-file-viewer-drag-handle"[\s\S]*?beginInteraction\(event, "move"\)/,
    );
    assert.match(
      dialogSource,
      /data-testid="inspector-file-viewer-path"[\s\S]*?cursor-text select-text/,
    );
    assert.ok(
      dialogSource.indexOf("<SegmentedButtonLabel size=\"compact\">Unified") <
        dialogSource.indexOf("<SegmentedButtonLabel size=\"compact\">Split"),
    );
    assert.match(previewSource, /data-testid="inspector-diff-scroll"/);
    assert.match(previewSource, /grid-cols-\[4rem_2rem_max-content\]/);
    assert.match(previewSource, /grid-cols-\[4rem_max-content\]/);
  });

  test("renders workspace and turn changes through a filtered directory tree", () => {
    const inspectorSource = readSource("./InspectorPane.tsx");
    const changesSource = readSource("./inspector/InspectorChangesPane.tsx");
    const turnChangesSource = readSource("./inspector/InspectorTurnChangesPane.tsx");

    assert.match(inspectorSource, /<InspectorChangesPane\s+workspaceRoot=\{props\.workspaceRoot\}/);
    assert.match(changesSource, /<InspectorFileFilter/);
    assert.match(changesSource, /<InspectorChangeTree/);
    assert.match(changesSource, /aria-label="Against branch"/);
    assert.match(changesSource, /Current workspace/);
    assert.equal(
      (changesSource.match(/className=\{COMPARISON_LABEL_CLASS\}/g) ?? []).length,
      2,
    );
    assert.match(changesSource, /COMPARISON_LABEL_CLASS[\s\S]*font-sans/);
    assert.match(changesSource, /COMPARISON_LABEL_CLASS[\s\S]*font-\[var\(--app-font-weight\)\]/);
    assert.match(changesSource, /COMPARISON_VALUE_TEXT_CLASS[\s\S]*font-sans/);
    assert.match(changesSource, /COMPARISON_VALUE_TEXT_CLASS[\s\S]*leading-\[18px\]/);
    assert.match(changesSource, /bg-\[var\(--app-bg\)\] py-1 pl-2 pr-6/);
    assert.match(changesSource, /gap-x-3 gap-y-0\.5/);
    assert.match(
      changesSource,
      /grid-cols-\[minmax\(0,5fr\)_minmax\(0,7fr\)\]/,
    );
    assert.match(
      changesSource,
      /<span className=\{COMPARISON_LABEL_CLASS\}>Current workspace<\/span>[\s\S]*?<span className=\{COMPARISON_LABEL_CLASS\}>Against<\/span>/,
    );
    assert.match(changesSource, /HEAD · uncommitted changes/);
    assert.match(changesSource, /merge_base/);
    assert.match(changesSource, /Uncommitted changes/);
    assert.doesNotMatch(changesSource, /\["branch", "unstaged", "staged"\]/);
    assert.match(changesSource, /text-\[var\(--app-fg\)\]/);
    assert.match(inspectorSource, /onBaseBranchChange=\{\(baseBranch\) =>/);
    assert.match(turnChangesSource, /<InspectorFileFilter/);
    assert.match(turnChangesSource, /<InspectorChangeTree/);
  });

  test("indexes Inspector resources in the background without hydrating Chat turns", () => {
    const inspectorSource = readSource("./InspectorPane.tsx");
    const indexSource = readSource("./inspector/conversation-resource-index.ts");
    const headerSource = readSource("./inspector/InspectorHeader.tsx");
    const resourcesSource = readSource("./inspector/InspectorResourcesPane.tsx");

    assert.match(inspectorSource, /loadCachedConversationResourceIndex/);
    assert.match(inspectorSource, /\[props\.sessionId, resourceIndexRetryToken\]/);
    assert.doesNotMatch(inspectorSource, /activeTab !== "outputs" && activeTab !== "sources"/);
    assert.doesNotMatch(inspectorSource, /onLoadConversationTurnDetail/);
    assert.match(indexSource, /dependencies\.readIndex\(args\.sessionId/);
    assert.doesNotMatch(indexSource, /readConversationTurnsPage/);
    assert.doesNotMatch(indexSource, /readConversationTurnDetail/);
    assert.match(indexSource, /daemon-owned provider-neutral resource-index request/);
    assert.match(headerSource, /Outputs \(\{props\.outputCount\}\)/);
    assert.match(headerSource, /Sources \(\{props\.sourceCount\}\)/);
    assert.doesNotMatch(headerSource, /resourceIndexing/);
    assert.doesNotMatch(resourcesSource, /Indexing complete turn resources/);
    assert.doesNotMatch(resourcesSource, /role="status"/);
  });

  test("locks sidebar indentation and meta width tokens", () => {
    assert.equal(SIDEBAR_LAYOUT.sessionListClassName, "space-y-px pt-px pl-3 pr-0.5");
    assert.match(SIDEBAR_LAYOUT.sessionStatusSlotClassName, /\bw-2\.5\b/);
    assert.match(
      SIDEBAR_LAYOUT.sessionTitleOnlySelectButtonClassName,
      /grid-cols-\[1\.25rem_0\.625rem_minmax\(0,1fr\)\]/,
    );
  });

  test("uses matched workspace and session icon slots for aligned titles", () => {
    assert.match(SIDEBAR_LAYOUT.workspaceDisclosureButtonClassName, /\bflex-1\b/);
    assert.match(SIDEBAR_LAYOUT.workspaceDisclosureButtonClassName, /\bpr-14\b/);
    assert.match(SIDEBAR_LAYOUT.workspaceDisclosureIconClassName, /\bh-7\b/);
    assert.match(SIDEBAR_LAYOUT.workspaceDisclosureIconClassName, /\bw-7\b/);
    assert.match(SIDEBAR_LAYOUT.sessionIconSlotClassName, /\bh-6\b/);
    assert.match(SIDEBAR_LAYOUT.sessionIconSlotClassName, /\bw-5\b/);
    assert.equal(SIDEBAR_LAYOUT.sessionIconClassName, "h-3.5 w-3.5");
    assert.match(SIDEBAR_LAYOUT.sessionTitleClassName, /overflow-hidden/);
    assert.match(SIDEBAR_LAYOUT.sessionTitleClassName, /whitespace-nowrap/);
    assert.doesNotMatch(SIDEBAR_LAYOUT.sessionTitleClassName, /\btruncate\b/);
    assert.match(SIDEBAR_LAYOUT.workspaceDisclosureTitleClassName, /\btruncate\b/);
  });

  test("makes the whole workspace label region the disclosure control", () => {
    const sidebarSource = readSource("./SessionSidebar.tsx");

    assert.match(sidebarSource, /className=\{SIDEBAR_LAYOUT\.workspaceDisclosureButtonClassName\}/);
    assert.match(sidebarSource, /onClick=\{toggleExpanded\}/);
    assert.match(sidebarSource, /aria-expanded=\{expanded\}/);
    assert.match(sidebarSource, /aria-controls=\{hasItems \? itemsId : undefined\}/);
    assert.match(sidebarSource, /aria-current=\{props\.workspace\.selected \? "location" : undefined\}/);
    assert.match(sidebarSource, /id=\{itemsId\} className=\{SIDEBAR_LAYOUT\.sessionListClassName\}/);
  });

  test("uses transient workspace feedback without a persistent workspace selection fill", () => {
    const sidebarSource = readSource("./SessionSidebar.tsx");

    assert.match(SIDEBAR_LAYOUT.workspaceHeaderClassName, /hover:bg-\[color:color-mix/);
    assert.match(SIDEBAR_LAYOUT.workspaceHeaderClassName, /focus-within:bg-\[color:color-mix/);
    assert.match(SIDEBAR_LAYOUT.workspaceDisclosureButtonClassName, /active:bg-\[color:color-mix/);
    assert.doesNotMatch(sidebarSource, /workspaceHeaderSelectedClassName/);
    assert.doesNotMatch(sidebarSource, /workspaceTitleSelectedClassName/);
  });

  test("exposes a workspace-scoped new task action through the shared workspace navigation path", () => {
    const sidebarSource = readSource("./SessionSidebar.tsx");
    const appSource = readSource("./App.tsx");

    assert.match(sidebarSource, /aria-label="New task in workspace"/);
    assert.match(sidebarSource, /<SquarePen size=\{14\} \/>/);
    assert.match(sidebarSource, /props\.onSelectWorkspace\(\)/);
    assert.match(appSource, /onSelectWorkspace=\{\(dir\) => \{\s*pageController\.openWorkspace\(dir\);\s*\}\}/);
  });

  test("keeps selected sessions at the same neutral depth as ordinary hover", () => {
    assert.match(SIDEBAR_LAYOUT.sessionRowSelectedClassName, /color-mix\(in_oklab,var\(--app-fg\)_5%/);
    assert.doesNotMatch(SIDEBAR_LAYOUT.sessionRowSelectedClassName, /font-medium/);
    assert.doesNotMatch(SIDEBAR_LAYOUT.sessionRowSelectedClassName, /hover:bg-/);
    assert.match(SIDEBAR_LAYOUT.sessionRowSelectedClassName, /shadow-none/);
    assert.doesNotMatch(SIDEBAR_LAYOUT.sessionRowSelectedClassName, /emerald/);
    assert.doesNotMatch(SIDEBAR_LAYOUT.sessionRowSelectedClassName, /inset_3px_0_0_0/);
  });

  test("renders running Councils as an independent unpinned section", () => {
    const sidebarSource = readSource("./SessionSidebar.tsx");
    const pinnedIndex = sidebarSource.indexOf("sidebarPartition.pinnedItems.length");
    const councilIndex = sidebarSource.indexOf("data-sidebar-council-section");
    const toolbarIndex = sidebarSource.indexOf("{/* Toolbar */}");
    const workspaceRowSource = sidebarSource.slice(
      sidebarSource.indexOf("function WorkspaceRow"),
      sidebarSource.indexOf("export function SessionSidebar"),
    );

    assert.ok(pinnedIndex >= 0);
    assert.ok(councilIndex > pinnedIndex);
    assert.ok(toolbarIndex > councilIndex);
    assert.match(sidebarSource, /aria-label="Running Councils"/);
    assert.match(sidebarSource, /deriveSidebarCouncilViewModels/);
    assert.match(sidebarSource, /councilItems\.map/);
    assert.match(sidebarSource, /sidebarPartition\.workspaces\.map/);
    assert.doesNotMatch(workspaceRowSource, /CouncilRow/);
    assert.doesNotMatch(sidebarSource, /onTogglePinCouncil/);
    assert.doesNotMatch(sidebarSource, /(?:Pin|Unpin) Council/);
  });

  test("renders the unified compact status indicator before fading titles", () => {
    const sidebarSource = readSource("./SessionSidebar.tsx");

    assert.match(sidebarSource, /function SidebarStatusIndicator/);
    assert.match(sidebarSource, /animate-spin/);
    assert.match(sidebarSource, /bg-sky-500/);
    assert.match(sidebarSource, /bg-red-500/);
    assert.match(sidebarSource, /bg-emerald-500/);
    assert.match(sidebarSource, /<SidebarStatusIndicator status=\{props\.session\.status\} \/>/);
    assert.match(sidebarSource, /<SidebarStatusIndicator status=\{props\.council\.status\} \/>/);
    assert.match(sidebarSource, /ResizeObserver/);
    assert.match(sidebarSource, /mask-image:linear-gradient/);
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

  test("keeps archive and pin in separate slots and confirms archive before mutation", () => {
    const sidebarSource = readSource("./SessionSidebar.tsx");
    const appSource = readSource("./App.tsx");
    const stylesSource = readSource("./styles.css");

    assert.match(
      sidebarSource,
      /sessionActionSlotClassName[\s\S]*aria-label=\{props\.session\.pinned[\s\S]*aria-label="Archive session"/,
    );
    assert.doesNotMatch(sidebarSource, /props\.session\.running \? \(\s*<button[\s\S]*Unpin session/);
    assert.match(sidebarSource, /sessionTitleOnlySelectButtonClassName/);
    assert.match(appSource, /open=\{archiveConfirmTarget !== null\}/);
    assert.match(appSource, /title="Archive session\?"/);
    assert.match(appSource, /Nothing will be deleted\. You can browse or restore it from Chats → Archived\./);
    assert.match(appSource, /onArchiveRunningSession=\{\(sessionId\) => \{\s*requestArchiveRuntimeSession\(sessionId\)/);
    assert.match(appSource, /onArchiveHistorySession=\{requestArchiveHistorySession\}/);
    assert.match(stylesSource, /\.coarse-pointer-action-target\s*\{[\s\S]*min-height:\s*2rem;[\s\S]*min-width:\s*2rem;/);
    assert.match(stylesSource, /\.coarse-pointer-session-dual-padding\s*\{[\s\S]*padding-right:\s*4rem !important;/);
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
    assert.doesNotMatch(headerSource, /reserveRightPanelBreakpoint/);
    assert.match(headerSource, /ConversationHeaderIconButton/);
    assert.match(headerSource, /ConversationHeaderStopButton/);
    assert.match(headerSource, /ConversationHeaderMoreButton/);
    assert.match(headerSource, /ConversationHeaderPanelToggleButton/);
    assert.match(
      headerSource,
      /\{props\.actions\}[\s\S]*\{props\.closeAction \? \([\s\S]*\{props\.trailingActions\}/,
    );
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

  test("uses edge toggles for page chrome and stable icon buttons in conversation headers", () => {
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
    assert.equal(HEADER_SIDE_PANEL_TOGGLE_BUTTON_CLASS, HEADER_ICON_BUTTON_CLASS);

    for (const source of [
      sheetSource,
      shellSource,
      headerSource,
      emptyPaneSource,
      canvasSource,
    ]) {
      assert.match(source, /HEADER_EDGE_TOGGLE_ICON_SIZE/);
    }

    assert.doesNotMatch(sidePanelSource, /HEADER_SIDE_PANEL_TOGGLE_BUTTON_CLASS/);
    assert.doesNotMatch(sidePanelSource, /PanelRight/);
    assert.doesNotMatch(emptyPaneSource, /<header/);
    assert.doesNotMatch(emptyPaneSource, /border-b/);
    assert.match(emptyPaneSource, /absolute left-2 top-3/);
    assert.match(openingPaneSource, /ConversationHeader/);
    assert.doesNotMatch(openingPaneSource, /ConversationHeaderPanelToggleButton/);
    assert.doesNotMatch(openingPaneSource, /<header/);
    assert.match(inspectorHeaderSource, /flex h-12/);

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
      sidePanelSource,
      emptyPaneSource,
      openingPaneSource,
    ]) {
      assert.doesNotMatch(source, /<PanelRight size=\{16\}/);
      assert.doesNotMatch(source, /<X size=\{16\}/);
    }
    assert.match(headerSource, /<PanelRight size=\{16\}/);
    assert.match(headerSource, /HEADER_SIDE_PANEL_TOGGLE_BUTTON_CLASS/);
  });

  test("keeps opening progress separate from provider identity", () => {
    const openingPaneSource = readSource("./components/workbench/panes/WorkbenchOpeningPane.tsx");

    assert.match(
      openingPaneSource,
      /flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-\[var\(--app-subtle-bg\)\]/,
    );
    assert.match(
      openingPaneSource,
      /<ProviderLogo provider=\{props\.openingSession\.provider\} className="h-6 w-6" \/>/,
    );
    assert.match(openingPaneSource, /<LoaderCircle size=\{13\} className="shrink-0 animate-spin" \/>/);
    assert.doesNotMatch(openingPaneSource, /absolute[^\n]*animate-spin/);
    assert.doesNotMatch(openingPaneSource, /-bottom-[^\n]*-right-[^\n]*animate-spin/);
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
    assert.match(SEGMENTED_CONTROL_FLAT_ACTIVE_CLASS, /bg-\[var\(--app-bg\)\]/);
    assert.match(SEGMENTED_CONTROL_FLAT_ACTIVE_CLASS, /shadow-none/);
    assert.doesNotMatch(SEGMENTED_CONTROL_FLAT_ACTIVE_CLASS, /shadow-sm/);
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

  test("stretches inspector tabs evenly across the available panel width", () => {
    const inspectorSource = readSource("./inspector/InspectorHeader.tsx");
    const fileDetailSource = readSource("./inspector/InspectorFileDetailDialog.tsx");
    const previewSource = readSource("./inspector/InspectorPreviewDisplays.tsx");

    assert.match(inspectorSource, /size="compact"/);
    assert.match(inspectorSource, /!grid w-full grid-cols-4 gap-0\.5/);
    assert.equal((inspectorSource.match(/className="min-w-0 px-1\.5"/g) ?? []).length, 4);
    assert.equal(
      (inspectorSource.match(/selectedClassName=\{SEGMENTED_CONTROL_FLAT_ACTIVE_CLASS\}/g) ?? []).length,
      4,
    );
    assert.equal(
      (fileDetailSource.match(/selectedClassName=\{SEGMENTED_CONTROL_FLAT_ACTIVE_CLASS\}/g) ?? []).length,
      4,
    );
    assert.equal(
      (previewSource.match(/selectedClassName=\{SEGMENTED_CONTROL_FLAT_ACTIVE_CLASS\}/g) ?? []).length,
      2,
    );
    assert.doesNotMatch(inspectorSource, /min-w-\[21rem\]/);
  });

  test("keeps desktop right-panel toggles in the conversation header", () => {
    const appSource = readSource("./App.tsx");
    const canvasSource = readSource("./components/workbench/canvas/CanvasSessionPane.tsx");
    const councilSource = readSource("./council/CouncilPage.tsx");
    const sidePanelSource = readSource("./components/workbench/shells/ConversationSidePanelShell.tsx");
    const emptyPaneSource = readSource("./components/workbench/panes/WorkbenchEmptyPane.tsx");
    const openingPaneSource = readSource("./components/workbench/panes/WorkbenchOpeningPane.tsx");
    const boundarySource = readSource("./components/workbench/WorkbenchErrorBoundary.tsx");

    assert.doesNotMatch(sidePanelSource, /props\.onToggle/);
    assert.doesNotMatch(sidePanelSource, /SIDE_PANEL_TOGGLE_STYLE/);
    assert.doesNotMatch(sidePanelSource, /HEADER_SIDE_PANEL_TOGGLE_BUTTON_CLASS/);
    assert.doesNotMatch(emptyPaneSource, /HEADER_SIDE_PANEL_TOGGLE_BUTTON_CLASS/);
    assert.doesNotMatch(openingPaneSource, /ConversationHeaderPanelToggleButton/);
    assert.doesNotMatch(sidePanelSource, /HEADER_ICON_BUTTON_CLASS/);
    assert.doesNotMatch(emptyPaneSource, /border border-\[var\(--app-border\)\][\s\S]{0,160}PanelRight/);
    assert.doesNotMatch(openingPaneSource, /border border-\[var\(--app-border\)\][\s\S]{0,160}PanelRight/);
    assert.match(HEADER_SIDE_PANEL_TOGGLE_BUTTON_CLASS, /\bhover:bg-\[var\(--app-subtle-bg\)\]/);
    assert.match(HEADER_SIDE_PANEL_TOGGLE_BUTTON_CLASS, /\bborder\b/);
    assert.match(HEADER_SIDE_PANEL_TOGGLE_BUTTON_CLASS, /\brah-stable-border\b/);
    assert.match(appSource, /const sessionInspectorAvailable =/);
    assert.match(appSource, /workbenchMode === "single"/);
    assert.match(appSource, /primaryPaneState\.kind === "active"/);
    assert.match(appSource, /showInspectorToggle=\{sessionInspectorAvailable && !inspectorToggleOpen\}/);
    assert.doesNotMatch(appSource, /inspectorToggleClassName=/);
    assert.doesNotMatch(appSource, /reserveRightPanelToggleSpace=/);
    assert.match(appSource, /conversation-panel-surface relative flex h-full/);
    assert.match(
      appSource,
      /conversation-panel-surface[\s\S]*?<WorkbenchInspectorShell[\s\S]*?contained/,
    );
    assert.match(
      appSource,
      /<SessionSideDock[\s\S]*?main=\{\([\s\S]*?conversation-panel-surface/,
    );
    assert.doesNotMatch(
      appSource,
      /<\/main>[\s\S]{0,240}<WorkbenchInspectorShell/,
    );
    assert.doesNotMatch(appSource, /canvasMaximizedPaneId[\s\S]{0,320}setCanvasPaneRightPanelsOpen/);
    assert.doesNotMatch(appSource, /ProviderLogo[\s\S]{0,120}renderPaneToolbar/);
    assert.doesNotMatch(appSource, /renderPaneToolbar[\s\S]{0,360}ProviderLogo/);
    assert.match(canvasSource, /showInspectorToggle=\{sidePanelAvailable && !inspectorOpen\}/);
    assert.match(canvasSource, /const sidePanelAvailable = Boolean\(props\.inspector\);/);
    assert.match(canvasSource, /contained/);
    assert.match(appSource, /const paneRightPanelOpen = canvasPaneRightPanelsOpen\[typedPaneId\] === true;/);
    assert.doesNotMatch(appSource, /paneExpanded && canvasPaneRightPanelsOpen/);
    assert.match(appSource, /containedAgentsPanel/);
    assert.doesNotMatch(appSource, /agentsToggleDisabled=\{!paneExpanded\}/);
    assert.doesNotMatch(appSource, /sidePanelToggleDisabled=\{!paneExpanded\}/);
    assert.doesNotMatch(canvasSource, /reserveRightPanelToggleSpace=/);
    assert.match(councilSource, /showAgentsToggle && !councilSidebarOpen \? \(/);
    assert.doesNotMatch(councilSource, /reserveRightPanelToggleSpace=/);
    assert.match(sidePanelSource, /desktopStorageKey/);
    assert.match(sidePanelSource, /aria-valuenow/);
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

    assert.match(emptyPaneSource, /<NewSessionComposer/);
    assert.doesNotMatch(newComposerSource, /NewSessionWorkspaceContext/);
    assert.match(newComposerSource, /<WorkspacePicker/);
    assert.match(newComposerSource, /iconOnlyWorkspace/);
    assert.match(newComposerSource, /providerSelectorMode/);
    assert.doesNotMatch(emptyPaneSource, /providerSelectorMode="auto"/);
    assert.match(newComposerSource, /max-w-\[min\(42rem,100%\)\]/);
    assert.match(councilSource, /viewportTier: ResponsiveTier/);
    assert.match(councilSource, /isInlinePanelTier\(props\.viewportTier, "wide"\)/);
    assert.match(councilSource, /desktopBreakpoint="wide"/);
    assert.match(councilSource, /mobileOpen=\{councilSidebarOpen && !isCouncilWide\}/);
  });

  test("keeps mobile canvas layout constrained without disabling pane maximize", () => {
    const appSource = readSource("./App.tsx");
    const canvasControllerSource = readSource("./hooks/useCanvasController.ts");
    const canvasWorkbenchSource = readSource(
      "./components/workbench/canvas/CanvasWorkbench.tsx",
    );
    const canvasSessionPaneSource = readSource(
      "./components/workbench/canvas/CanvasSessionPane.tsx",
    );

    assert.match(
      canvasControllerSource,
      /const effectiveCanvasLayout = mobileCanvasLayoutOnly \? mobileCanvasLayout : canvasLayout;/,
    );
    assert.match(
      canvasControllerSource,
      /const currentLayout = mobileCanvasLayoutOnly \? mobileCanvasLayout : canvasLayout;/,
    );
    assert.match(canvasControllerSource, /setMobileCanvasLayoutState\(nextLayout\)/);
    assert.match(
      canvasControllerSource,
      /const setMobileCanvasLayout = useCallback\([\s\S]{0,220}reconcileCanvasLayoutSelection\(layout\)/,
    );
    assert.match(
      canvasControllerSource,
      /const setCanvasLayout = useCallback\([\s\S]{0,220}reconcileCanvasLayoutSelection\(layout\)/,
    );
    assert.match(
      canvasControllerSource,
      /resolveCanvasLayoutSelection\(layout, activeCanvasPaneId\)[\s\S]{0,160}setCanvasMaximizedPaneId\(selection\.maximizedPaneId\)/,
    );
    assert.match(appSource, /const effectiveCanvasMaximizedPaneId = canvasMaximizedPaneId;/);
    assert.match(appSource, /layoutEditingDisabled=\{mobileCanvasLayoutOnly\}/);
    assert.match(appSource, /mobileCanvasLayoutOnly \? setMobileCanvasLayout : setCanvasLayout/);
    assert.match(canvasWorkbenchSource, /onClick=\{props\.onOpenLeft\}/);
    assert.match(canvasWorkbenchSource, /min-\[700px\]:hidden/);
    assert.match(canvasWorkbenchSource, /max-\[699px\]:hidden/);
    assert.match(canvasWorkbenchSource, /paneCount > 1/);
    assert.match(canvasSessionPaneSource, /showLeftSidebarControls=\{false\}/);
    assert.doesNotMatch(appSource, /mobileCanvasLayoutOnly \? null : canvasMaximizedPaneId/);
    assert.doesNotMatch(
      appSource,
      /canvasMaximizedPaneId !== null[\s\S]{0,120}setCanvasMaximizedPaneId\(null\)/,
    );
  });

  test("keeps canvas panes compact, rounded, and orders pane actions by scope", () => {
    const canvasSource = readSource("./components/workbench/canvas/CanvasWorkbench.tsx");
    const clearIndex = canvasSource.indexOf('aria-label="Clear pane content"');
    const splitIndex = canvasSource.indexOf("<CanvasPaneSplitButton");
    const maximizeIndex = canvasSource.indexOf('"Maximize pane"');
    const removeIndex = canvasSource.indexOf('aria-label="Remove pane"');

    assert.match(canvasSource, /overflow-hidden rounded-lg border border-\[var\(--app-border\)\]/);
    assert.match(canvasSource, /absolute inset-0[^\n]*rounded-lg ring-1 ring-inset/);
    assert.match(canvasSource, /overflow-hidden p-2 max-\[699px\]:p-1/);
    assert.match(canvasSource, /horizontal \? "w-2 cursor-col-resize" : "h-2 cursor-row-resize"/);
    assert.match(canvasSource, /deriveCanvasSplitJunctions\(props\.layout\)/);
    assert.match(canvasSource, /directions\.left[\s\S]*right-1\/2 top-1\/2 h-px w-2\.5/);
    assert.match(canvasSource, /directions\.right[\s\S]*left-1\/2 top-1\/2 h-px w-2\.5/);
    assert.match(canvasSource, /directions\.up[\s\S]*bottom-1\/2 left-1\/2 h-2\.5 w-px/);
    assert.match(canvasSource, /directions\.down[\s\S]*left-1\/2 top-1\/2 h-2\.5 w-px/);
    assert.match(canvasSource, /splitJunctions\.get\(layout\.id\) \?\? \[\{ position: 0\.5 \}\]/);
    assert.match(canvasSource, /flex h-8 shrink-0 items-center/);
    assert.ok(clearIndex >= 0);
    assert.ok(splitIndex > clearIndex);
    assert.ok(maximizeIndex > splitIndex);
    assert.ok(removeIndex > maximizeIndex);
    assert.match(canvasSource, /paneCount > 1/);
    assert.doesNotMatch(canvasSource, /removablePaneId|Remove newest pane/);
  });

  test("routes session and council title metadata through the shared compact header structure", () => {
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
    assert.match(CONVERSATION_META_INLINE_BASE_CLASS, /conversation-meta-inline/);
    assert.match(CONVERSATION_META_INLINE_BASE_CLASS, /h-4/);
    assert.doesNotMatch(CONVERSATION_META_INLINE_BASE_CLASS, /rounded|border|bg-/);
    assert.match(CONVERSATION_META_INLINE_ICON_CLASS, /h-3/);
    assert.match(CONVERSATION_META_INLINE_ICON_CLASS, /w-3/);
    assert.match(CONVERSATION_META_INLINE_LABEL_CLASS, /leading-\[14px\]/);
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
    assert.match(sessionSource, /ConversationStateMetaBadge state=\{sessionHeaderState\} appearance="inline"/);
    assert.match(sessionSource, /ConversationHeaderMetaList items=\{sessionHeaderMetaItems\} appearance="inline"/);
    assert.doesNotMatch(sessionSource, /CONVERSATION_META_BADGE_PWA_CLASS/);
    assert.doesNotMatch(sessionSource, /sessionMetaBadgeClassName/);
    assert.match(councilSource, /ConversationHeaderMetaList/);
    assert.match(councilSource, /ConversationHeaderMetaList items=\{selectedCouncilHeaderMetaItems\} appearance="inline"/);
    assert.doesNotMatch(councilSource, /CONVERSATION_META_BADGE_PWA_CLASS/);
    assert.doesNotMatch(councilSource, /councilMetaBadgeClassName/);
    assert.match(councilSource, /Start or open a Council to coordinate agents\./);
    assert.match(headerSource, /presentation === "page" \? "h-14" : "h-12"/);
    assert.match(headerSource, /data-presentation=\{presentation\}/);
    assert.match(headerSource, /flex h-4 min-w-0 items-center overflow-hidden/);
    assert.match(councilSource, /const compactCouncilMeta = isPwaDisplayMode \|\| !isCouncilWide;/);
    assert.match(councilSource, /presentation=\{selectedCouncil \? "conversation" : "page"\}/);
    assert.match(councilSource, /identity=\{selectedCouncil \? <CouncilLogo className="h-6 w-6" \/> : undefined\}/);
    assert.match(councilSource, /icon=\{<Bot className="h-3\.5 w-3\.5" aria-hidden="true" \/>\}/);
    assert.match(councilSource, /ConversationStateMetaBadge[\s\S]*appearance="inline"/);
    assert.match(councilSource, /label=\{compactCouncilMeta \? selectedCouncil\.agents\.length : selectedCouncilAgentCountLabel\}/);
    assert.doesNotMatch(sessionSource, /function ConversationHeaderStateIconView/);
    assert.doesNotMatch(councilSource, /function ConversationHeaderStateIconView/);
    assert.match(metaSource, /ConversationHeaderStateIconView/);
  });

  test("keeps council icon tone scoped by surface", () => {
    const councilLogoSource = readSource("./components/CouncilLogo.tsx");
    const navigationSource = readSource("./components/workbench/actions/WorkbenchSidebarNavigation.tsx");
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
    assert.match(navigationSource, /<CouncilLogo className="h-4 w-4" tone="black" variant="bare" \/>/);
    assert.match(sidebarSource, /<CouncilLogo className=\{SIDEBAR_LAYOUT\.sessionIconClassName\} tone="black" variant="bare" \/>/);
    assert.match(emptyPaneSource, /<CouncilLogo className="h-4 w-4" tone="black" variant="bare" \/>/);
    assert.match(canvasNewPaneSource, /<CouncilLogo className="h-4 w-4" tone="black" variant="bare" \/>/);
    assert.doesNotMatch(councilSource, /COUNCIL_HEADER_ICON_CLASSNAME/);
    assert.match(councilSource, /identity=\{selectedCouncil \? <CouncilLogo className="h-6 w-6" \/> : undefined\}/);
    assert.doesNotMatch(appSource, /CouncilLogo/);
    assert.doesNotMatch(appSource, /renderPaneToolbar/);
    assert.doesNotMatch(canvasSource, /CouncilLogo/);
  });
});
