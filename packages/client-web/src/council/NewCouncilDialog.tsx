import { useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ChevronDown, ChevronRight, Plus, Trash2, X } from "lucide-react";
import type { CouncilSnapshot, ProviderModelCatalog } from "@rah/runtime-protocol";
import * as api from "../api";
import { ProviderLogo } from "../components/ProviderLogo";
import { PROVIDER_OPTIONS, type ProviderChoice } from "../components/ProviderSelector";
import { OverlayScrollArea } from "../components/OverlayScrollArea";
import { SessionModelControls } from "../components/SessionModelControls";
import { WorkspacePicker } from "../components/WorkspacePicker";
import { resolveSessionModeControlState } from "../session-mode-ui";
import {
  councilAgentDraftToConfig,
  createDefaultCouncilAgentDrafts,
  normalizeCouncilAgentDraftForCatalog,
  resolveCouncilAgentDraftLabel,
  resolveCouncilAgentModelSelection,
  type CouncilAgentDraft,
} from "./council-ui-state";

const COUNCIL_PROVIDER_OPTIONS = PROVIDER_OPTIONS;
const COUNCIL_MODEL_CATALOG_TTL_MS = 5 * 60 * 1000;

type CouncilDialogOutsideEvent = {
  target: EventTarget | null;
  detail?: { originalEvent?: Event };
  preventDefault: () => void;
};

function isInsideSessionModelPanel(target: EventTarget | null | undefined): boolean {
  return target instanceof Element && Boolean(target.closest('[data-session-model-panel="true"]'));
}

export function keepModelPanelInsideCouncilDialog(event: CouncilDialogOutsideEvent): void {
  const originalEvent = event.detail?.originalEvent;
  const originalPath = typeof originalEvent?.composedPath === "function"
    ? originalEvent.composedPath()
    : [];
  if (
    isInsideSessionModelPanel(event.target) ||
    isInsideSessionModelPanel(originalEvent?.target) ||
    originalPath.some((entry) => isInsideSessionModelPanel(entry))
  ) {
    event.preventDefault();
  }
}

export function catalogKey(provider: ProviderChoice, workspace: string): string {
  return `${provider}:${workspace}`;
}

export function isCouncilCatalogFresh(loadedAt: number | undefined): boolean {
  return loadedAt !== undefined && Date.now() - loadedAt < COUNCIL_MODEL_CATALOG_TTL_MS;
}

export function createAdditionalCouncilAgentDraft(): CouncilAgentDraft {
  return {
    id: `opencode-extra-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    provider: "opencode",
    label: "",
    role: "",
    modelId: null,
    reasoningId: null,
    modeId: null,
  };
}

export function CouncilAgentDraftEditor(props: {
  drafts: CouncilAgentDraft[];
  workspace: string;
  catalogs: Record<string, ProviderModelCatalog>;
  collapsedDraftIds: Set<string>;
  minAgents?: number;
  onUpdateDraft: (id: string, updater: (draft: CouncilAgentDraft) => CouncilAgentDraft) => void;
  onRemoveDraft: (id: string) => void;
  onToggleDraftCollapsed: (id: string) => void;
}) {
  const minAgents = props.minAgents ?? 1;
  return (
    <div className="space-y-2">
      {props.drafts.map((draft, index) => {
        const catalog = props.catalogs[catalogKey(draft.provider, props.workspace)];
        const modeState = resolveSessionModeControlState({
          provider: draft.provider,
          draft: draft.modeId ? { accessModeId: draft.modeId, planEnabled: false } : null,
          catalog: catalog ?? null,
        });
        const selection = resolveCouncilAgentModelSelection({ draft, catalog: catalog ?? null });
        const displayLabel = resolveCouncilAgentDraftLabel({ draft, catalog: catalog ?? null });
        const removable = props.drafts.length > minAgents;
        const collapsed = props.collapsedDraftIds.has(draft.id);
        const titleText = draft.role.trim() ? `${displayLabel} · ${draft.role.trim()}` : displayLabel;
        return (
          <div key={draft.id} className="rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-2.5">
            <div className={`${collapsed ? "" : "mb-2"} flex items-center justify-between gap-2 text-xs font-semibold text-[var(--app-fg)]`}>
              <button
                type="button"
                onClick={() => props.onToggleDraftCollapsed(draft.id)}
                className="icon-click-feedback flex min-w-0 flex-1 items-center gap-1.5 rounded-lg px-1 py-1 text-left transition-colors hover:bg-[var(--app-subtle-bg)]"
                title={titleText}
                aria-expanded={!collapsed}
                aria-label={`${collapsed ? "Expand" : "Collapse"} agent ${index + 1}`}
              >
                <ProviderLogo provider={draft.provider} className="h-4 w-4 shrink-0" variant="bare" />
                <span className="min-w-0 truncate">
                  Agent {index + 1}
                  {collapsed ? ` · ${displayLabel}` : ""}
                </span>
              </button>
              <div className="flex shrink-0 items-center gap-1">
                {removable ? (
                  <button
                    type="button"
                    onClick={() => props.onRemoveDraft(draft.id)}
                    className="icon-click-feedback inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-danger)]"
                    aria-label={`Remove agent ${index + 1}`}
                    title="Remove agent"
                  >
                    <Trash2 size={13} />
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => props.onToggleDraftCollapsed(draft.id)}
                  className="icon-click-feedback inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                  aria-label={`${collapsed ? "Expand" : "Collapse"} agent ${index + 1}`}
                  title={collapsed ? "Expand agent" : "Collapse agent"}
                >
                  {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                </button>
              </div>
            </div>
            {!collapsed ? (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <select
                    value={draft.provider}
                    onChange={(event) => {
                      const provider = event.target.value as CouncilAgentDraft["provider"];
                      props.onUpdateDraft(draft.id, (item) => ({
                        ...item,
                        provider,
                        modelId: null,
                        reasoningId: null,
                        modeId: null,
                      }));
                    }}
                    className="h-8 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2 text-xs text-[var(--app-fg)]"
                  >
                    {COUNCIL_PROVIDER_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                  <select
                    value={draft.modeId ?? modeState.selectedAccessModeId ?? ""}
                    onChange={(event) => props.onUpdateDraft(draft.id, (item) => ({
                      ...item,
                      modeId: event.target.value || null,
                    }))}
                    className="h-8 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2 text-xs text-[var(--app-fg)]"
                  >
                    {modeState.accessModes.map((mode) => (
                      <option key={mode.id} value={mode.id}>{mode.label}</option>
                    ))}
                  </select>
                </div>
                <div className="mt-2 grid grid-cols-[minmax(0,3fr)_minmax(0,7fr)] gap-2">
                  <input
                    value={draft.label}
                    onChange={(event) => props.onUpdateDraft(draft.id, (item) => ({
                      ...item,
                      label: event.target.value,
                    }))}
                    className="h-8 min-w-0 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2 text-xs text-[var(--app-fg)]"
                    placeholder={displayLabel}
                  />
                  <input
                    value={draft.role}
                    onChange={(event) => props.onUpdateDraft(draft.id, (item) => ({
                      ...item,
                      role: event.target.value,
                    }))}
                    className="h-8 min-w-0 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2 text-xs text-[var(--app-fg)]"
                    placeholder="Agent role"
                  />
                </div>
                <div className="mt-2">
                  <SessionModelControls
                    catalog={catalog ?? null}
                    selectedModelId={selection.modelId}
                    selectedReasoningId={selection.reasoningId}
                    loading={!catalog && Boolean(props.workspace)}
                    compact
                    onModelChange={(modelId, defaultReasoningId) => {
                      props.onUpdateDraft(draft.id, (item) => ({
                        ...item,
                        modelId,
                        reasoningId: defaultReasoningId ?? null,
                      }));
                    }}
                    onReasoningChange={(reasoningId) => {
                      props.onUpdateDraft(draft.id, (item) => ({
                        ...item,
                        reasoningId,
                      }));
                    }}
                  />
                </div>
              </>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function NewCouncilDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceDir: string;
  workspaceDirs: string[];
  councils: readonly CouncilSnapshot[];
  onAddWorkspace: (dir: string) => void;
  onCreated: (council: CouncilSnapshot) => void | Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [workspace, setWorkspace] = useState(props.workspaceDir || "");
  const [agentDrafts, setAgentDrafts] = useState<CouncilAgentDraft[]>(() =>
    createDefaultCouncilAgentDrafts(),
  );
  const [collapsedAgentDraftIds, setCollapsedAgentDraftIds] = useState<Set<string>>(new Set());
  const [catalogs, setCatalogs] = useState<Record<string, ProviderModelCatalog>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const catalogLoadedAtRef = useRef<Record<string, number>>({});
  const catalogRequestsRef = useRef<Set<string>>(new Set());
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const wasOpenRef = useRef(false);

  const nextCouncilTitle = useMemo(() => {
    let maxCouncilNumber = 0;
    for (const council of props.councils) {
      const match = /^(?:Council|Council)-(\d+)$/.exec(council.title.trim());
      if (!match) continue;
      maxCouncilNumber = Math.max(maxCouncilNumber, Number.parseInt(match[1]!, 10));
    }
    return `Council-${String(maxCouncilNumber + 1).padStart(4, "0")}`;
  }, [props.councils]);

  useEffect(() => {
    if (props.open && !wasOpenRef.current) {
      setWorkspace(props.workspaceDir || "");
      setError(null);
    }
    wasOpenRef.current = props.open;
  }, [props.open, props.workspaceDir]);

  useEffect(() => {
    if (!props.open) {
      return;
    }
    const requestedKeys = new Set<string>();
    const cwd = workspace.trim();
    for (const draft of agentDrafts) {
      const key = catalogKey(draft.provider, cwd);
      if (
        requestedKeys.has(key) ||
        catalogRequestsRef.current.has(key) ||
        isCouncilCatalogFresh(catalogLoadedAtRef.current[key])
      ) {
        continue;
      }
      requestedKeys.add(key);
      catalogRequestsRef.current.add(key);
      void api.listProviderModels(draft.provider, cwd ? { cwd } : {})
        .then((catalog) => {
          catalogLoadedAtRef.current[key] = Date.now();
          setCatalogs((current) => ({ ...current, [key]: catalog }));
        })
        .catch(() => {
          catalogLoadedAtRef.current[key] = Date.now();
        })
        .finally(() => {
          catalogRequestsRef.current.delete(key);
        });
    }
  }, [agentDrafts, catalogs, props.open, workspace]);

  useEffect(() => {
    setAgentDrafts((current) => {
      let changed = false;
      const next = current.map((draft) => {
        const catalog = catalogs[catalogKey(draft.provider, workspace)];
        if (!catalog) {
          return draft;
        }
        const normalized = normalizeCouncilAgentDraftForCatalog({ draft, catalog });
        if (normalized !== draft) {
          changed = true;
        }
        return normalized;
      });
      return changed ? next : current;
    });
  }, [catalogs, workspace]);

  const updateDraft = (id: string, updater: (draft: CouncilAgentDraft) => CouncilAgentDraft) => {
    setAgentDrafts((current) => current.map((draft) => draft.id === id ? updater(draft) : draft));
  };

  const removeDraft = (id: string) => {
    setAgentDrafts((current) => current.filter((draft) => draft.id !== id));
    setCollapsedAgentDraftIds((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  };

  const toggleDraftCollapsed = (id: string) => {
    setCollapsedAgentDraftIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const addNewCouncilAgentDraft = () => {
    const draft = createAdditionalCouncilAgentDraft();
    setAgentDrafts((current) => [...current, draft]);
    setCollapsedAgentDraftIds((current) => {
      const next = new Set(current);
      next.delete(draft.id);
      return next;
    });
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const node = bodyRef.current;
        node?.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
      });
    });
  };

  const selectWorkspace = (dir: string) => {
    const nextWorkspace = dir.trim();
    setWorkspace(nextWorkspace);
    if (nextWorkspace && !props.workspaceDirs.includes(nextWorkspace)) {
      props.onAddWorkspace(nextWorkspace);
    }
  };

  const resetDrafts = () => {
    setTitle("");
    setAgentDrafts(createDefaultCouncilAgentDrafts());
    setCollapsedAgentDraftIds(new Set());
  };

  const startCouncil = async () => {
    const cwd = workspace.trim();
    if (!cwd || loading) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await api.createCouncil({
        ...(title.trim() ? { title: title.trim() } : {}),
        workspace: cwd,
        agents: agentDrafts.map((draft) =>
          councilAgentDraftToConfig({
            draft,
            catalog: catalogs[catalogKey(draft.provider, cwd)] ?? null,
          }),
        ),
      });
      await props.onCreated(response.council);
      resetDrafts();
      props.onOpenChange(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange} modal={false}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/35" />
        <Dialog.Content
          className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-[var(--app-bg)] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] focus:outline-none min-[900px]:inset-auto min-[900px]:left-1/2 min-[900px]:top-[calc(50%-10px)] min-[900px]:max-h-[min(calc(100dvh-24px),972px)] min-[900px]:w-[min(720px,94vw)] min-[900px]:-translate-x-1/2 min-[900px]:-translate-y-1/2 min-[900px]:rounded-2xl min-[900px]:border min-[900px]:border-[var(--app-border)] min-[900px]:pt-0 min-[900px]:pb-0 min-[900px]:shadow-2xl"
          onPointerDownOutside={keepModelPanelInsideCouncilDialog}
          onInteractOutside={keepModelPanelInsideCouncilDialog}
        >
          <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-[var(--app-border)] px-4">
            <div className="min-w-0">
              <Dialog.Title className="text-sm font-semibold text-[var(--app-fg)]">
                New Council
              </Dialog.Title>
              <div className="truncate text-xs text-[var(--app-hint)]">
                Configure agents before starting the Council.
              </div>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                className="icon-click-feedback inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                aria-label="Close new Council"
                title="Close"
              >
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>
          {error ? (
            <div className="mx-4 mt-3 rounded-lg border border-[var(--app-danger)]/30 bg-[var(--app-danger)]/10 px-3 py-2 text-xs text-[var(--app-danger)]">
              {error}
            </div>
          ) : null}
          <OverlayScrollArea
            className="min-h-0 flex-1 min-[900px]:flex-none"
            viewportClassName="h-full px-4 pt-4 pb-2 min-[900px]:h-auto min-[900px]:max-h-[calc(min(calc(100dvh-24px),972px)-8.25rem)]"
            contentClassName="space-y-3"
            viewportRef={bodyRef}
            scrollAriaLabel="New Council settings"
          >
            <label className="block text-xs font-medium text-[var(--app-hint)]">
              Title
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                className="mt-1 h-11 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 text-sm text-[var(--app-fg)]"
                placeholder={nextCouncilTitle}
              />
            </label>
            <div className="block text-xs font-medium text-[var(--app-hint)]">
              Workspace
              <WorkspacePicker
                currentDir={workspace}
                triggerClassName="mt-1 h-11 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 text-left text-xs text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)]"
                onSelect={selectWorkspace}
              />
            </div>
            <div className="text-xs font-medium text-[var(--app-hint)]">Agents</div>
            <CouncilAgentDraftEditor
              drafts={agentDrafts}
              workspace={workspace}
              catalogs={catalogs}
              collapsedDraftIds={collapsedAgentDraftIds}
              onUpdateDraft={updateDraft}
              onRemoveDraft={removeDraft}
              onToggleDraftCollapsed={toggleDraftCollapsed}
            />
          </OverlayScrollArea>
          <div className="grid shrink-0 grid-cols-3 gap-2 px-4 pt-2 pb-4">
            <Dialog.Close asChild>
              <button
                type="button"
                className="icon-click-feedback inline-flex h-11 min-w-0 items-center justify-center rounded-lg border border-[var(--app-border)] text-xs font-semibold text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]"
              >
                Cancel
              </button>
            </Dialog.Close>
            <button
              type="button"
              onClick={addNewCouncilAgentDraft}
              className="icon-click-feedback inline-flex h-11 min-w-0 items-center justify-center gap-2 rounded-lg border border-[var(--app-border)] text-xs font-semibold text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]"
            >
              <Plus size={14} />
              Add agent
            </button>
            <button
              type="button"
              disabled={loading || !workspace.trim()}
              onClick={() => void startCouncil()}
              className="icon-click-feedback inline-flex h-11 min-w-0 items-center justify-center gap-2 rounded-lg bg-[var(--app-fg)] px-3 text-xs font-semibold text-[var(--app-bg)] disabled:opacity-40"
            >
              Start
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
