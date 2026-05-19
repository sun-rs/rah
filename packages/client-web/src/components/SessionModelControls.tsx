import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, ChevronLeft, Cpu, LoaderCircle } from "lucide-react";
import type {
  ProviderModelCatalog,
  SessionModelDescriptor,
  SessionReasoningOption,
} from "@rah/runtime-protocol";
import { OverlayScrollArea } from "./OverlayScrollArea";

function selectedModel(
  catalog: ProviderModelCatalog | null | undefined,
  selectedModelId: string | null | undefined,
): SessionModelDescriptor | null {
  const models = catalog?.models ?? [];
  if (models.length === 0) {
    return null;
  }
  const normalizedSelectedModelId = selectedModelId?.trim() || null;
  return (
    (normalizedSelectedModelId
      ? models.find((model) => model.id === normalizedSelectedModelId)
      : null) ??
    models[0] ??
    null
  );
}

function selectedReasoning(
  model: SessionModelDescriptor | null,
  selectedReasoningId: string | null | undefined,
): SessionReasoningOption | null {
  const options = model?.reasoningOptions ?? [];
  if (options.length === 0) {
    return null;
  }
  return (
    options.find((option) => option.id === selectedReasoningId) ??
    options.at(-1) ??
    null
  );
}

function defaultReasoningIdForModel(
  model: SessionModelDescriptor | undefined,
): string | null {
  if (!model) {
    return null;
  }
  const options = model.reasoningOptions ?? [];
  if (options.length === 0) {
    return null;
  }
  return options.at(-1)?.id ?? null;
}

function joinClassNames(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export function isManualSupplementModel(
  catalog: ProviderModelCatalog | null | undefined,
  modelId: string,
): boolean {
  return catalog?.modelProfiles?.some(
    (profile) => profile.modelId === modelId && profile.source === "cached_runtime",
  ) === true;
}

export function ModelSourceBadge(props: { manual: boolean }) {
  if (!props.manual) {
    return null;
  }
  return (
    <span className="shrink-0 rounded-full border border-cyan-500/25 bg-cyan-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-cyan-700 dark:text-cyan-300">
      Manual
    </span>
  );
}

export function resolveSelectedModelDraft(args: {
  catalog: ProviderModelCatalog | null | undefined;
  selectedModelId?: string | null | undefined;
  selectedReasoningId?: string | null | undefined;
  allowProviderDefault?: boolean | undefined;
}): {
  model: SessionModelDescriptor | null;
  reasoning: SessionReasoningOption | null;
} {
  if (
    args.allowProviderDefault &&
    !args.selectedModelId &&
    (args.catalog?.models.length ?? 0) === 0
  ) {
    return { model: null, reasoning: null };
  }
  const model = selectedModel(args.catalog, args.selectedModelId);
  return {
    model,
    reasoning: selectedReasoning(model, args.selectedReasoningId),
  };
}

export function ModelCatalogList(props: {
  catalog: ProviderModelCatalog | null | undefined;
  selectedModelId?: string | null;
  loading?: boolean;
  readOnly?: boolean;
  showModelIds?: boolean;
  emptyLabel?: string;
  onModelSelect?: (modelId: string) => void;
}) {
  const models = props.catalog?.models ?? [];
  const selectedModelId = props.selectedModelId?.trim() || null;
  const interactive = !props.readOnly && props.onModelSelect !== undefined;
  const optionClass = (isSelected: boolean) =>
    joinClassNames(
      "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors",
      isSelected
        ? "bg-[var(--app-subtle-bg)] text-[var(--app-fg)] font-medium"
        : "text-[var(--app-fg)]",
      interactive ? "hover:bg-[var(--app-subtle-bg)]/60" : undefined,
    );

  if (models.length === 0) {
    return (
      <div className="px-2.5 py-2 text-sm text-[var(--app-hint)]">
        {props.loading ? (
          <span className="inline-flex items-center gap-2">
            <LoaderCircle size={13} className="animate-spin" />
            Loading...
          </span>
        ) : (
          props.emptyLabel ?? "No models"
        )}
      </div>
    );
  }

  return (
    <>
      {models.map((model) => {
        const isSelected = model.id === selectedModelId;
        const manual = isManualSupplementModel(props.catalog, model.id);
        const optionCount = model.reasoningOptions?.length ?? 0;
        const label = (
          <>
            <span className="min-w-0 flex-1">
              <span className="block truncate">{model.label}</span>
              {props.showModelIds && model.id !== model.label ? (
                <span className="mt-0.5 block truncate font-mono text-[11px] text-[var(--app-hint)]">
                  {model.id}
                </span>
              ) : null}
            </span>
            <ModelSourceBadge manual={manual} />
            {isSelected ? (
              <Check size={14} className="shrink-0 text-[var(--app-success)]" />
            ) : null}
            {optionCount > 1 ? (
              <span className="shrink-0 text-[11px] text-[var(--app-hint)]">
                {optionCount} params
              </span>
            ) : null}
          </>
        );

        if (interactive) {
          return (
            <button
              key={model.id}
              type="button"
              onClick={() => props.onModelSelect?.(model.id)}
              className={optionClass(isSelected)}
            >
              {label}
            </button>
          );
        }

        return (
          <div key={model.id} className={optionClass(isSelected)} role="listitem">
            {label}
          </div>
        );
      })}
    </>
  );
}

export function SessionModelControls(props: {
  catalog: ProviderModelCatalog | null | undefined;
  selectedModelId?: string | null;
  selectedReasoningId?: string | null;
  loading?: boolean;
  disabled?: boolean;
  compact?: boolean;
  iconOnly?: boolean;
  mobileIconOnly?: boolean;
  allowProviderDefault?: boolean;
  onOpen?: (() => void) | undefined;
  onModelChange: (modelId: string, defaultReasoningId?: string | null) => void;
  onReasoningChange: (reasoningId: string) => void;
}) {
  const { model, reasoning } = resolveSelectedModelDraft({
    catalog: props.catalog,
    selectedModelId: props.selectedModelId,
    selectedReasoningId: props.selectedReasoningId,
    allowProviderDefault: props.allowProviderDefault,
  });
  const models = props.catalog?.models ?? [];
  const reasoningOptions = model?.reasoningOptions ?? [];

  const [open, setOpen] = useState(false);
  const [panelView, setPanelView] = useState<"model-list" | "param-list">("model-list");
  const [draftModelId, setDraftModelId] = useState<string | null>(null);
  const [draftReasoningId, setDraftReasoningId] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const modelViewRef = useRef<HTMLDivElement>(null);
  const paramViewRef = useRef<HTMLDivElement>(null);
  const modelListRef = useRef<HTMLDivElement>(null);
  const paramListRef = useRef<HTMLDivElement>(null);
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({});
  const panelModel =
    panelView === "param-list"
      ? selectedModel(props.catalog, draftModelId ?? model?.id ?? null)
      : model;
  const panelReasoningOptions = panelModel?.reasoningOptions ?? [];
  const panelReasoning = selectedReasoning(panelModel, draftReasoningId ?? reasoning?.id ?? null);
  const visibleOptionCount =
    panelView === "param-list"
      ? Math.max(panelReasoningOptions.length, 1)
      : Math.max(models.length, props.loading ? 1 : 0);

  /* Reset to model-list when panel closes */
  useEffect(() => {
    if (!open) {
      setPanelView("model-list");
      setDraftModelId(null);
      setDraftReasoningId(null);
    }
  }, [open]);

  /* Keep the popover on-screen. Bottom composer triggers should open upward. */
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const pad = 8;
    const gap = 6;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const width = Math.min(Math.max(rect.width, 280), viewportWidth - pad * 2);
    const left = Math.max(pad, Math.min(rect.left, viewportWidth - width - pad));
    const spaceBelow = viewportHeight - rect.bottom - pad - gap;
    const spaceAbove = rect.top - pad - gap;
    const openBelow = spaceBelow >= 260 || spaceBelow >= spaceAbove;
    const availableHeight = Math.max(96, openBelow ? spaceBelow : spaceAbove);
    const activeView = panelView === "param-list" ? paramViewRef.current : modelViewRef.current;
    const activeList = panelView === "param-list" ? paramListRef.current : modelListRef.current;
    const header = activeView?.firstElementChild as HTMLElement | null | undefined;
    const listStyle = activeList ? window.getComputedStyle(activeList) : null;
    const listPadding =
      (listStyle ? Number.parseFloat(listStyle.paddingTop) : 0) +
      (listStyle ? Number.parseFloat(listStyle.paddingBottom) : 0);
    const listRowsHeight = activeList
      ? Array.from(activeList.children).reduce(
          (total, child) => total + (child as HTMLElement).getBoundingClientRect().height,
          0,
        )
      : 0;
    const measuredHeight =
      header && activeList
        ? Math.ceil(header.getBoundingClientRect().height + listPadding + listRowsHeight)
        : 0;
    const fallbackHeight = 38 + Math.min(visibleOptionCount, 9) * 36 + 12;
    const desiredHeight = Math.max(72, measuredHeight || fallbackHeight);
    const height = Math.min(420, availableHeight, desiredHeight);

    setPanelStyle({
      ...(openBelow
        ? { top: rect.bottom + gap }
        : { bottom: viewportHeight - rect.top + gap }),
      left,
      width,
      height,
    });
  }, [open, panelView, visibleOptionCount, props.compact, props.iconOnly, props.mobileIconOnly]);

  /* ── Close on outside click / Escape ── */
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node;
      if (
        !triggerRef.current?.contains(t) &&
        !panelRef.current?.contains(t)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const handleModelSelect = (modelId: string) => {
    const nextModel = models.find((m) => m.id === modelId);
    const nextReasoningOptions = nextModel?.reasoningOptions ?? [];
    const defaultReasoningId = defaultReasoningIdForModel(nextModel);

    if (nextReasoningOptions.length > 1) {
      setDraftModelId(modelId);
      setDraftReasoningId(defaultReasoningId);
      setPanelView("param-list");
    } else {
      props.onModelChange(modelId, defaultReasoningId);
      /* 0 or 1 option — nothing further to choose */
      setOpen(false);
    }
  };

  const handleReasoningSelect = (reasoningId: string) => {
    if (draftModelId && draftModelId !== model?.id) {
      props.onModelChange(draftModelId, reasoningId);
    } else {
      props.onReasoningChange(reasoningId);
    }
    setOpen(false);
  };

  if (models.length === 0 && !props.loading) {
    return null;
  }

  const labelParts: string[] = [];
  if (props.loading && models.length === 0) {
    labelParts.push("Loading…");
  } else {
    labelParts.push(model?.label ?? "Model");
    if (reasoningOptions.length > 1 && reasoning) {
      labelParts.push(reasoning.label);
    }
  }
  const label = labelParts.join(" / ");

  const pillBase =
    "inline-flex items-center gap-1.5 rounded-full border border-[var(--app-border)] bg-[var(--app-bg)] text-[11px] text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)]";
  const triggerClass = props.iconOnly
    ? `${pillBase} icon-click-feedback h-8 w-8 shrink-0 justify-center p-0`
    : props.compact
      ? `${pillBase} h-9 w-full justify-start px-2.5`
      : props.mobileIconOnly
        ? `${pillBase} icon-click-feedback h-10 w-10 shrink-0 justify-center p-0 min-[700px]:h-9 min-[700px]:w-auto min-[700px]:justify-start min-[700px]:px-3 lg:h-8`
        : `${pillBase} h-8 md:h-9 px-2.5 md:px-3`;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={props.disabled || props.loading}
        onClick={() =>
          setOpen((current) => {
            if (!current) {
              props.onOpen?.();
            }
            return !current;
          })
        }
        className={triggerClass}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={label}
      >
        {props.loading && models.length === 0 ? (
          <LoaderCircle size={12} className="animate-spin text-[var(--app-hint)]" />
        ) : (
          <Cpu size={12} className="shrink-0 text-[var(--app-hint)]" />
        )}
        {props.iconOnly ? null : (
          <span
            className={`min-w-0 truncate ${
              props.mobileIconOnly ? "hidden min-[700px]:inline" : ""
            }`}
          >
            {label}
          </span>
        )}
        {props.iconOnly ? null : (
          <ChevronDown
            size={12}
            className={`shrink-0 text-[var(--app-hint)] transition-transform ${
              open ? "rotate-180" : ""
            } ${props.mobileIconOnly ? "hidden min-[700px]:block" : ""}`}
          />
        )}
      </button>

      {open &&
        createPortal(
          <div
            ref={panelRef}
            data-session-model-panel="true"
            className="rah-popover-panel pointer-events-auto fixed z-[100] overflow-hidden rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] shadow-2xl focus:outline-none"
            style={panelStyle}
            role="dialog"
            aria-label="Model and parameters"
          >
            <div className="relative h-full overflow-hidden">
              <div
                className="flex h-full w-[200%] transition-transform duration-200 ease-out"
                style={{
                  transform:
                    panelView === "param-list" ? "translateX(-50%)" : "translateX(0)",
                }}
              >
                {/* ── View 1: Model list ── */}
                <div ref={modelViewRef} className="w-1/2 h-full flex flex-col">
                  <div className="shrink-0 border-b border-[var(--app-border)] px-3 py-2.5">
                    <div className="text-xs font-semibold text-[var(--app-fg)]">
                      Select model
                    </div>
                  </div>
                  <OverlayScrollArea
                    className="min-h-0 flex-1"
                    viewportClassName="h-full"
                    contentClassName="p-1.5"
                    contentRef={modelListRef}
                    scrollAriaLabel="Model list"
                  >
                    <ModelCatalogList
                      catalog={props.catalog}
                      selectedModelId={model?.id ?? null}
                      loading={Boolean(props.loading)}
                      onModelSelect={handleModelSelect}
                    />
                  </OverlayScrollArea>
                </div>

                {/* ── View 2: Parameter list ── */}
                <div ref={paramViewRef} className="w-1/2 h-full flex flex-col">
                  <div className="shrink-0 border-b border-[var(--app-border)] px-3 py-2.5 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setPanelView("model-list")}
                      className="inline-flex h-7 w-7 items-center justify-center rounded-full text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] transition-colors"
                      title="Back to models"
                    >
                      <ChevronLeft size={16} />
                    </button>
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-[var(--app-fg)] truncate">
                        {panelModel?.label}
                      </div>
                      <div className="text-[11px] text-[var(--app-hint)]">
                        Select parameter
                      </div>
                    </div>
                  </div>
                  <OverlayScrollArea
                    className="min-h-0 flex-1"
                    viewportClassName="h-full"
                    contentClassName="p-1.5"
                    contentRef={paramListRef}
                    scrollAriaLabel="Model parameter list"
                  >
                    {panelReasoningOptions.length > 1 ? (
                      panelReasoningOptions.map((r) => (
                        <button
                          key={r.id}
                          type="button"
                          onClick={() => handleReasoningSelect(r.id)}
                          className={joinClassNames(
                            "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors",
                            r.id === panelReasoning?.id
                              ? "bg-[var(--app-subtle-bg)] text-[var(--app-fg)] font-medium"
                              : "text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]/60",
                          )}
                        >
                          <span className="flex-1 truncate">{r.label}</span>
                          {r.id === panelReasoning?.id && (
                            <Check size={14} className="shrink-0 text-[var(--app-success)]" />
                          )}
                        </button>
                      ))
                    ) : panelReasoningOptions.length === 1 ? (
                      <div className="px-2.5 py-2 text-sm text-[var(--app-hint)]">
                        {panelReasoningOptions[0]?.label}
                      </div>
                    ) : (
                      <div className="px-2.5 py-2 text-sm text-[var(--app-hint)]">
                        No parameters for this model
                      </div>
                    )}
                  </OverlayScrollArea>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
