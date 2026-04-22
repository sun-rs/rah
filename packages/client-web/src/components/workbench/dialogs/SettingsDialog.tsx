import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { SettingsPane } from "../../SettingsPane";

export function SettingsDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40 z-40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 max-h-[85vh] w-[90vw] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-0 shadow-xl focus:outline-none z-50 flex flex-col">
          <div className="flex items-center justify-between border-b border-[var(--app-border)] px-4 py-3 shrink-0">
            <Dialog.Title className="text-sm font-semibold text-[var(--app-fg)]">Settings</Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] transition-colors"
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>
          <div className="flex-1 overflow-y-auto custom-scrollbar">
            <SettingsPane />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
