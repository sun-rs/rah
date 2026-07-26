const SIDEBAR_ROW_ACTION_RAIL_CLASS =
  "ml-auto flex shrink-0 items-center justify-end";
const SIDEBAR_DUAL_ACTION_GROUP_CLASS =
  "coarse-pointer-session-actions-dual w-16 shrink-0 md:w-14";
const SIDEBAR_ACTION_CELL_CLASS =
  "coarse-pointer-action-cell inline-flex h-8 w-8 shrink-0 items-center justify-center md:h-7 md:w-7";
const SIDEBAR_ACTION_BUTTON_CLASS =
  "coarse-pointer-action-target inline-flex h-8 w-8 items-center justify-center rounded-md bg-transparent text-[var(--app-hint)]/70 outline-none transition-colors hover:bg-transparent hover:text-[var(--app-fg)] focus-visible:bg-transparent focus-visible:text-[var(--app-fg)] active:bg-transparent active:text-[var(--app-fg)] md:h-7 md:w-7";
const SIDEBAR_ROW_ICON_SLOT_CLASS =
  "inline-flex h-7 w-7 shrink-0 items-center justify-center md:h-6 md:w-6";
const SIDEBAR_ROW_TITLE_CLASS =
  "block min-w-0 overflow-hidden whitespace-nowrap py-0.5 pl-0.5 text-[14px]";
const SIDEBAR_WORKSPACE_TITLE_TYPOGRAPHY_CLASS =
  "font-semibold text-[color:color-mix(in_oklab,var(--app-fg)_94%,var(--app-hint))]";
const SIDEBAR_SESSION_TITLE_TYPOGRAPHY_CLASS =
  "font-normal text-[color:color-mix(in_oklab,var(--app-fg)_76%,var(--app-hint))]";
const SIDEBAR_ROW_SURFACE_CLASS =
  "rah-sidebar-row hover:bg-[var(--rah-sidebar-row-hover-bg)]";

export const SIDEBAR_LAYOUT = {
  rootClassName: "rah-sidebar-content space-y-2",
  sidebarScrollShellClassName: "flex-1",
  sidebarScrollClassName:
    "h-full py-2 pl-2 pr-0.5",
  sidebarScrollTrackClassName:
    "right-0",
  sidebarScrollThumbClassName:
    "w-1",
  sidebarSheetContentClassName: "py-3 pl-3 pr-0.5",
  toolbarClassName:
    "flex min-h-[34px] items-center justify-between py-0.5 pl-1 pr-0 md:min-h-[28px]",
  toolbarLabelClassName: "text-xs font-medium text-[var(--app-hint)]",
  toolbarLabelFullClassName: "rah-sidebar-workspaces-label-full",
  toolbarLabelShortClassName: "rah-sidebar-workspaces-label-short hidden",
  toolbarCountBadgeClassName:
    "relative top-px inline-flex h-5 min-w-5 items-center justify-center rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-1.5 text-[10px] font-semibold tabular-nums text-[var(--app-hint)]",
  toolbarActionsClassName:
    `inline-flex items-center justify-end ${SIDEBAR_DUAL_ACTION_GROUP_CLASS}`,
  toolbarIconButtonClassName: SIDEBAR_ACTION_BUTTON_CLASS,
  sortMenuClassName:
    "absolute right-0 top-9 z-20 w-44 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-1.5 shadow-lg",
  sortMenuItemClassName:
    "flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-left text-sm text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)]",
  sortMenuActionClassName:
    "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)]",
  pinnedSectionClassName: "space-y-0.5 pb-1",
  pinnedHeaderClassName:
    "px-1 text-xs font-medium text-[var(--app-hint)]",
  pinnedListClassName: "space-y-px",
  councilSectionClassName: "space-y-0.5 pb-1",
  councilHeaderClassName:
    "flex items-center justify-between px-1 text-xs font-medium text-[var(--app-hint)]",
  councilCountClassName:
    "inline-flex h-5 min-w-5 items-center justify-center rounded-md bg-[color:color-mix(in_oklab,var(--app-fg)_6%,transparent)] px-1.5 text-[10px] font-semibold tabular-nums text-[var(--app-hint)]",
  councilListClassName: "space-y-px",
  workspaceListClassName: "space-y-0.5",
  workspaceBlockClassName: "space-y-0.5",
  workspaceHeaderClassName:
    `group/workspace relative flex min-h-[34px] items-center rounded-md py-0.5 pl-1 pr-0 transition-colors md:min-h-[28px] ${SIDEBAR_ROW_SURFACE_CLASS}`,
  workspaceDisclosureButtonClassName:
    "flex min-w-0 flex-1 items-center rounded-md text-left outline-none",
  workspaceDisclosureIconClassName:
    `${SIDEBAR_ROW_ICON_SLOT_CLASS} text-[var(--app-hint)] transition-colors group-hover/workspace:text-[var(--app-fg)]`,
  workspaceDisclosureTitleClassName:
    `${SIDEBAR_ROW_TITLE_CLASS} ${SIDEBAR_WORKSPACE_TITLE_TYPOGRAPHY_CLASS} flex-1`,
  workspaceActionSlotClassName:
    `${SIDEBAR_ROW_ACTION_RAIL_CLASS} ${SIDEBAR_DUAL_ACTION_GROUP_CLASS}`,
  workspaceActionButtonClassName: SIDEBAR_ACTION_BUTTON_CLASS,
  workspaceActionHiddenClassName:
    "opacity-0 pointer-events-none transition-opacity group-hover/workspace:pointer-events-auto group-hover/workspace:opacity-100 coarse-pointer-action-visible",
  workspaceActionDangerClassName:
    "hover:text-[var(--app-danger)] focus-visible:text-[var(--app-danger)] active:text-[var(--app-danger)]",
  workspaceActionDisabledClassName:
    "cursor-not-allowed opacity-30",
  sessionListClassName: "space-y-px pt-px",
  sessionRowBaseClassName:
    `group/session relative w-full min-h-[34px] rounded-md py-0.5 pl-1 pr-0 text-left transition-colors md:min-h-[28px] ${SIDEBAR_ROW_SURFACE_CLASS}`,
  sessionRowSelectedClassName:
    "bg-[var(--rah-sidebar-row-hover-bg)] text-[color:color-mix(in_oklab,var(--app-fg)_86%,var(--app-hint))] shadow-none",
  sessionRowIdleClassName:
    "text-[color:color-mix(in_oklab,var(--app-fg)_86%,var(--app-hint))]",
  sessionInlineRowClassName: "flex min-w-0 items-center",
  sessionTitleOnlySelectButtonClassName:
    "flex min-w-0 flex-1 items-center text-left outline-none",
  sessionIconSlotClassName: SIDEBAR_ROW_ICON_SLOT_CLASS,
  sessionIconClassName: "h-3.5 w-3.5",
  sessionStatusSlotClassName: SIDEBAR_ACTION_CELL_CLASS,
  sessionTitleClassName:
    `${SIDEBAR_ROW_TITLE_CLASS} ${SIDEBAR_SESSION_TITLE_TYPOGRAPHY_CLASS} flex-1`,
  sessionActionSlotClassName:
    `rah-sidebar-session-action-rail relative ${SIDEBAR_ROW_ACTION_RAIL_CLASS}`,
  sessionActionGroupBaseClassName:
    "rah-sidebar-session-hover-actions inline-flex shrink-0 items-center justify-end overflow-hidden transition-[width] duration-100",
  sessionSingleActionHiddenGroupClassName:
    "coarse-pointer-session-actions-single w-0 group-hover/session:w-8 md:group-hover/session:w-7",
  sessionDualActionHiddenGroupClassName:
    "coarse-pointer-session-actions-dual w-0 group-hover/session:w-16 md:group-hover/session:w-14",
  sessionActionCellClassName:
    SIDEBAR_ACTION_CELL_CLASS,
  sessionActionButtonClassName: SIDEBAR_ACTION_BUTTON_CLASS,
  sessionActionButtonHiddenClassName:
    "coarse-pointer-action-visible pointer-events-none opacity-0 transition-opacity group-hover/session:pointer-events-auto group-hover/session:opacity-100",
  sessionPinSelectedToneClassName: "text-[var(--app-fg)]",
  labSectionClassName: "space-y-2",
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
