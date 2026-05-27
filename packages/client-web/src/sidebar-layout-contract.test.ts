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
  HEADER_SEGMENTED_BUTTON_ACTIVE_CLASS,
  HEADER_SEGMENTED_BUTTON_BASE_CLASS,
  HEADER_SEGMENTED_BUTTON_INACTIVE_CLASS,
  HEADER_SEGMENTED_CONTROL_BASE_CLASS,
  HEADER_SEGMENTED_LABEL_CLASS,
} from "./components/workbench/header-button-styles";
import {
  CONVERSATION_HEADER_META_ORDER,
  CONVERSATION_META_BADGE_ICON_CLASS,
  CONVERSATION_META_BADGE_LABEL_CLASS,
  CONVERSATION_META_BADGE_PADDING_CLASS,
  CONVERSATION_META_BADGE_PWA_ICON_CLASS,
  CONVERSATION_META_BADGE_PWA_LABEL_CLASS,
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
    const sidebarSource = readSource("./SessionSidebar.tsx");

    assert.match(shellSource, /rah-sidebar-header/);
    assert.match(desktopHeaderSource, /rah-sidebar-header-brand/);
    assert.match(desktopHeaderSource, /rah-sidebar-header-actions/);
    assert.match(SIDEBAR_LAYOUT.rootClassName, /rah-sidebar-content/);
    assert.match(sidebarSource, /toolbarLabelFullClassName/);
    assert.match(sidebarSource, /toolbarLabelShortClassName/);
    assert.match(cssSource, /@container rah-sidebar-header \(max-width: 232px\)/);
    assert.match(cssSource, /\.rah-sidebar-header-brand/);
    assert.match(cssSource, /display: none/);
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
    assert.match(chromeStateSource, /requestAnimationFrame/);
    assert.match(chromeStateSource, /applySidebarWidthCss\(nextWidth\)|pendingSidebarWidthRef/);
    assert.doesNotMatch(
      chromeStateSource,
      /setSidebarWidth\(Math\.max\(200,\s*Math\.min\(480,\s*event\.clientX\)\)\)/,
    );
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

  test("keeps collapsed right-panel toggles inside the conversation header", () => {
    const appSource = readSource("./App.tsx");
    const canvasSource = readSource("./components/workbench/canvas/CanvasSessionPane.tsx");
    const councilSource = readSource("./council/CouncilPage.tsx");
    const sidePanelSource = readSource("./components/workbench/shells/ConversationSidePanelShell.tsx");
    const boundarySource = readSource("./components/workbench/WorkbenchErrorBoundary.tsx");

    assert.match(sidePanelSource, /props\.onToggle && props\.desktopOpen/);
    assert.match(appSource, /showInspectorToggle=\{!rightOpen && !rightSidebarOpen\}/);
    assert.match(canvasSource, /showInspectorToggle=\{!inspectorOpen\}/);
    assert.match(councilSource, /showAgentsToggle && \(!isCouncilWide \|\| !councilSidebarOpen\)/);
    assert.match(appSource, /loadInspectorPane/);
    assert.match(appSource, /importWithStaleReload/);
    assert.match(appSource, /title="Inspector crashed"/);
    assert.match(boundarySource, /isLikelyStaleDynamicImportError/);
  });

  test("routes session and council title pills through shared meta badge structure", () => {
    const sessionSource = readSource("./components/workbench/panes/WorkbenchSelectedPane.tsx");
    const councilSource = readSource("./council/CouncilPage.tsx");
    const metaSource = readSource("./components/workbench/ConversationMetaBadge.tsx");

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
    assert.match(CONVERSATION_META_BADGE_ICON_CLASS, /items-center/);
    assert.match(CONVERSATION_META_BADGE_ICON_CLASS, /\[\&>svg\]:block/);
    assert.match(CONVERSATION_META_BADGE_LABEL_CLASS, /leading-\[12px\]/);
    assert.match(CONVERSATION_META_BADGE_LABEL_CLASS, /-top-\[0\.75px\]/);
    assert.doesNotMatch(CONVERSATION_META_BADGE_LABEL_CLASS, /-top-px/);
    assert.match(CONVERSATION_META_BADGE_PWA_ICON_CLASS, /top-\[0\.75px\]/);
    assert.match(CONVERSATION_META_BADGE_PWA_LABEL_CLASS, /top-\[0\.75px\]/);
    assert.doesNotMatch(CONVERSATION_META_BADGE_PWA_LABEL_CLASS, /-top/);
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
    assert.match(sessionSource, /CONVERSATION_META_BADGE_PWA_ICON_CLASS/);
    assert.match(sessionSource, /CONVERSATION_META_BADGE_PWA_LABEL_CLASS/);
    assert.match(
      sessionSource,
      /compactSessionMeta\s+\?\s+CONVERSATION_META_BADGE_PADDING_CLASS\s+:\s+CONVERSATION_META_BADGE_TRAILING_SPACE_PADDING_CLASS/,
    );
    assert.match(councilSource, /ConversationHeaderMetaList/);
    assert.match(councilSource, /CONVERSATION_META_BADGE_PWA_ICON_CLASS/);
    assert.match(councilSource, /CONVERSATION_META_BADGE_PWA_LABEL_CLASS/);
    assert.match(councilSource, /CONVERSATION_META_BADGE_TRAILING_SPACE_PADDING_CLASS/);
    assert.match(councilSource, /const compactCouncilMeta = isPwaDisplayMode \|\| !isCouncilWide;/);
    assert.match(councilSource, /icon=\{<UsersRound size=\{10\} \/>\}/);
    assert.match(
      councilSource,
      /label=\{compactCouncilMeta \? selectedCouncil\.agents\.length : selectedCouncilAgentCountLabel\}\s+paddingClassName=\{CONVERSATION_META_BADGE_TRAILING_SPACE_PADDING_CLASS\}/,
    );
    assert.doesNotMatch(sessionSource, /function ConversationHeaderStateIconView/);
    assert.doesNotMatch(councilSource, /function ConversationHeaderStateIconView/);
    assert.match(metaSource, /ConversationHeaderStateIconView/);
  });
});
