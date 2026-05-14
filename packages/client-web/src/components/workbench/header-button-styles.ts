export const HEADER_ACTION_GROUP_CLASS = "flex shrink-0 items-center gap-1.5";

export function headerRightPaddingClass(rightSidebarOpen: boolean): string {
  return rightSidebarOpen ? "pr-4" : "pr-[calc(max(1rem,env(safe-area-inset-right))+2.75rem)]";
}

export const HEADER_ICON_BUTTON_BASE_CLASS =
  "icon-click-feedback h-8 w-8 items-center justify-center rounded-md border border-[var(--app-border)] text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] disabled:opacity-40";

export const HEADER_ICON_BUTTON_CLASS = `inline-flex ${HEADER_ICON_BUTTON_BASE_CLASS}`;

export const HEADER_TEXT_BUTTON_BASE_CLASS =
  "icon-click-feedback h-8 items-center justify-center rounded-md border border-[var(--app-border)] px-2 text-xs text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] disabled:opacity-40";

export const HEADER_TEXT_BUTTON_CLASS = `inline-flex ${HEADER_TEXT_BUTTON_BASE_CLASS}`;

export const HEADER_SEGMENTED_CONTROL_CLASS =
  "inline-flex h-8 items-center rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-0.5";

export const HEADER_SEGMENTED_BUTTON_BASE_CLASS =
  "icon-click-feedback inline-flex h-6 min-w-9 items-center justify-center rounded px-2 text-[11px] font-semibold transition-colors";
