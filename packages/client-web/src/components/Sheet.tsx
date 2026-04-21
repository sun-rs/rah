import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";

export function Sheet(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  side: "left" | "right";
  title: string;
  children: React.ReactNode;
  headerRight?: React.ReactNode;
}) {
  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40 z-50" />
        <Dialog.Content
          className={`fixed top-0 bottom-0 z-50 w-80 max-w-[85vw] border-[var(--app-border)] shadow-xl outline-none ${
            props.side === "left"
              ? "left-0 border-r bg-[var(--app-subtle-bg)]"
              : "right-0 border-l bg-[var(--app-bg)]"
          } flex flex-col`}
        >
          <div className="flex items-center justify-between border-b border-[var(--app-border)] px-4 py-3 shrink-0">
            <Dialog.Title className="text-sm font-semibold text-[var(--app-fg)]">
              {props.title}
            </Dialog.Title>
            <div className="flex items-center gap-1">
              {props.headerRight}
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
          </div>
          <div className="flex-1 overflow-y-auto custom-scrollbar">{props.children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
