import type { CSSProperties } from "react";

/**
 * The Codex-inspired sidebar is one visual surface, even though RAH renders it
 * as a fixed rail on wide screens and a Sheet on touch-sized screens.
 *
 * Keep every geometry and typography decision here. Surface-specific CSS may
 * decide when actions are visible, but it must not redefine these dimensions.
 */
export const SIDEBAR_VISUAL_PROTOCOL = Object.freeze({
  id: "codex-compact-v1",
  inlineInsetPx: 8,
  headerHeightPx: 40,
  headerControlSizePx: 32,
  headerControlGapPx: 8,
  headerTitleFontSizePx: 16,
  headerTitleLineHeightPx: 20,
  headerTitleFontWeight: 600,
  navigationTopGapPx: 4,
  navigationBottomGapPx: 8,
  navigationRowHeightPx: 32,
  navigationRowGapPx: 2,
  navigationItemGapPx: 10,
  navigationIconSlotPx: 20,
  navigationIconPx: 18,
  navigationFontSizePx: 15,
  navigationLineHeightPx: 20,
  navigationFontWeight: 500,
  scrollTopPaddingPx: 4,
  sectionLabelFontSizePx: 13,
  sectionLabelLineHeightPx: 18,
  sectionLabelFontWeight: 550,
  sectionLabelRowGapPx: 2,
  sectionGapPx: 12,
  toolbarHeightPx: 28,
  toolbarBottomGapPx: 4,
  workspaceGroupGapPx: 6,
  rowHeightPx: 30,
  rowGapPx: 2,
  rowRadiusPx: 10,
  rowContentInsetPx: 4,
  rowIconSlotPx: 20,
  rowIconPx: 16,
  rowTitleInsetPx: 2,
  workspaceFontSizePx: 14,
  workspaceLineHeightPx: 20,
  workspaceFontWeight: 500,
  sessionFontSizePx: 14,
  sessionLineHeightPx: 20,
  sessionFontWeight: 450,
  nestedSessionIndentPx: 20,
  actionSizePx: 28,
  actionIconPx: 14,
} as const);

type SidebarProtocolStyle = CSSProperties &
  Record<`--rah-sidebar-${string}`, string | number>;

const px = (value: number): string => `${value}px`;

/** CSS variables consumed by every sidebar renderer. */
export const SIDEBAR_VISUAL_STYLE: SidebarProtocolStyle = Object.freeze({
  "--rah-sidebar-inline-inset": px(SIDEBAR_VISUAL_PROTOCOL.inlineInsetPx),
  "--rah-sidebar-header-height": px(SIDEBAR_VISUAL_PROTOCOL.headerHeightPx),
  "--rah-sidebar-header-control-size": px(SIDEBAR_VISUAL_PROTOCOL.headerControlSizePx),
  "--rah-sidebar-header-control-gap": px(SIDEBAR_VISUAL_PROTOCOL.headerControlGapPx),
  "--rah-sidebar-header-title-size": px(SIDEBAR_VISUAL_PROTOCOL.headerTitleFontSizePx),
  "--rah-sidebar-header-title-line": px(SIDEBAR_VISUAL_PROTOCOL.headerTitleLineHeightPx),
  "--rah-sidebar-header-title-weight": SIDEBAR_VISUAL_PROTOCOL.headerTitleFontWeight,
  "--rah-sidebar-navigation-top-gap": px(SIDEBAR_VISUAL_PROTOCOL.navigationTopGapPx),
  "--rah-sidebar-navigation-bottom-gap": px(SIDEBAR_VISUAL_PROTOCOL.navigationBottomGapPx),
  "--rah-sidebar-navigation-row-height": px(SIDEBAR_VISUAL_PROTOCOL.navigationRowHeightPx),
  "--rah-sidebar-navigation-row-gap": px(SIDEBAR_VISUAL_PROTOCOL.navigationRowGapPx),
  "--rah-sidebar-navigation-item-gap": px(SIDEBAR_VISUAL_PROTOCOL.navigationItemGapPx),
  "--rah-sidebar-navigation-icon-slot": px(SIDEBAR_VISUAL_PROTOCOL.navigationIconSlotPx),
  "--rah-sidebar-navigation-font-size": px(SIDEBAR_VISUAL_PROTOCOL.navigationFontSizePx),
  "--rah-sidebar-navigation-line-height": px(SIDEBAR_VISUAL_PROTOCOL.navigationLineHeightPx),
  "--rah-sidebar-navigation-font-weight": SIDEBAR_VISUAL_PROTOCOL.navigationFontWeight,
  "--rah-sidebar-scroll-top-padding": px(SIDEBAR_VISUAL_PROTOCOL.scrollTopPaddingPx),
  "--rah-sidebar-section-label-size": px(SIDEBAR_VISUAL_PROTOCOL.sectionLabelFontSizePx),
  "--rah-sidebar-section-label-line": px(SIDEBAR_VISUAL_PROTOCOL.sectionLabelLineHeightPx),
  "--rah-sidebar-section-label-weight": SIDEBAR_VISUAL_PROTOCOL.sectionLabelFontWeight,
  "--rah-sidebar-section-label-row-gap": px(SIDEBAR_VISUAL_PROTOCOL.sectionLabelRowGapPx),
  "--rah-sidebar-section-gap": px(SIDEBAR_VISUAL_PROTOCOL.sectionGapPx),
  "--rah-sidebar-toolbar-height": px(SIDEBAR_VISUAL_PROTOCOL.toolbarHeightPx),
  "--rah-sidebar-toolbar-bottom-gap": px(SIDEBAR_VISUAL_PROTOCOL.toolbarBottomGapPx),
  "--rah-sidebar-workspace-group-gap": px(SIDEBAR_VISUAL_PROTOCOL.workspaceGroupGapPx),
  "--rah-sidebar-row-height": px(SIDEBAR_VISUAL_PROTOCOL.rowHeightPx),
  "--rah-sidebar-row-gap": px(SIDEBAR_VISUAL_PROTOCOL.rowGapPx),
  "--rah-sidebar-row-radius": px(SIDEBAR_VISUAL_PROTOCOL.rowRadiusPx),
  "--rah-sidebar-row-content-inset": px(SIDEBAR_VISUAL_PROTOCOL.rowContentInsetPx),
  "--rah-sidebar-row-icon-slot": px(SIDEBAR_VISUAL_PROTOCOL.rowIconSlotPx),
  "--rah-sidebar-row-title-inset": px(SIDEBAR_VISUAL_PROTOCOL.rowTitleInsetPx),
  "--rah-sidebar-workspace-font-size": px(SIDEBAR_VISUAL_PROTOCOL.workspaceFontSizePx),
  "--rah-sidebar-workspace-line-height": px(SIDEBAR_VISUAL_PROTOCOL.workspaceLineHeightPx),
  "--rah-sidebar-workspace-font-weight": SIDEBAR_VISUAL_PROTOCOL.workspaceFontWeight,
  "--rah-sidebar-session-font-size": px(SIDEBAR_VISUAL_PROTOCOL.sessionFontSizePx),
  "--rah-sidebar-session-line-height": px(SIDEBAR_VISUAL_PROTOCOL.sessionLineHeightPx),
  "--rah-sidebar-session-font-weight": SIDEBAR_VISUAL_PROTOCOL.sessionFontWeight,
  "--rah-sidebar-nested-session-indent": px(SIDEBAR_VISUAL_PROTOCOL.nestedSessionIndentPx),
  "--rah-sidebar-action-size": px(SIDEBAR_VISUAL_PROTOCOL.actionSizePx),
});

const SIDEBAR_ACTION_BUTTON_CLASS =
  "coarse-pointer-action-target rah-sidebar-action-button";

export const SIDEBAR_LAYOUT = {
  protocolClassName: "rah-sidebar-protocol",
  protocolDataValue: SIDEBAR_VISUAL_PROTOCOL.id,
  desktopHeaderClassName:
    "rah-sidebar-header rah-sidebar-header-frame rah-sidebar-desktop-header",
  sheetHeaderClassName:
    "rah-sidebar-header rah-sidebar-header-frame rah-sidebar-sheet-header",
  headerTitleClassName: "rah-sidebar-header-title",
  navigationClassName: "rah-sidebar-primary-navigation",
  navigationItemClassName: "rah-sidebar-row rah-sidebar-navigation-item",
  navigationItemActiveClassName: "rah-sidebar-row-selected",
  navigationIconClassName: "rah-sidebar-navigation-icon",
  navigationCouncilIconClassName: "h-[18px] w-[18px]",
  settingsClassName: "rah-sidebar-settings",
  rootClassName: "rah-sidebar-content",
  sidebarScrollShellClassName: "rah-sidebar-scroll-shell",
  sidebarScrollClassName: "rah-sidebar-scroll h-full",
  sidebarScrollTrackClassName: "right-0",
  sidebarScrollThumbClassName: "w-1",
  sidebarSheetContentClassName: "rah-sidebar-scroll",
  toolbarClassName: "rah-sidebar-toolbar",
  toolbarLabelClassName: "rah-sidebar-section-label",
  toolbarLabelFullClassName: "rah-sidebar-workspaces-label-full",
  toolbarLabelShortClassName: "rah-sidebar-workspaces-label-short hidden",
  toolbarCountBadgeClassName: "rah-sidebar-count-badge",
  toolbarActionsClassName: "rah-sidebar-row-action-rail rah-sidebar-dual-action-group",
  toolbarIconButtonClassName: SIDEBAR_ACTION_BUTTON_CLASS,
  sortMenuClassName:
    "absolute right-0 top-9 z-20 w-44 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-1.5 shadow-lg",
  sortMenuItemClassName:
    "flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-left text-sm text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)]",
  sortMenuActionClassName:
    "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)]",
  pinnedSectionClassName: "rah-sidebar-section",
  pinnedHeaderClassName: "rah-sidebar-section-label",
  pinnedListClassName: "rah-sidebar-row-list",
  councilSectionClassName: "rah-sidebar-section",
  councilHeaderClassName: "rah-sidebar-council-header rah-sidebar-section-label",
  councilCountClassName: "rah-sidebar-council-count",
  councilListClassName: "rah-sidebar-row-list",
  workspaceListClassName: "rah-sidebar-workspace-list",
  workspaceBlockClassName: "rah-sidebar-workspace-block",
  workspaceHeaderClassName:
    "group/workspace rah-sidebar-row rah-sidebar-item-row rah-sidebar-workspace-row",
  workspaceDisclosureButtonClassName: "rah-sidebar-workspace-disclosure",
  workspaceDisclosureIconClassName: "rah-sidebar-row-icon rah-sidebar-workspace-icon",
  workspaceDisclosureTitleClassName: "rah-sidebar-row-title rah-sidebar-workspace-title",
  workspaceActionSlotClassName:
    "rah-sidebar-row-action-rail rah-sidebar-dual-action-group",
  workspaceActionButtonClassName: SIDEBAR_ACTION_BUTTON_CLASS,
  workspaceActionHiddenClassName:
    "rah-sidebar-workspace-actions-hidden coarse-pointer-action-visible",
  workspaceActionVisibleClassName: "rah-sidebar-workspace-actions-visible",
  workspaceActionDangerClassName: "rah-sidebar-action-danger",
  workspaceActionDisabledClassName: "rah-sidebar-action-disabled",
  sessionListClassName: "rah-sidebar-row-list",
  sessionRowBaseClassName:
    "group/session rah-sidebar-row rah-sidebar-item-row rah-sidebar-session-row",
  sessionRowSelectedClassName: "rah-sidebar-row-selected rah-sidebar-session-selected",
  sessionRowIdleClassName: "rah-sidebar-session-idle",
  sessionInlineRowClassName: "rah-sidebar-session-inline-row",
  sessionTitleOnlySelectButtonClassName: "rah-sidebar-session-select",
  sessionNestedSelectButtonClassName: "rah-sidebar-session-select-nested",
  sessionProviderIconSlotClassName:
    "rah-sidebar-row-icon rah-sidebar-session-provider-icon",
  sessionProviderIconClassName: "h-4 w-4",
  councilIconSlotClassName: "rah-sidebar-row-icon",
  councilIconClassName: "h-4 w-4",
  sessionStatusSlotClassName:
    "rah-sidebar-session-status rah-sidebar-action-cell",
  sessionTitleClassName: "rah-sidebar-row-title rah-sidebar-session-title",
  sessionActionSlotClassName:
    "rah-sidebar-session-action-rail rah-sidebar-row-action-rail",
  sessionActionGroupBaseClassName: "rah-sidebar-session-hover-actions",
  sessionSingleActionHiddenGroupClassName:
    "rah-sidebar-session-actions-single",
  sessionDualActionHiddenGroupClassName:
    "rah-sidebar-session-actions-dual",
  sessionArchiveArmedGroupClassName:
    "rah-sidebar-session-actions-single rah-sidebar-session-actions-armed",
  sessionActionCellClassName: "rah-sidebar-action-cell",
  sessionActionButtonClassName: SIDEBAR_ACTION_BUTTON_CLASS,
  sessionActionButtonHiddenClassName:
    "rah-sidebar-session-action-hidden coarse-pointer-action-visible",
  sessionActionButtonArmedClassName: "rah-sidebar-session-action-armed",
  sessionActionDangerClassName: "rah-sidebar-action-danger",
  sessionPinSelectedToneClassName: "rah-sidebar-action-selected",
  labSectionClassName: "mt-4 space-y-2",
  labHeaderClassName: "px-1",
  labHeaderLabelClassName: "text-xs font-medium text-[var(--app-hint)]",
  labListClassName: "space-y-0.5",
  labButtonClassName:
    "w-full rounded-lg px-3 py-2 text-left transition-colors hover:bg-[var(--app-bg)]/60",
  labTitleClassName:
    "block truncate text-sm font-medium text-[var(--app-fg)]",
  labDescriptionClassName:
    "mt-0.5 text-xs text-[var(--app-hint)] line-clamp-2",
} as const;
