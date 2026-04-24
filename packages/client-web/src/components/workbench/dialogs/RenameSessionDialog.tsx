import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useEffect, useState } from "react";

export function RenameSessionDialog(props: {
  open: boolean;
  initialTitle: string;
  pending?: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (title: string) => void;
}) {
  const [draft, setDraft] = useState(props.initialTitle);

  useEffect(() => {
    if (props.open) {
      setDraft(props.initialTitle);
    }
  }, [props.initialTitle, props.open]);

  const trimmed = draft.trim();

  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex w-[90vw] max-w-sm -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-0 shadow-xl focus:outline-none max-md:max-w-[calc(100vw-2rem)]">
          <div className="flex items-center justify-between border-b border-[var(--app-border)] px-4 py-3 shrink-0">
            <Dialog.Title className="text-sm font-semibold text-[var(--app-fg)]">
              Rename session
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
          <form
            className="flex flex-col"
            onSubmit={(event) => {
              event.preventDefault();
              if (!trimmed || props.pending) {
                return;
              }
              props.onConfirm(trimmed);
            }}
          >
            <div className="px-4 py-4">
              <label
                htmlFor="rename-session-title"
                className="mb-2 block text-xs font-medium text-[var(--app-hint)]"
              >
                Session title
              </label>
              <input
                id="rename-session-title"
                autoFocus
                maxLength={200}
                value={draft}
                disabled={props.pending}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Enter a session title"
                className="w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)] outline-none transition-colors placeholder:text-[var(--app-hint)] focus:border-primary disabled:opacity-60"
              />
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-[var(--app-border)] px-4 py-3">
              <Dialog.Close asChild>
                <button
                  type="button"
                  disabled={props.pending}
                  className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-xs font-medium text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] disabled:opacity-40 transition-colors"
                >
                  Cancel
                </button>
              </Dialog.Close>
              <button
                type="submit"
                disabled={!props.open || props.pending || !trimmed}
                className="rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40 transition-colors"
              >
                {props.pending ? "Renaming…" : "Rename"}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
