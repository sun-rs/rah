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
  workspaceBlockClassName: "space-y-0.5",
  workspaceHeaderClassName:
    "group/workspace flex min-h-[34px] items-center gap-2 rounded-lg px-2.5 py-1.5 transition-colors hover:bg-[var(--app-bg)]/30",
  workspaceHeaderSelectedClassName:
    "bg-[var(--app-bg)]/60",
  workspaceToggleButtonClassName:
    "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors hover:bg-[var(--app-bg)]/50 hover:text-[var(--app-fg)]",
  workspaceTitleButtonClassName:
    "min-w-0 flex-1 truncate rounded-md px-1 py-0.5 text-left text-sm text-[var(--app-fg)] transition-colors hover:bg-[var(--app-bg)]/60",
  workspaceActionSlotClassName:
    "flex w-9 shrink-0 items-center justify-center",
  workspaceActionButtonClassName:
    "inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors",
  workspaceActionHiddenClassName:
    "opacity-0 pointer-events-none group-hover/workspace:pointer-events-auto group-hover/workspace:opacity-100 transition-opacity",
  workspaceActionDangerClassName:
    "hover:bg-[var(--app-danger)]/10 hover:text-[var(--app-danger)] disabled:opacity-30",
  sessionListClassName: "space-y-0.5 pl-4 pr-0.5",
  sessionRowBaseClassName:
    "group/session w-full min-h-[60px] rounded-lg px-2 py-2 text-left transition-colors",
  sessionRowSelectedClassName:
    "bg-[var(--app-bg)]/60 text-[var(--app-fg)]",
  sessionRowIdleClassName:
    "text-[var(--app-fg)] hover:bg-[var(--app-bg)]/30",
  sessionHeaderClassName: "flex min-w-0 items-center gap-1.5",
  sessionIconClassName: "h-5 w-5",
  sessionTitleClassName: "min-w-0 flex-1 truncate text-sm",
  sessionPinSlotClassName:
    "ml-auto flex h-8 w-8 shrink-0 items-center justify-center",
  sessionPinButtonClassName:
    "inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--app-hint)] transition-all hover:bg-[var(--app-bg)]/50 hover:text-[var(--app-fg)]",
  sessionPinHiddenClassName:
    "opacity-0 pointer-events-none group-hover/session:pointer-events-auto group-hover/session:opacity-100",
  sessionPinActiveClassName: "opacity-100 text-[var(--app-fg)]",
  sessionMetaRowClassName:
    "mt-1 flex min-h-[20px] items-center justify-between gap-2",
  sessionMetaLeftClassName: "flex min-w-0 items-center gap-1.5",
  sessionStatusBadgeBaseClassName:
    "inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.5 text-[11px] font-medium",
  sessionStatusBadgeClassByStatus: {
    approval: "border-orange-500/20 bg-orange-500/10 text-orange-700 dark:text-orange-400",
    thinking: "border-sky-500/20 bg-sky-500/10 text-sky-600 dark:text-sky-400",
    unread: "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-400",
    ready: "border-[var(--app-border)] bg-[var(--app-bg)]/60 text-[var(--app-hint)]",
  },
  sessionTimeClassName:
    "min-w-[3.25rem] shrink-0 text-right text-xs text-[var(--app-hint)]",
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
