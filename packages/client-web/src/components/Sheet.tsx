import * as Dialog from "@radix-ui/react-dialog";
import { PanelRight, X } from "lucide-react";
import type { ReactNode } from "react";
import {
  HEADER_EDGE_TOGGLE_BUTTON_CLASS,
  HEADER_EDGE_TOGGLE_ICON_SIZE,
} from "./workbench/header-button-styles";

export function Sheet(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  side: "left" | "right";
  title: ReactNode;
  children: ReactNode;
  headerRight?: ReactNode;
  headerLayout?: "spread" | "inline";
  closePlacement?: "start" | "end";
  hideHeader?: boolean;
  modal?: boolean;
  floatingClose?: "panel" | "x";
  floatingCloseLabel?: string;
  viewportClassName?: string;
}) {
  const closePlacement = props.closePlacement ?? "end";
  const closeButton = (
    <Dialog.Close asChild>
      <button
        type="button"
        className={HEADER_EDGE_TOGGLE_BUTTON_CLASS}
        aria-label="Close"
        title="Close"
      >
        <X size={HEADER_EDGE_TOGGLE_ICON_SIZE} />
      </button>
    </Dialog.Close>
  );

  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange} modal={props.modal ?? true}>
      <Dialog.Portal>
        <Dialog.Overlay className={`fixed inset-0 bg-black/40 z-50 ${props.viewportClassName ?? ""}`} />
        <Dialog.Content
          className={`fixed top-0 bottom-0 z-50 w-80 max-w-[85vw] border-[var(--app-border)] shadow-xl outline-none pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] ${
            props.side === "left"
              ? "left-0 border-r bg-[var(--app-subtle-bg)]"
              : "right-0 border-l bg-[var(--app-bg)]"
          } flex flex-col ${props.viewportClassName ?? ""}`}
        >
          {props.hideHeader ? (
            <>
              <Dialog.Title className="sr-only">{props.title}</Dialog.Title>
              {props.floatingClose ? (
                <Dialog.Close asChild>
                  <button
                    type="button"
                    className={`${HEADER_EDGE_TOGGLE_BUTTON_CLASS} absolute right-2 top-[calc(env(safe-area-inset-top,0px)+0.75rem)] z-[60] bg-[var(--app-bg)]/90 backdrop-blur`}
                    aria-label={props.floatingCloseLabel ?? "Close"}
                    title={props.floatingCloseLabel ?? "Close"}
                  >
                    {props.floatingClose === "panel" ? (
                      <PanelRight size={HEADER_EDGE_TOGGLE_ICON_SIZE} />
                    ) : (
                      <X size={HEADER_EDGE_TOGGLE_ICON_SIZE} />
                    )}
                  </button>
                </Dialog.Close>
              ) : null}
            </>
          ) : props.headerLayout === "inline" ? (
            <div className="flex shrink-0 items-center gap-1 border-b border-[var(--app-border)] px-2 py-2">
              {closePlacement === "start" ? closeButton : null}
              <Dialog.Title className="shrink-0 text-sm font-semibold text-[var(--app-fg)]">
                {props.title}
              </Dialog.Title>
              {props.headerRight ? (
                <div className="flex min-w-0 shrink-0 items-center gap-1">{props.headerRight}</div>
              ) : null}
              {closePlacement === "end" ? closeButton : null}
            </div>
          ) : (
            <div className="flex items-center justify-between border-b border-[var(--app-border)] px-4 py-3 shrink-0">
              <Dialog.Title className="text-sm font-semibold text-[var(--app-fg)]">
                {props.title}
              </Dialog.Title>
              <div className="flex items-center gap-1">
                {props.headerRight}
                {closeButton}
              </div>
            </div>
          )}
          <div className="flex-1 overflow-y-auto overscroll-y-contain rah-scroll-panel rah-scroll-panel-y pb-[env(safe-area-inset-bottom)]">
            {props.children}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
