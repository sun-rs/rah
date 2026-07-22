import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { ReviewSurface, type ReviewScope } from "./ReviewSurface";

export function ReviewDialog(props: {
  scope: ReviewScope;
  onClose: () => void;
}) {
  const title =
    props.scope.kind === "turn" ? "Review this turn" : "Review workspace";
  const description =
    props.scope.kind === "turn"
      ? "Read-only review of the files changed by this turn."
      : "Read-only review of the workspace's current Git changes.";

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) {
          props.onClose();
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-black/45" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[71] flex h-[88vh] w-[min(1440px,94vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] shadow-2xl outline-none max-md:inset-0 max-md:h-[100dvh] max-md:w-full max-md:translate-x-0 max-md:translate-y-0 max-md:rounded-none max-md:border-0">
          <div className="flex min-h-14 shrink-0 items-center gap-3 border-b border-[var(--app-border)] px-4">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="truncate text-base font-semibold text-[var(--app-fg)]">
                {title}
              </Dialog.Title>
              <Dialog.Description className="truncate text-xs text-[var(--app-hint)]">
                {description}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                className="icon-click-feedback inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                aria-label="Close review"
                title="Close"
              >
                <X size={18} />
              </button>
            </Dialog.Close>
          </div>
          <ReviewSurface scope={props.scope} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
