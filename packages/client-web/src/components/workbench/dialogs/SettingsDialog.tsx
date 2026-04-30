import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { SettingsPane } from "../../SettingsPane";

export function SettingsDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal forceMount>
        <Dialog.Overlay
          forceMount
          className="fixed inset-0 z-40 bg-black/40 data-[state=closed]:hidden"
        />
        <Dialog.Content
          forceMount
          className="fixed left-1/2 top-1/2 z-50 flex h-[min(88dvh,720px)] w-[min(960px,96vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)] p-0 shadow-2xl focus:outline-none data-[state=closed]:hidden max-md:inset-0 max-md:h-[100dvh] max-md:w-screen max-md:translate-x-0 max-md:translate-y-0 max-md:rounded-none max-md:border-0 max-md:pt-[env(safe-area-inset-top)] max-md:pb-[env(safe-area-inset-bottom)]"
        >
          <div className="flex items-center justify-between border-b border-[var(--app-border)] px-4 py-3 shrink-0 md:px-5">
            <div className="min-w-0">
              <Dialog.Title className="text-sm font-semibold text-[var(--app-fg)]">Settings</Dialog.Title>
              <Dialog.Description className="mt-0.5 text-xs text-[var(--app-hint)]">
                Appearance, chat behavior, version checks, and about information.
              </Dialog.Description>
            </div>
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
          <div className="min-h-0 flex-1">
            <SettingsPane />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
