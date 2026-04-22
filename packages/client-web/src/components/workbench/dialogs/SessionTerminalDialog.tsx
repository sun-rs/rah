import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { LoaderCircle, X } from "lucide-react";
import type { IndependentTerminalSession } from "@rah/runtime-protocol";
import { closeIndependentTerminal, startIndependentTerminal } from "../../../api";
import { TerminalPane } from "../../../TerminalPane";

export function SessionTerminalDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clientId: string;
  cwd: string;
}) {
  const [terminal, setTerminal] = useState<IndependentTerminalSession | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!props.open) {
      return;
    }
    let cancelled = false;
    let activeTerminalId: string | null = null;
    setTerminal(null);
    setError(null);
    setLoading(true);

    void startIndependentTerminal({ cwd: props.cwd })
      .then((created) => {
        if (cancelled) {
          activeTerminalId = created.id;
          void closeIndependentTerminal(created.id);
          return;
        }
        activeTerminalId = created.id;
        setTerminal(created);
      })
      .catch((nextError) => {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : String(nextError));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
      setTerminal(null);
      if (activeTerminalId) {
        void closeIndependentTerminal(activeTerminalId);
      }
    };
  }, [props.cwd, props.open]);

  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/45" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex h-[82vh] w-[min(1280px,96vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)] shadow-2xl focus:outline-none">
          <div className="flex items-start justify-between gap-4 border-b border-[var(--app-border)] px-5 py-4">
            <div className="min-w-0">
              <Dialog.Title className="truncate text-base font-semibold text-[var(--app-fg)]">
                Terminal
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-xs text-[var(--app-hint)]">
                {terminal?.cwd ?? props.cwd}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                aria-label="Close terminal"
                title="Close terminal"
              >
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>

          <div className="border-b border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-5 py-2 text-[11px] text-[var(--app-hint)]">
            Independent shell terminal. This is separate from Codex / Claude sessions.
          </div>

          <div className="min-h-0 flex-1 p-5">
            {loading ? (
              <div className="flex h-full items-center justify-center gap-2 text-sm text-[var(--app-hint)]">
                <LoaderCircle size={16} className="animate-spin" />
                Starting terminal…
              </div>
            ) : error ? (
              <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-danger-bg)] p-3 text-sm text-[var(--app-fg)]">
                Failed to start terminal: {error}
              </div>
            ) : terminal ? (
              <TerminalPane
                sessionId={terminal.id}
                clientId={props.clientId}
                hasControl
              />
            ) : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
