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
  toolbarClassName: "flex items-center justify-between px-1",
  toolbarLabelClassName: "text-xs font-medium text-[var(--app-hint)]",
  toolbarLabelFullClassName: "rah-sidebar-workspaces-label-full",
  toolbarLabelShortClassName: "rah-sidebar-workspaces-label-short hidden",
  toolbarCountBadgeClassName:
    "relative top-px inline-flex h-5 min-w-5 items-center justify-center rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-1.5 text-[10px] font-semibold tabular-nums text-[var(--app-hint)]",
  toolbarActionsClassName: "flex items-center gap-0.5",
  toolbarIconButtonClassName:
    "inline-flex h-9 w-9 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]",
  sortMenuClassName:
    "absolute right-0 top-9 z-20 w-44 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-1.5 shadow-lg",
  sortMenuItemClassName:
    "flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-left text-sm text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)]",
  sortMenuActionClassName:
    "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)]",
  pinnedSectionClassName: "space-y-0.5 pb-1",
  pinnedHeaderClassName:
    "px-1 text-xs font-medium text-[var(--app-hint)]",
  pinnedListClassName: "space-y-px pr-0.5",
  councilSectionClassName: "space-y-0.5 pb-1",
  councilHeaderClassName:
    "flex items-center justify-between px-1 text-xs font-medium text-[var(--app-hint)]",
  councilCountClassName:
    "inline-flex h-5 min-w-5 items-center justify-center rounded-md bg-[color:color-mix(in_oklab,var(--app-fg)_6%,transparent)] px-1.5 text-[10px] font-semibold tabular-nums text-[var(--app-hint)]",
  councilListClassName: "space-y-px pr-0.5",
  workspaceListClassName: "space-y-0.5",
  workspaceBlockClassName: "space-y-0.5",
  workspaceHeaderClassName:
    "group/workspace relative flex min-h-[34px] items-center gap-1 rounded-md py-0.5 pl-1 pr-0 transition-colors hover:bg-[color:color-mix(in_oklab,var(--app-fg)_5%,transparent)] focus-within:bg-[color:color-mix(in_oklab,var(--app-fg)_5%,transparent)] md:min-h-[28px]",
  workspaceDisclosureButtonClassName:
    "flex min-w-0 flex-1 items-center rounded-md pr-14 text-left outline-none transition-colors active:bg-[color:color-mix(in_oklab,var(--app-fg)_10%,transparent)] focus-visible:ring-1 focus-visible:ring-[var(--app-focus)]",
  workspaceDisclosureIconClassName:
    "inline-flex h-7 w-7 shrink-0 items-center justify-center text-[var(--app-hint)] transition-colors group-hover/workspace:text-[var(--app-fg)] md:h-6 md:w-6",
  workspaceDisclosureTitleClassName:
    "min-w-0 flex-1 truncate py-0.5 pl-0.5 text-[14px] text-[var(--app-fg)]",
  workspaceActionSlotClassName:
    "absolute right-0 top-1/2 flex -translate-y-1/2 items-center justify-center gap-px",
  workspaceActionButtonClassName:
    "inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors hover:bg-[color:color-mix(in_oklab,var(--app-fg)_8%,transparent)] hover:text-[var(--app-fg)] active:bg-[color:color-mix(in_oklab,var(--app-fg)_12%,transparent)]",
  workspaceActionHiddenClassName:
    "opacity-0 pointer-events-none transition-opacity group-hover/workspace:pointer-events-auto group-hover/workspace:opacity-100 group-focus-within/workspace:pointer-events-auto group-focus-within/workspace:opacity-100 coarse-pointer-action-visible",
  workspaceActionDangerClassName:
    "hover:bg-[var(--app-danger)]/10 hover:text-[var(--app-danger)]",
  workspaceActionDisabledClassName:
    "cursor-not-allowed opacity-30",
  sessionListClassName: "space-y-px pt-px pl-3 pr-0.5",
  sessionRowBaseClassName:
    "group/session relative w-full min-h-[34px] rounded-md border border-transparent px-1.5 py-0.5 text-left transition-colors md:min-h-[28px]",
  sessionRowSelectedClassName:
    "border-transparent bg-[color:color-mix(in_oklab,var(--app-fg)_5%,transparent)] text-[color:color-mix(in_oklab,var(--app-fg)_94%,var(--app-hint))] shadow-none",
  sessionRowIdleClassName:
    "border-transparent text-[color:color-mix(in_oklab,var(--app-fg)_94%,var(--app-hint))] hover:bg-[color:color-mix(in_oklab,var(--app-fg)_5%,transparent)] focus-within:bg-[color:color-mix(in_oklab,var(--app-fg)_5%,transparent)] active:bg-[color:color-mix(in_oklab,var(--app-fg)_8%,transparent)]",
  sessionInlineRowClassName: "flex items-center gap-1.5",
  sessionTitleOnlySelectButtonClassName:
    "grid min-w-0 flex-1 grid-cols-[1.25rem_0.625rem_minmax(0,1fr)] items-center gap-x-1 text-left outline-none",
  sessionSingleActionPaddingClassName:
    "coarse-pointer-session-single-padding transition-[padding] duration-100 group-hover/session:pr-8 group-focus-within/session:pr-8 md:group-hover/session:pr-7 md:group-focus-within/session:pr-7",
  sessionDualActionPaddingClassName:
    "coarse-pointer-session-dual-padding transition-[padding] duration-100 group-hover/session:pr-16 group-focus-within/session:pr-16 md:group-hover/session:pr-14 md:group-focus-within/session:pr-14",
  sessionPinnedActionPaddingClassName: "pr-16 md:pr-14",
  sessionIconSlotClassName: "inline-flex h-6 w-5 shrink-0 items-center justify-center",
  sessionIconClassName: "h-3.5 w-3.5",
  sessionStatusSlotClassName:
    "inline-flex h-6 w-2.5 shrink-0 items-center justify-center",
  sessionTitleClassName:
    "block min-w-0 overflow-hidden whitespace-nowrap text-[14px]",
  sessionActionSlotClassName:
    "absolute right-0 top-1/2 flex -translate-y-1/2 items-center gap-px md:right-1",
  sessionActionButtonClassName:
    "coarse-pointer-action-target inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--app-hint)]/65 outline-none transition-all hover:bg-[var(--app-bg)]/55 hover:text-[var(--app-fg)] focus-visible:bg-[var(--app-bg)]/55 focus-visible:text-[var(--app-fg)] md:h-7 md:w-7",
  sessionPinHiddenClassName:
    "opacity-0 pointer-events-none transition-opacity group-hover/session:pointer-events-auto group-hover/session:opacity-100 group-focus-within/session:pointer-events-auto group-focus-within/session:opacity-100 coarse-pointer-action-visible",
  sessionPinActiveClassName: "opacity-100 text-[var(--app-fg)]",
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
