import * as Dialog from "@radix-ui/react-dialog";
import { PanelRight, X } from "lucide-react";
import type { ReactNode } from "react";

export function Sheet(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  side: "left" | "right";
  title: ReactNode;
  children: ReactNode;
  headerRight?: ReactNode;
  hideHeader?: boolean;
  modal?: boolean;
  floatingClose?: "panel" | "x";
  floatingCloseLabel?: string;
}) {
  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange} modal={props.modal ?? true}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40 z-50" />
        <Dialog.Content
          className={`fixed top-0 bottom-0 z-50 w-80 max-w-[85vw] border-[var(--app-border)] shadow-xl outline-none pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] ${
            props.side === "left"
              ? "left-0 border-r bg-[var(--app-subtle-bg)]"
              : "right-0 border-l bg-[var(--app-bg)]"
          } flex flex-col`}
        >
          {props.hideHeader ? (
            <>
              <Dialog.Title className="sr-only">{props.title}</Dialog.Title>
              {props.floatingClose ? (
                <Dialog.Close asChild>
                  <button
                    type="button"
                    className="icon-click-feedback fixed right-[max(1rem,env(safe-area-inset-right))] top-[calc(env(safe-area-inset-top,0px)+0.75rem)] z-[60] inline-flex h-8 w-8 items-center justify-center rounded-md border border-[var(--app-border)] bg-[var(--app-bg)]/90 text-[var(--app-hint)] shadow-sm backdrop-blur transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                    aria-label={props.floatingCloseLabel ?? "Close"}
                    title={props.floatingCloseLabel ?? "Close"}
                  >
                    {props.floatingClose === "panel" ? <PanelRight size={18} /> : <X size={16} />}
                  </button>
                </Dialog.Close>
              ) : null}
            </>
          ) : (
            <div className="flex items-center justify-between border-b border-[var(--app-border)] px-4 py-3 shrink-0">
              <Dialog.Title className="text-sm font-semibold text-[var(--app-fg)]">
                {props.title}
              </Dialog.Title>
              <div className="flex items-center gap-1">
                {props.headerRight}
                <Dialog.Close asChild>
                  <button
                    type="button"
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] transition-colors"
                    aria-label="Close"
                  >
                    <X size={16} />
                  </button>
                </Dialog.Close>
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
