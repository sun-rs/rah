import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Ellipsis, Menu, PanelRight, Square, X } from "lucide-react";
import {
  HEADER_ACTION_GROUP_CLASS,
  HEADER_EDGE_TOGGLE_BUTTON_CLASS,
  HEADER_EDGE_TOGGLE_ICON_SIZE,
  HEADER_IDENTITY_SLOT_CLASS,
  HEADER_ICON_BUTTON_CLASS,
  HEADER_RESPONSIVE_TEXT_BUTTON_CLASS,
  HEADER_SIDE_PANEL_TOGGLE_BUTTON_CLASS,
} from "../header-button-styles";

type ReserveBreakpoint = "md" | "wide";

function reserveClassName(breakpoint: ReserveBreakpoint): string {
  return breakpoint === "wide"
    ? "min-[900px]:pr-11"
    : "md:pr-11";
}

export function ConversationHeader(props: {
  title: ReactNode;
  titleText?: string;
  identity?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  closeAction?: {
    ariaLabel: string;
    title: string;
    onClick: () => void;
    disabled?: boolean;
    label?: string;
  } | null;
  trailingActions?: ReactNode;
  sidebarOpen: boolean;
  showLeftSidebarControls?: boolean;
  onOpenLeft: () => void;
  onExpandSidebar: () => void;
  reserveRightPanelToggleSpace?: boolean;
  reserveRightPanelBreakpoint?: ReserveBreakpoint;
  compactCloseAction?: boolean;
  backgroundClassName?: string;
  className?: string;
}) {
  const showLeftSidebarControls = props.showLeftSidebarControls ?? true;
  const reserveRightPanelClassName = props.reserveRightPanelToggleSpace
    ? reserveClassName(props.reserveRightPanelBreakpoint ?? "md")
    : "";

  return (
    <header
      className={`relative z-20 flex h-14 shrink-0 items-center justify-between gap-3 border-b border-[var(--app-border)] ${props.backgroundClassName ?? "bg-[var(--app-bg)]/80"} px-2 backdrop-blur-sm ${reserveRightPanelClassName} ${props.className ?? ""}`}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
        {showLeftSidebarControls ? (
          <button
            type="button"
            className={`${HEADER_EDGE_TOGGLE_BUTTON_CLASS} md:hidden`}
            onClick={props.onOpenLeft}
            aria-label="Open sidebar"
            title="Open sidebar"
          >
            <Menu size={HEADER_EDGE_TOGGLE_ICON_SIZE} />
          </button>
        ) : null}
        {showLeftSidebarControls && !props.sidebarOpen ? (
          <button
            type="button"
            className={`${HEADER_EDGE_TOGGLE_BUTTON_CLASS} hidden md:inline-flex`}
            onClick={props.onExpandSidebar}
            aria-label="Expand sidebar"
            title="Expand sidebar"
          >
            <Menu size={HEADER_EDGE_TOGGLE_ICON_SIZE} />
          </button>
        ) : null}
        {props.identity ? (
          <span className={HEADER_IDENTITY_SLOT_CLASS}>{props.identity}</span>
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-[var(--app-fg)]" title={props.titleText}>
            {props.title}
          </div>
          {props.meta ? (
            <div className="mt-0.5 flex min-h-[22px] min-w-0 items-center gap-1.5 overflow-hidden text-[11px] text-[var(--app-hint)]">
              {props.meta}
            </div>
          ) : null}
        </div>
      </div>
      {props.actions || props.closeAction || props.trailingActions ? (
        <div className={HEADER_ACTION_GROUP_CLASS}>
          {props.actions}
          {props.closeAction ? (
            <button
              type="button"
              className={
                props.compactCloseAction
                  ? HEADER_ICON_BUTTON_CLASS
                  : HEADER_RESPONSIVE_TEXT_BUTTON_CLASS
              }
              disabled={props.closeAction.disabled}
              onClick={props.closeAction.onClick}
              aria-label={props.closeAction.ariaLabel}
              title={props.closeAction.title}
            >
              <X size={14} className={props.compactCloseAction ? "" : "min-[900px]:mr-1"} />
              {props.compactCloseAction ? null : (
                <span className="hidden min-[900px]:inline">
                  {props.closeAction.label ?? "Close"}
                </span>
              )}
            </button>
          ) : null}
          {props.trailingActions}
        </div>
      ) : null}
    </header>
  );
}

export function ConversationHeaderIconButton(
  props: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode },
) {
  const { children, className, type = "button", ...buttonProps } = props;
  return (
    <button
      {...buttonProps}
      type={type}
      className={`${HEADER_ICON_BUTTON_CLASS}${className ? ` ${className}` : ""}`}
    >
      {children}
    </button>
  );
}

export function ConversationHeaderStopButton(props: {
  disabled?: boolean;
  onClick: () => void;
  ariaLabel: string;
  title: string;
  className?: string;
}) {
  return (
    <ConversationHeaderIconButton
      disabled={props.disabled}
      onClick={props.onClick}
      aria-label={props.ariaLabel}
      title={props.title}
      className={props.className}
    >
      <Square size={14} className="text-rose-500/70" />
    </ConversationHeaderIconButton>
  );
}

export function ConversationHeaderMoreButton(props: {
  open: boolean;
  onClick: () => void;
  ariaLabel: string;
  title: string;
  className?: string;
}) {
  return (
    <ConversationHeaderIconButton
      onClick={props.onClick}
      aria-label={props.ariaLabel}
      aria-haspopup="menu"
      aria-expanded={props.open}
      title={props.title}
      className={props.className}
    >
      <Ellipsis size={16} />
    </ConversationHeaderIconButton>
  );
}

export function ConversationHeaderPanelToggleButton(props: {
  disabled?: boolean;
  onClick?: (() => void) | undefined;
  ariaLabel: string;
  title: string;
  open?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={props.onClick}
      aria-label={props.ariaLabel}
      aria-pressed={props.open}
      title={props.title}
      className={`${HEADER_SIDE_PANEL_TOGGLE_BUTTON_CLASS}${props.className ? ` ${props.className}` : ""}`}
    >
      <PanelRight size={HEADER_EDGE_TOGGLE_ICON_SIZE} />
    </button>
  );
}
