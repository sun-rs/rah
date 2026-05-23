import {
  SEGMENTED_CONTROL_ACTIVE_CLASS,
  SEGMENTED_CONTROL_INACTIVE_CLASS,
  SEGMENTED_CONTROL_SIZE_CLASSES,
} from "../segmented-control-styles";

export const HEADER_ACTION_GROUP_CLASS = "flex shrink-0 items-center gap-1.5";

export const HEADER_IDENTITY_SLOT_CLASS =
  "inline-flex h-6 w-6 shrink-0 items-center justify-center";

export const HEADER_ICON_BUTTON_BASE_CLASS =
  "icon-click-feedback h-8 w-8 items-center justify-center rounded-md border border-[var(--app-border)] text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] disabled:opacity-40";

export const HEADER_ICON_BUTTON_CLASS = `inline-flex ${HEADER_ICON_BUTTON_BASE_CLASS}`;

export const HEADER_TEXT_BUTTON_BASE_CLASS =
  "icon-click-feedback h-8 items-center justify-center rounded-md border border-[var(--app-border)] px-2 text-xs text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] disabled:opacity-40";

export const HEADER_TEXT_BUTTON_CLASS = `inline-flex ${HEADER_TEXT_BUTTON_BASE_CLASS}`;

export const HEADER_DANGER_TEXT_BUTTON_CLASS =
  "icon-click-feedback inline-flex h-8 items-center justify-center rounded-md border border-rose-500/25 px-2 text-xs text-rose-600 transition-colors hover:border-rose-400/60 hover:bg-rose-500/10 hover:text-rose-600 disabled:opacity-40 dark:text-rose-400";

export const HEADER_RESPONSIVE_TEXT_BUTTON_CLASS =
  "icon-click-feedback inline-flex h-8 w-8 min-[900px]:w-auto items-center justify-center rounded-md border border-[var(--app-border)] px-0 min-[900px]:px-2 text-xs text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] disabled:opacity-40";

export const HEADER_SEGMENTED_CONTROL_BASE_CLASS =
  SEGMENTED_CONTROL_SIZE_CLASSES.header.root;

export const HEADER_SEGMENTED_CONTROL_CLASS = `inline-flex ${HEADER_SEGMENTED_CONTROL_BASE_CLASS}`;

export const HEADER_SEGMENTED_BUTTON_BASE_CLASS =
  SEGMENTED_CONTROL_SIZE_CLASSES.header.button;

export const HEADER_SEGMENTED_BUTTON_ACTIVE_CLASS =
  SEGMENTED_CONTROL_ACTIVE_CLASS;

export const HEADER_SEGMENTED_BUTTON_INACTIVE_CLASS =
  SEGMENTED_CONTROL_INACTIVE_CLASS;

export const HEADER_SEGMENTED_LABEL_CLASS = SEGMENTED_CONTROL_SIZE_CLASSES.header.label;

export const HEADER_MENU_ITEM_CLASS =
  "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)] disabled:cursor-not-allowed disabled:text-[var(--app-hint)] disabled:opacity-45 disabled:hover:bg-transparent";

export const HEADER_MENU_DANGER_ITEM_CLASS =
  "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-[var(--app-danger)] transition-colors hover:bg-[var(--app-subtle-bg)] disabled:cursor-not-allowed disabled:text-[var(--app-hint)] disabled:opacity-45 disabled:hover:bg-transparent";
