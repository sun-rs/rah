import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle, PencilLine, Plus, X } from "lucide-react";
import type { IndependentTerminalSession } from "@rah/runtime-protocol";
import {
  closeIndependentTerminal,
  listIndependentTerminals,
  startIndependentTerminal,
} from "../../../api";
import {
  TerminalDialogFrame,
  TerminalPaneStack,
  TerminalTabStrip,
  type TerminalTabDescriptor,
} from "../../terminal/TerminalSurface";
import { ConfirmDialog } from "./ConfirmDialog";

function terminalTitle(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  return parts.at(-1) || cwd || "Terminal";
}

export function WorkbenchTerminalDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clientId: string;
  cwd: string;
  owner?: IndependentTerminalSession["owner"];
}) {
  const [closeIntent, setCloseIntent] = useState<
    | { terminalId: string; label: string }
    | null
  >(null);
  const [terminals, setTerminals] = useState<IndependentTerminalSession[]>([]);
  const terminalsRef = useRef<IndependentTerminalSession[]>([]);
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null);
  const [visitedTerminalIds, setVisitedTerminalIds] = useState<Set<string>>(new Set());
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
  const workspaceTitle = useMemo(() => terminalTitle(displayCwd), [displayCwd]);

  useEffect(() => {
    terminalsRef.current = terminals;
  }, [terminals]);

  const launchTerminal = useCallback(
    async () => {
      setError(null);
      setLoading(true);
      try {
        const created = await startIndependentTerminal({
          cwd: props.cwd,
          ...(props.owner ? { owner: props.owner } : {}),
        });
        setTerminals((current) => [
          ...current.filter((terminal) => terminal.id !== created.id),
          created,
        ]);
        setActiveTerminalId(created.id);
        setVisitedTerminalIds((current) => {
          const next = new Set(current);
          next.add(created.id);
          return next;
        });
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : String(nextError));
      } finally {
        setLoading(false);
      }
    },
    [props.cwd, props.owner],
  );

  useEffect(() => {
    if (!props.open) {
      setError(null);
      setEditingTerminalId(null);
      setEditingLabel("");
      setCloseIntent(null);
      setVisitedTerminalIds(new Set());
      setLoading(false);
      return;
    }

    let cancelled = false;
    const restoreOrLaunchTerminal = async () => {
      setError(null);
      setLoading(true);
      try {
        const existing = await listIndependentTerminals({
          cwd: props.cwd,
          ...(props.owner ? { owner: props.owner } : {}),
        });
        if (cancelled) {
          return;
        }
        if (existing.length > 0) {
          const existingTerminalIds = new Set(existing.map((terminal) => terminal.id));
          const nextActiveTerminalId =
            activeTerminalId && existingTerminalIds.has(activeTerminalId)
              ? activeTerminalId
              : existing[0]?.id ?? null;
          setTerminals(existing);
          setActiveTerminalId(nextActiveTerminalId);
          setVisitedTerminalIds((current) => {
            if (!nextActiveTerminalId || current.has(nextActiveTerminalId)) {
              return current;
            }
            const next = new Set(current);
            next.add(nextActiveTerminalId);
            return next;
          });
          return;
        }
        const created = await startIndependentTerminal({
          cwd: props.cwd,
          ...(props.owner ? { owner: props.owner } : {}),
        });
        if (cancelled) {
          return;
        }
        setTerminals([created]);
        setActiveTerminalId(created.id);
        setVisitedTerminalIds((current) => {
          const next = new Set(current);
          next.add(created.id);
          return next;
        });
      } catch (nextError) {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : String(nextError));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void restoreOrLaunchTerminal();
    return () => {
      cancelled = true;
    };
  }, [props.open, props.cwd, props.owner]);

  useEffect(() => {
    if (!activeTerminalId || !terminals.some((terminal) => terminal.id === activeTerminalId)) {
      return;
    }
    setVisitedTerminalIds((current) => {
      if (current.has(activeTerminalId)) {
        return current;
      }
      const next = new Set(current);
      next.add(activeTerminalId);
      return next;
    });
  }, [activeTerminalId, terminals]);

  const closeSingleTerminal = async (terminalId: string) => {
    await closeIndependentTerminal(terminalId).catch(() => undefined);
    setTerminals((current) => {
      const next = current.filter((terminal) => terminal.id !== terminalId);
      if (next.length === 0) {
        setActiveTerminalId(null);
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
    setVisitedTerminalIds((current) => {
      if (!current.has(terminalId)) {
        return current;
      }
      const next = new Set(current);
      next.delete(terminalId);
      return next;
    });
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      props.onOpenChange(true);
      return;
    }
    props.onOpenChange(false);
  };

  const requestCloseSingleTerminal = (terminalId: string) => {
    const target = terminalsRef.current.find((terminal) => terminal.id === terminalId);
    if (!target) {
      return;
    }
    setCloseIntent({
      terminalId,
      label: labelsByTerminalId[terminalId] || terminalTitle(target.cwd),
    });
  };

  const handleConfirmClose = () => {
    if (!closeIntent) {
      return;
    }
    void closeSingleTerminal(closeIntent.terminalId).finally(() => {
      setCloseIntent(null);
    });
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

  const terminalTabs = useMemo<TerminalTabDescriptor[]>(
    () =>
      terminals.map((terminal) => {
        const tabLabel = labelsByTerminalId[terminal.id] || terminalTitle(terminal.cwd);
        return {
          id: terminal.id,
          title: tabLabel,
          editing: editingTerminalId === terminal.id,
          label:
            editingTerminalId === terminal.id ? (
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
              <span className="max-w-[10rem] truncate text-[11px] font-medium">
                {tabLabel}
              </span>
            ),
          controls: (
            <>
              <button
                type="button"
                className="rounded p-0.5 opacity-70 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 coarse-pointer-action-visible"
                onClick={() => beginRename(terminal)}
                aria-label={`Rename ${tabLabel} terminal`}
              >
                <PencilLine size={12} />
              </button>
              <button
                type="button"
                className="rounded p-0.5 opacity-70 transition-opacity hover:bg-[var(--app-danger-bg)] hover:text-[var(--app-danger)] group-hover:opacity-100 group-focus-within:opacity-100 coarse-pointer-action-visible"
                onClick={() => requestCloseSingleTerminal(terminal.id)}
                aria-label={`Terminate ${tabLabel} terminal`}
                title={`Terminate ${tabLabel} terminal`}
              >
                <X size={12} />
              </button>
            </>
          ),
        };
      }),
    [editingLabel, editingTerminalId, labelsByTerminalId, terminals],
  );
  const terminalPaneTabs = useMemo(
    () =>
      terminals
        .filter((terminal) => visitedTerminalIds.has(terminal.id))
        .map((terminal) => ({
          id: terminal.id,
          terminalId: terminal.id,
          label: labelsByTerminalId[terminal.id] || terminalTitle(terminal.cwd),
        })),
    [labelsByTerminalId, terminals, visitedTerminalIds],
  );

  return (
    <>
      <TerminalDialogFrame
        open={props.open}
        onOpenChange={handleOpenChange}
        title={workspaceTitle}
        contentTestId="workbench-terminal-dialog"
        dataTerminalId={activeTerminal?.id ?? ""}
        dataTerminalCwd={activeTerminal?.cwd ?? props.cwd}
        closeLabel="Hide terminal window"
        closeTitle="Hide terminal window without stopping background terminals"
        closeText="Hide"
      >
        <TerminalTabStrip
          tabs={terminalTabs}
          activeTabId={activeTerminalId}
          onTabSelect={(terminalId) => {
            setVisitedTerminalIds((current) => {
              if (current.has(terminalId)) {
                return current;
              }
              const next = new Set(current);
              next.add(terminalId);
              return next;
            });
            setActiveTerminalId(terminalId);
          }}
          endAdornment={
                <button
                  type="button"
                  disabled={loading}
                  className="icon-click-feedback inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-[var(--app-border)] text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] disabled:opacity-50"
                  aria-label="New terminal"
                  title="New terminal"
                  onClick={() => {
                    void launchTerminal();
                  }}
                >
                  <Plus size={14} />
                </button>
          }
        />

        {loading && terminals.length === 0 ? (
          <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-[var(--app-hint)]">
            <LoaderCircle size={16} className="animate-spin" />
            Starting terminal…
          </div>
        ) : error && terminals.length === 0 ? (
          <div className="min-h-0 flex-1 px-3 pb-3 pt-0 md:px-5 md:pb-5 md:pt-0">
            <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-danger-bg)] p-3 text-sm text-[var(--app-fg)]">
              Failed to start terminal: {error}
            </div>
          </div>
        ) : (
          <TerminalPaneStack
            tabs={terminalPaneTabs}
            activeTabId={activeTerminalId}
            clientId={props.clientId}
            emptyState={
              <div className="flex h-full flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-[var(--app-border)] text-center text-sm text-[var(--app-hint)]">
                <div>No active terminal tab.</div>
                <button
                  type="button"
                  disabled={loading}
                  className="icon-click-feedback inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-[var(--app-border)] px-3 text-xs font-semibold text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)] disabled:opacity-50"
                  onClick={() => {
                    void launchTerminal();
                  }}
                >
                  <Plus size={14} />
                  New terminal
                </button>
              </div>
            }
            terminalProps={(terminal, active) => ({
              hasControl: active,
              claimSurface: active,
              autoFocus: active,
              renderOutput: active,
              nativeSurfaceControl: false,
              replayTailBytes: 512 * 1024,
              maxWriteBatchChars: 128 * 1024,
              scrollback: 600,
              closeLabel: `Terminate ${terminal.label} terminal`,
              closeTitle: `Terminate ${terminal.label} terminal process`,
              onClose: () => requestCloseSingleTerminal(terminal.id),
            })}
          />
        )}
        {error && terminals.length > 0 ? (
          <div className="pointer-events-none absolute right-3 top-[6.25rem] max-w-[min(28rem,calc(100%-1.5rem))] rounded-lg border border-[var(--app-border)] bg-[var(--app-danger-bg)] px-3 py-2 text-xs text-[var(--app-fg)] shadow-lg">
            Failed to start terminal: {error}
          </div>
        ) : null}
      </TerminalDialogFrame>
      <ConfirmDialog
        open={closeIntent !== null}
        title="Terminate terminal?"
        description={
          `Terminate terminal "${closeIntent?.label ?? "terminal"}"? This stops the background process for this tab.`
        }
        confirmLabel="Terminate"
        confirmTone="danger"
        onOpenChange={(open) => {
          if (!open) {
            setCloseIntent(null);
          }
        }}
        onConfirm={handleConfirmClose}
      />
    </>
  );
}
