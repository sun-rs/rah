import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";

export function ConfirmDialog(props: {
  open: boolean;
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  confirmTone?: "primary" | "danger";
  pending?: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const confirmClassName =
    props.confirmTone === "danger"
      ? "rounded-lg bg-[var(--app-danger)] px-3 py-2 text-xs font-medium text-white hover:opacity-90 disabled:opacity-40 transition-colors"
      : "rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40 transition-colors";

  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40 z-40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex w-[90vw] max-w-sm -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-0 shadow-xl focus:outline-none max-md:max-w-[calc(100vw-2rem)]">
          <div className="flex items-center justify-between border-b border-[var(--app-border)] px-4 py-3 shrink-0">
            <Dialog.Title className="text-sm font-semibold text-[var(--app-fg)]">
              {props.title}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                disabled={props.pending}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] disabled:opacity-40 transition-colors"
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>
          <div className="px-4 py-4 text-sm text-[var(--app-hint)]">{props.description}</div>
          <div className="flex items-center justify-end gap-2 border-t border-[var(--app-border)] px-4 py-3">
            <Dialog.Close asChild>
              <button
                type="button"
                disabled={props.pending}
                className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-xs font-medium text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] disabled:opacity-40 transition-colors"
              >
                {props.cancelLabel ?? "Cancel"}
              </button>
            </Dialog.Close>
            <button
              type="button"
              disabled={!props.open || props.pending}
              onClick={props.onConfirm}
              className={confirmClassName}
            >
              {props.confirmLabel}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
