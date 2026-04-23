export const SIDEBAR_LAYOUT = {
  rootClassName: "space-y-3",
  toolbarClassName: "flex items-center justify-between px-1",
  toolbarLabelClassName: "text-xs font-medium text-[var(--app-hint)]",
  toolbarActionsClassName: "flex items-center gap-0.5",
  toolbarIconButtonClassName:
    "inline-flex h-9 w-9 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]",
  sortMenuClassName:
    "absolute right-0 top-9 z-20 w-44 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-1.5 shadow-lg",
  sortMenuItemClassName:
    "flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-left text-sm text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)]",
  sortMenuActionClassName:
    "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)]",
  workspaceListClassName: "space-y-1",
  workspaceBlockClassName: "space-y-1",
  workspaceHeaderClassName:
    "group/workspace flex min-h-[32px] items-center gap-1.5 rounded-lg px-2 py-1 transition-colors hover:bg-[var(--app-bg)]/30",
  workspaceHeaderSelectedClassName:
    "bg-[var(--app-bg)]/60",
  workspaceToggleButtonClassName:
    "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors hover:bg-[var(--app-bg)]/50 hover:text-[var(--app-fg)]",
  workspaceTitleButtonClassName:
    "min-w-0 flex-1 truncate rounded-md px-1 py-0.5 text-left text-sm text-[var(--app-fg)] transition-colors hover:bg-[var(--app-bg)]/60",
  workspaceTitleSelectedClassName:
    "font-semibold",
  workspaceActionSlotClassName:
    "flex w-9 shrink-0 items-center justify-center",
  workspaceActionButtonClassName:
    "inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors",
  workspaceActionHiddenClassName:
    "opacity-0 pointer-events-none transition-opacity group-hover/workspace:pointer-events-auto group-hover/workspace:opacity-100 group-focus-within/workspace:pointer-events-auto group-focus-within/workspace:opacity-100 coarse-pointer-action-visible",
  workspaceActionDangerClassName:
    "hover:bg-[var(--app-danger)]/10 hover:text-[var(--app-danger)] disabled:opacity-30",
  sessionListClassName: "space-y-0.5 pt-0.5 pl-0.5 pr-0.5",
  sessionRowBaseClassName:
    "group/session relative w-full min-h-[32px] rounded-lg border px-2 py-1 text-left transition-colors",
  sessionRowSelectedClassName:
    "border-emerald-500/20 bg-emerald-500/8 text-[var(--app-fg)] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.02),inset_3px_0_0_0_rgba(52,211,153,0.52)]",
  sessionRowIdleClassName:
    "border-transparent text-[color:color-mix(in_oklab,var(--app-fg)_94%,var(--app-hint))] hover:bg-[var(--app-bg)]/8",
  sessionInlineRowClassName: "flex items-center gap-1.5",
  sessionHeaderClassName: "flex min-w-0 flex-1 items-center gap-1.5",
  sessionIconSlotClassName: "inline-flex h-7 w-7 shrink-0 items-center justify-center",
  sessionIconClassName: "h-4.5 w-4.5",
  sessionTitleClassName: "min-w-0 flex-1 truncate text-[12px]",
  sessionPinSlotClassName:
    "ml-auto flex h-7 w-7 shrink-0 items-center justify-center",
  sessionPinButtonClassName:
    "inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--app-hint)]/80 transition-all hover:text-[var(--app-fg)]",
  sessionPinHiddenClassName:
    "opacity-0 pointer-events-none transition-opacity group-hover/session:pointer-events-auto group-hover/session:opacity-100 group-focus-within/session:pointer-events-auto group-focus-within/session:opacity-100 coarse-pointer-action-visible",
  sessionPinActiveClassName: "opacity-100 text-[var(--app-fg)]",
  sessionMetaRowClassName:
    "flex shrink-0 items-center gap-1.5",
  sessionMetaLeftClassName: "flex min-w-0 items-center gap-1.5",
  sessionStatusBadgeBaseClassName:
    "inline-flex shrink-0 items-center text-[10px] font-medium tracking-normal",
  sessionStatusBadgeClassByStatus: {
    approval: "text-orange-700/90 dark:text-orange-400/90",
    thinking: "text-sky-600/90 dark:text-sky-400/90",
    unread: "text-amber-700/90 dark:text-amber-400/90",
    ready: "text-[var(--app-hint)]",
  },
  sessionTimeClassName:
    "min-w-[3.5rem] shrink-0 text-right text-[11px] text-[var(--app-hint)]",
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
