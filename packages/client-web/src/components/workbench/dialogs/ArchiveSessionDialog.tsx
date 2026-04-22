import type { SessionSummary } from "@rah/runtime-protocol";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";

export function ArchiveSessionDialog(props: {
  open: boolean;
  archiving: boolean;
  targetSummary: SessionSummary | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40 z-40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 w-[90vw] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-0 shadow-xl focus:outline-none z-50 flex flex-col">
          <div className="flex items-center justify-between border-b border-[var(--app-border)] px-4 py-3 shrink-0">
            <Dialog.Title className="text-sm font-semibold text-[var(--app-fg)]">
              Archive session?
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                disabled={props.archiving}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] disabled:opacity-40 transition-colors"
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>
          <div className="px-4 py-4 text-sm text-[var(--app-hint)]">
            {props.targetSummary ? (
              <>
                Archive{" "}
                <span className="font-medium text-[var(--app-fg)]">
                  {props.targetSummary.session.title ?? props.targetSummary.session.id}
                </span>
                ? You can reopen it from Session History.
              </>
            ) : (
              "Archive this live session? You can reopen it from Session History."
            )}
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-[var(--app-border)] px-4 py-3">
            <Dialog.Close asChild>
              <button
                type="button"
                disabled={props.archiving}
                className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-xs font-medium text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] disabled:opacity-40 transition-colors"
              >
                Cancel
              </button>
            </Dialog.Close>
            <button
              type="button"
              disabled={!props.open || props.archiving}
              onClick={props.onConfirm}
              className="rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40 transition-colors"
            >
              {props.archiving ? "Archiving…" : "Archive"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
