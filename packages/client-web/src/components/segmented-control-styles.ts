export type SegmentedControlSize = "header" | "dialog" | "panel" | "compact";

export const SEGMENTED_CONTROL_ACTIVE_CLASS =
  "bg-sky-500/12 text-sky-700 shadow-none ring-1 ring-inset ring-sky-500/30 dark:bg-sky-400/16 dark:text-sky-100 dark:ring-sky-300/30";

export const SEGMENTED_CONTROL_NEUTRAL_ACTIVE_CLASS =
  "bg-[var(--app-bg)] text-[var(--app-fg)] shadow-sm";

export const SEGMENTED_CONTROL_INACTIVE_CLASS =
  "text-[var(--app-hint)] hover:bg-[color:color-mix(in_oklab,var(--app-bg)_60%,transparent)] hover:text-[var(--app-fg)]";

export const SEGMENTED_CONTROL_SIZE_CLASSES: Record<
  SegmentedControlSize,
  { root: string; button: string; active: string; label: string }
> = {
  header: {
    root: "h-8 items-center rounded-md border border-[color:color-mix(in_oklab,var(--app-border)_78%,transparent)] bg-[color:color-mix(in_oklab,var(--app-subtle-bg)_88%,transparent)] p-0.5",
    button:
      "icon-click-feedback inline-flex h-6 min-w-9 items-center justify-center rounded-[5px] px-2 text-[11px] font-semibold leading-none transition-colors",
    active: SEGMENTED_CONTROL_ACTIVE_CLASS,
    label: "relative -top-px leading-none",
  },
  dialog: {
    root: "items-center rounded-lg border border-[color:color-mix(in_oklab,var(--app-border)_72%,transparent)] bg-[color:color-mix(in_oklab,var(--app-subtle-bg)_88%,transparent)] p-1",
    button:
      "icon-click-feedback inline-flex min-h-9 items-center justify-center rounded-md px-3 py-2 text-sm font-semibold leading-none transition-colors",
    active: SEGMENTED_CONTROL_NEUTRAL_ACTIVE_CLASS,
    label: "leading-none",
  },
  panel: {
    root: "items-center rounded-lg border border-[color:color-mix(in_oklab,var(--app-border)_72%,transparent)] bg-[color:color-mix(in_oklab,var(--app-subtle-bg)_88%,transparent)] p-1",
    button:
      "icon-click-feedback inline-flex min-h-8 items-center justify-center rounded-md px-3 py-1.5 text-sm font-medium leading-none transition-colors",
    active: SEGMENTED_CONTROL_NEUTRAL_ACTIVE_CLASS,
    label: "leading-none",
  },
  compact: {
    root: "items-center rounded-lg border border-[color:color-mix(in_oklab,var(--app-border)_72%,transparent)] bg-[color:color-mix(in_oklab,var(--app-subtle-bg)_88%,transparent)] p-0.5",
    button:
      "icon-click-feedback inline-flex min-h-7 items-center justify-center rounded-md px-2.5 py-1.5 text-xs font-medium leading-none transition-colors",
    active: SEGMENTED_CONTROL_NEUTRAL_ACTIVE_CLASS,
    label: "leading-none",
  },
};
