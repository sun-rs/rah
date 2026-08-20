import * as Dialog from "@radix-ui/react-dialog";
import { PanelRight, X } from "lucide-react";
import { useRef, type CSSProperties, type ReactNode } from "react";
import {
  HEADER_EDGE_TOGGLE_BUTTON_CLASS,
  HEADER_EDGE_TOGGLE_ICON_SIZE,
  HEADER_EDGE_TOGGLE_SAFE_AREA_TOP_CLASS,
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
  closeIcon?: ReactNode;
  closeLabel?: string;
  initialFocus?: "close" | "content";
  hideHeader?: boolean;
  modal?: boolean;
  floatingClose?: "panel" | "x";
  floatingCloseLabel?: string;
  viewportClassName?: string;
  contentClassName?: string;
  contentStyle?: CSSProperties;
  contentDataAttributes?: Record<`data-${string}`, string>;
  bodyClassName?: string;
  headerClassName?: string;
  headerTitleClassName?: string;
  fullScreen?: boolean;
}) {
  const closePlacement = props.closePlacement ?? "end";
  const contentRef = useRef<HTMLDivElement | null>(null);
  const closeLabel = props.closeLabel ?? "Close";
  const closeButton = (
    <Dialog.Close asChild>
      <button
        type="button"
        className={HEADER_EDGE_TOGGLE_BUTTON_CLASS}
        aria-label={closeLabel}
        title={closeLabel}
      >
        {props.closeIcon ?? <X size={HEADER_EDGE_TOGGLE_ICON_SIZE} />}
      </button>
    </Dialog.Close>
  );

  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange} modal={props.modal ?? true}>
      <Dialog.Portal>
        <Dialog.Overlay className={`fixed inset-0 bg-black/40 z-50 ${props.viewportClassName ?? ""}`} />
        <Dialog.Content
          {...props.contentDataAttributes}
          ref={contentRef}
          style={props.contentStyle}
          tabIndex={props.initialFocus === "content" ? -1 : undefined}
          onOpenAutoFocus={
            props.initialFocus === "content"
              ? (event) => {
                  event.preventDefault();
                  contentRef.current?.focus({ preventScroll: true });
                }
              : undefined
          }
          className={`fixed z-50 shadow-xl outline-none pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] ${
            props.fullScreen
              ? `inset-0 h-[100dvh] w-screen max-w-none border-0 ${
                  props.side === "left" ? "bg-[var(--app-subtle-bg)]" : "bg-[var(--app-bg)]"
                }`
              : `top-0 bottom-0 w-80 max-w-[85vw] border-[var(--app-border)] ${
                  props.side === "left"
                    ? "left-0 border-r bg-[var(--app-subtle-bg)]"
                    : "right-0 border-l bg-[var(--app-bg)]"
                }`
          } flex flex-col ${props.viewportClassName ?? ""} ${props.contentClassName ?? ""}`}
        >
          <Dialog.Description className="sr-only">
            {props.side === "left"
              ? "Navigation and workspace controls."
              : "Contextual details and controls."}
          </Dialog.Description>
          {props.hideHeader ? (
            <>
              <Dialog.Title className="sr-only">{props.title}</Dialog.Title>
              {props.floatingClose ? (
                <Dialog.Close asChild>
                  <button
                    type="button"
                    className={`${HEADER_EDGE_TOGGLE_BUTTON_CLASS} absolute right-2 ${HEADER_EDGE_TOGGLE_SAFE_AREA_TOP_CLASS} z-[60] bg-[var(--app-bg)]/90 backdrop-blur`}
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
            <div className={`flex shrink-0 items-center gap-1 border-b border-[var(--app-border)] px-2 py-2 ${props.headerClassName ?? ""}`}>
              {closePlacement === "start" ? closeButton : null}
              <Dialog.Title
                className={
                  props.headerTitleClassName ??
                  "shrink-0 text-sm font-semibold text-[var(--app-fg)]"
                }
              >
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
          <div
            className={
              props.bodyClassName ??
              "flex-1 overflow-y-auto overscroll-y-contain rah-scroll-panel rah-scroll-panel-y pb-[env(safe-area-inset-bottom)]"
            }
          >
            {props.children}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
