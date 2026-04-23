import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { LoaderCircle, PencilLine, Plus, RotateCcw, X } from "lucide-react";
import type { IndependentTerminalSession } from "@rah/runtime-protocol";
import { closeIndependentTerminal, startIndependentTerminal } from "../../../api";
import { TerminalPane } from "../../../TerminalPane";

function terminalTitle(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  return parts.at(-1) || cwd || "Terminal";
}

export function WorkbenchTerminalDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clientId: string;
  cwd: string;
}) {
  const [terminals, setTerminals] = useState<IndependentTerminalSession[]>([]);
  const terminalsRef = useRef<IndependentTerminalSession[]>([]);
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [labelsByTerminalId, setLabelsByTerminalId] = useState<Record<string, string>>({});
  const [editingTerminalId, setEditingTerminalId] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState("");
  const activeTerminal = useMemo(
    () => terminals.find((terminal) => terminal.id === activeTerminalId) ?? null,
    [activeTerminalId, terminals],
  );
  const displayCwd = activeTerminal?.cwd ?? props.cwd;
  const displayTitle = useMemo(() => {
    if (activeTerminal && labelsByTerminalId[activeTerminal.id]?.trim()) {
      return labelsByTerminalId[activeTerminal.id]!;
    }
    return terminalTitle(displayCwd);
  }, [activeTerminal, displayCwd, labelsByTerminalId]);

  useEffect(() => {
    terminalsRef.current = terminals;
  }, [terminals]);

  const closeTerminals = useCallback(async (terminalIds: string[]) => {
    await Promise.all(
      terminalIds.map((terminalId) =>
        closeIndependentTerminal(terminalId).catch(() => undefined),
      ),
    );
  }, []);

  const launchTerminal = useCallback(
    async (options?: { replaceTerminalId?: string }) => {
      setError(null);
      setLoading(true);
      try {
        const created = await startIndependentTerminal({ cwd: props.cwd });
        setTerminals((current) => {
          const next = options?.replaceTerminalId
            ? current.map((terminal) =>
                terminal.id === options.replaceTerminalId ? created : terminal,
              )
            : [...current, created];
          return next;
        });
        setActiveTerminalId(created.id);
        if (options?.replaceTerminalId) {
          void closeIndependentTerminal(options.replaceTerminalId).catch(() => undefined);
        }
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : String(nextError));
      } finally {
        setLoading(false);
      }
    },
    [props.cwd],
  );

  useEffect(() => {
    if (!props.open) {
      if (terminalsRef.current.length > 0) {
        void closeTerminals(terminalsRef.current.map((terminal) => terminal.id));
      }
      terminalsRef.current = [];
      setTerminals([]);
      setActiveTerminalId(null);
      setError(null);
      setLabelsByTerminalId({});
      setEditingTerminalId(null);
      setEditingLabel("");
      setLoading(false);
      return;
    }
    if (terminalsRef.current.length === 0) {
      void launchTerminal();
    }
    return () => {
      if (terminalsRef.current.length > 0) {
        void closeTerminals(terminalsRef.current.map((terminal) => terminal.id));
      }
    };
    // Intentionally only keyed by open: changing workspace while terminal is open
    // should not tear down active shells.
  }, [props.open]);

  const closeSingleTerminal = async (terminalId: string) => {
    const target = terminalsRef.current.find((terminal) => terminal.id === terminalId);
    if (typeof window !== "undefined" && target) {
      const confirmed = window.confirm(
        `Close terminal "${labelsByTerminalId[terminalId] || terminalTitle(target.cwd)}"?`,
      );
      if (!confirmed) {
        return;
      }
    }
    await closeIndependentTerminal(terminalId).catch(() => undefined);
    setTerminals((current) => {
      const next = current.filter((terminal) => terminal.id !== terminalId);
      if (next.length === 0) {
        setActiveTerminalId(null);
        props.onOpenChange(false);
      } else if (activeTerminalId === terminalId) {
        setActiveTerminalId(next[Math.max(0, next.length - 1)]?.id ?? null);
      }
      return next;
    });
    setLabelsByTerminalId((current) => {
      if (!(terminalId in current)) {
        return current;
      }
      const next = { ...current };
      delete next[terminalId];
      return next;
    });
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      props.onOpenChange(true);
      return;
    }
    if (terminalsRef.current.length > 0 && typeof window !== "undefined") {
      const confirmed = window.confirm(
        terminalsRef.current.length === 1
          ? "Close this terminal?"
          : `Close all ${terminalsRef.current.length} terminals?`,
      );
      if (!confirmed) {
        return;
      }
    }
    props.onOpenChange(false);
  };

  const beginRename = (terminal: IndependentTerminalSession) => {
    setEditingTerminalId(terminal.id);
    setEditingLabel(labelsByTerminalId[terminal.id] ?? terminalTitle(terminal.cwd));
  };

  const commitRename = () => {
    if (!editingTerminalId) {
      return;
    }
    const trimmed = editingLabel.trim();
    setLabelsByTerminalId((current) => {
      const next = { ...current };
      if (!trimmed) {
        delete next[editingTerminalId];
      } else {
        next[editingTerminalId] = trimmed;
      }
      return next;
    });
    setEditingTerminalId(null);
    setEditingLabel("");
  };

  return (
    <Dialog.Root open={props.open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/45" />
        <Dialog.Content
          data-testid="workbench-terminal-dialog"
          data-terminal-id={activeTerminal?.id ?? ""}
          data-terminal-cwd={activeTerminal?.cwd ?? props.cwd}
          className="fixed inset-0 z-50 flex h-[100dvh] w-screen flex-col overflow-hidden bg-[var(--app-bg)] pb-[env(safe-area-inset-bottom)] focus:outline-none md:left-1/2 md:top-1/2 md:h-[82vh] md:w-[min(1280px,96vw)] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-2xl md:border md:border-[var(--app-border)] md:shadow-2xl"
        >
          <div className="flex items-start justify-between gap-4 border-b border-[var(--app-border)] px-4 py-3 md:px-5 md:py-4">
            <div className="min-w-0">
              <Dialog.Title className="truncate text-base font-semibold text-[var(--app-fg)]">
                {displayTitle}
              </Dialog.Title>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--app-hint)]">
                <Dialog.Description className="truncate">
                  {displayCwd}
                </Dialog.Description>
                {activeTerminal?.shell ? (
                  <span className="rounded-full border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2 py-0.5 text-[10px]">
                    {activeTerminal.shell.split("/").pop()}
                  </span>
                ) : null}
              </div>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                disabled={loading}
                className="inline-flex h-8 items-center justify-center gap-1 rounded-md border border-[var(--app-border)] px-2.5 text-xs text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] disabled:opacity-50"
                aria-label="New terminal"
                title="New terminal"
                onClick={() => {
                  void launchTerminal();
                }}
              >
                <Plus size={14} />
                <span>New</span>
              </button>
              <button
                type="button"
                disabled={loading || !activeTerminal}
                className="inline-flex h-8 items-center justify-center gap-1 rounded-md border border-[var(--app-border)] px-2.5 text-xs text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] disabled:opacity-50"
                aria-label="Restart terminal"
                title="Restart terminal"
                onClick={() => {
                  if (!activeTerminal) {
                    return;
                  }
                  void launchTerminal({ replaceTerminalId: activeTerminal.id });
                }}
              >
                <RotateCcw size={14} />
                <span>Restart</span>
              </button>
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                  aria-label="Close terminal"
                  title="Close terminal"
                >
                  <X size={16} />
                </button>
              </Dialog.Close>
            </div>
          </div>

          <div className="border-b border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-4 py-2 text-[11px] text-[var(--app-hint)] md:px-5">
            Independent shell terminal. This is separate from Codex / Claude sessions.
          </div>

          {terminals.length > 0 ? (
            <div className="flex gap-2 overflow-x-auto border-b border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 md:px-5">
              {terminals.map((terminal) => {
                const active = terminal.id === activeTerminalId;
                const tabLabel = labelsByTerminalId[terminal.id] || terminalTitle(terminal.cwd);
                return (
                  <div
                    key={terminal.id}
                    className={`group flex items-center gap-2 rounded-lg border px-3 py-1.5 text-left transition-colors ${
                      active
                        ? "border-[var(--app-border)] bg-[var(--app-subtle-bg)] text-[var(--app-fg)]"
                        : "border-transparent bg-transparent text-[var(--app-hint)] hover:border-[var(--app-border)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => setActiveTerminalId(terminal.id)}
                      className="flex min-w-0 items-center gap-2"
                    >
                      {editingTerminalId === terminal.id ? (
                        <input
                          value={editingLabel}
                          onChange={(event) => setEditingLabel(event.target.value)}
                          onBlur={commitRename}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              commitRename();
                            }
                            if (event.key === "Escape") {
                              setEditingTerminalId(null);
                              setEditingLabel("");
                            }
                          }}
                          autoFocus
                          className="w-32 rounded bg-transparent text-xs font-medium text-[var(--app-fg)] outline-none"
                        />
                      ) : (
                        <span className="max-w-[9rem] truncate text-xs font-medium">
                          {tabLabel}
                        </span>
                      )}
                      <span className="hidden text-[10px] opacity-70 sm:inline">
                        {terminal.shell.split("/").pop()}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="rounded p-0.5 opacity-70 transition-opacity group-hover:opacity-100"
                      onClick={() => beginRename(terminal)}
                      aria-label={`Rename ${tabLabel} terminal`}
                    >
                      <PencilLine size={12} />
                    </button>
                    <button
                      type="button"
                      className="rounded p-0.5 opacity-70 transition-opacity group-hover:opacity-100"
                      onClick={() => {
                        void closeSingleTerminal(terminal.id);
                      }}
                      aria-label={`Close ${tabLabel} terminal`}
                    >
                      <X size={12} />
                    </button>
                  </div>
                );
              })}
            </div>
          ) : null}

          <div className="min-h-0 flex-1 p-3 md:p-5">
            {loading ? (
              <div className="flex h-full items-center justify-center gap-2 text-sm text-[var(--app-hint)]">
                <LoaderCircle size={16} className="animate-spin" />
                Starting terminal…
              </div>
            ) : error ? (
              <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-danger-bg)] p-3 text-sm text-[var(--app-fg)]">
                Failed to start terminal: {error}
              </div>
            ) : activeTerminal ? (
              <TerminalPane
                key={activeTerminal.id}
                terminalId={activeTerminal.id}
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
