import type { ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { TerminalPane, type TerminalPaneProps } from "../../TerminalPane";

type TerminalDialogFrameProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  subtitle?: ReactNode;
  leading?: ReactNode;
  headerActions?: ReactNode;
  closeLabel: string;
  closeTitle: string;
  closeText?: string;
  contentTestId?: string;
  dataTerminalId?: string;
  dataTerminalCwd?: string;
  overlayClassName?: string;
  contentClassName?: string;
  forceMount?: boolean;
  children: ReactNode;
};

const DEFAULT_TERMINAL_DIALOG_OVERLAY_CLASS = "fixed inset-0 z-40 bg-black/45";
const DEFAULT_TERMINAL_DIALOG_CONTENT_CLASS =
  "fixed inset-0 z-50 flex h-[100dvh] w-screen flex-col overflow-hidden bg-[var(--app-bg)] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] focus:outline-none md:left-1/2 md:top-1/2 md:h-[82vh] md:w-[min(1280px,96vw)] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-2xl md:border md:border-[var(--app-border)] md:pt-0 md:pb-0 md:shadow-2xl";

export function TerminalDialogFrame(props: TerminalDialogFrameProps) {
  const overlayClassName = props.overlayClassName ?? DEFAULT_TERMINAL_DIALOG_OVERLAY_CLASS;
  const contentClassName = props.contentClassName ?? DEFAULT_TERMINAL_DIALOG_CONTENT_CLASS;
  const forceMountProps = props.forceMount ? ({ forceMount: true } as const) : {};
  const forceMountedClosedStyle =
    props.forceMount && !props.open
      ? { opacity: 0, pointerEvents: "none", visibility: "hidden" } as const
      : undefined;
  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange} modal={props.open}>
      <Dialog.Portal {...forceMountProps}>
        <Dialog.Overlay
          {...forceMountProps}
          className={overlayClassName}
          style={forceMountedClosedStyle}
        />
        <Dialog.Content
          {...forceMountProps}
          data-testid={props.contentTestId}
          data-terminal-id={props.dataTerminalId}
          data-terminal-cwd={props.dataTerminalCwd}
          onEscapeKeyDown={(event) => event.preventDefault()}
          className={contentClassName}
          style={forceMountedClosedStyle}
        >
          <div className="flex items-center justify-between gap-3 border-b border-[var(--app-border)] px-3 py-2.5 md:px-4 md:py-3">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              {props.leading}
              <div className="min-w-0">
                <Dialog.Title className="truncate text-sm font-semibold text-[var(--app-fg)] md:text-base">
                  {props.title}
                </Dialog.Title>
                {props.subtitle ? (
                  <div className="truncate text-[11px] text-[var(--app-hint)]">
                    {props.subtitle}
                  </div>
                ) : null}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {props.headerActions}
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="icon-click-feedback inline-flex h-8 w-8 shrink-0 items-center justify-center gap-1 rounded-md border border-[var(--app-border)] text-[11px] font-semibold text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] min-[900px]:w-auto min-[900px]:px-2"
                  aria-label={props.closeLabel}
                  title={props.closeTitle}
                >
                  <X size={14} />
                  {props.closeText ? (
                    <span className="hidden min-[900px]:inline">{props.closeText}</span>
                  ) : null}
                </button>
              </Dialog.Close>
            </div>
          </div>
          {props.children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export type TerminalTabDescriptor = {
  id: string;
  label: ReactNode;
  title?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  controls?: ReactNode;
  editing?: boolean;
};

export function TerminalTabStrip(props: {
  tabs: TerminalTabDescriptor[];
  activeTabId: string | null;
  onTabSelect: (tabId: string) => void;
  endAdornment?: ReactNode;
}) {
  if (props.tabs.length === 0 && !props.endAdornment) {
    return null;
  }
  return (
    <div className="flex items-center gap-1.5 bg-[var(--app-bg)] px-3 py-1 md:px-4 md:py-1">
      <div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto rah-scroll-code">
        {props.tabs.map((tab) => {
          const active = tab.id === props.activeTabId;
          return (
            <div
              key={tab.id}
              className={`group flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-left transition-colors ${
                active
                  ? "border-[var(--app-border)] bg-[var(--app-subtle-bg)] text-[var(--app-fg)]"
                  : "border-transparent bg-transparent text-[var(--app-hint)] hover:border-[var(--app-border)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
              }`}
              title={tab.title}
            >
              {tab.editing ? (
                <div className="flex min-w-0 items-center gap-1.5">
                  {tab.leading}
                  {tab.label}
                  {tab.trailing}
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => props.onTabSelect(tab.id)}
                  className="flex min-w-0 items-center gap-1.5"
                >
                  {tab.leading}
                  {tab.label}
                  {tab.trailing}
                </button>
              )}
              {tab.controls}
            </div>
          );
        })}
        {props.endAdornment}
      </div>
    </div>
  );
}

export type TerminalPaneStackTab = {
  id: string;
  terminalId: string;
  label: string;
};

type TerminalPaneStackProps = {
  tabs: TerminalPaneStackTab[];
  activeTabId: string | null;
  clientId: string;
  className?: string;
  emptyState?: ReactNode;
  terminalProps?: (
    tab: TerminalPaneStackTab,
    active: boolean,
  ) => Omit<TerminalPaneProps, "terminalId" | "clientId" | "hasControl"> &
    Partial<Pick<TerminalPaneProps, "hasControl">>;
};

export function TerminalPaneStack(props: TerminalPaneStackProps) {
  const containerClassName = props.className ?? "min-h-0 flex-1 px-3 pb-3 pt-0 md:px-5 md:pb-5 md:pt-0";
  if (props.tabs.length === 0) {
    return <div className={containerClassName}>{props.emptyState}</div>;
  }
  return (
    <div className={containerClassName}>
      <div className="relative h-full min-h-0">
        {props.tabs.map((tab) => {
          const active = tab.id === props.activeTabId;
          const paneProps = props.terminalProps?.(tab, active) ?? {};
          const hasControl = paneProps.hasControl ?? active;
          return (
            <div
              key={tab.id}
              className={`absolute inset-0 ${
                active ? "visible opacity-100" : "invisible pointer-events-none opacity-0"
              }`}
              aria-hidden={!active}
              {...(!active ? ({ inert: "" } as Record<string, string>) : {})}
            >
              <TerminalPane
                terminalId={tab.terminalId}
                clientId={props.clientId}
                {...paneProps}
                hasControl={hasControl}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
