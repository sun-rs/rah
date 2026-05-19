import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, ChevronLeft, Cpu, LoaderCircle, Trash2 } from "lucide-react";
import type {
  ProviderModelCatalog,
  SessionModelDescriptor,
  SessionReasoningOption,
} from "@rah/runtime-protocol";
import { OverlayScrollArea } from "./OverlayScrollArea";

function selectedModel(
  catalog: ProviderModelCatalog | null | undefined,
  selectedModelId: string | null | undefined,
  preserveMissingSelectedModel = true,
): SessionModelDescriptor | null {
  const models = catalog?.models ?? [];
  const normalizedSelectedModelId = selectedModelId?.trim() || null;
  if (normalizedSelectedModelId) {
    return (
      models.find((model) => model.id === normalizedSelectedModelId) ??
      (preserveMissingSelectedModel ? { id: normalizedSelectedModelId } : models[0] ?? null)
    );
  }
  if (models.length === 0) {
    return null;
  }
  return models[0] ?? null;
}

function selectedReasoning(
  model: SessionModelDescriptor | null,
  selectedReasoningId: string | null | undefined,
): SessionReasoningOption | null {
  const options = model?.reasoningOptions ?? [];
  if (options.length === 0) {
    return null;
  }
  if (selectedReasoningId === null) {
    return null;
  }
  const normalizedReasoningId = selectedReasoningId?.trim() || null;
  const selected = normalizedReasoningId
    ? options.find((option) => option.id === normalizedReasoningId) ?? null
    : null;
  if (selected && isImplicitDefaultVariant(selected)) {
    return null;
  }
  return (
    selected ??
    visibleParameterOptions(options, true).at(-1) ??
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
  if ("defaultReasoningId" in model) {
    const defaultReasoningId = model.defaultReasoningId ?? null;
    const option = options.find((entry) => entry.id === defaultReasoningId);
    return option && isImplicitDefaultVariant(option) ? null : defaultReasoningId;
  }
  return visibleParameterOptions(options, true).at(-1)?.id ?? null;
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
    <span className="shrink-0 rounded-full border border-cyan-500/25 bg-cyan-500/10 px-1.5 py-[1px] text-[9px] font-medium uppercase leading-[11px] tracking-wide text-cyan-700 dark:text-cyan-300">
      Manual
    </span>
  );
}

function isImplicitDefaultVariant(option: SessionReasoningOption): boolean {
  return option.id === "default" && option.kind === "model_variant";
}

function visibleParameterOptions(
  options: readonly SessionReasoningOption[],
  hideImplicitDefaultVariant: boolean | undefined,
): SessionReasoningOption[] {
  if (!hideImplicitDefaultVariant || options.length <= 1) {
    return [...options];
  }
  return options.filter((option) => !isImplicitDefaultVariant(option));
}

function parameterKeyFallback(options: readonly SessionReasoningOption[]): string {
  const firstKind = options[0]?.kind;
  switch (firstKind) {
    case "reasoning_effort":
      return "reasoning_effort";
    case "thinking":
      return "thinking";
    case "model_variant":
      return "variant";
    default:
      return "parameter";
  }
}

function modelParameterKey(
  catalog: ProviderModelCatalog | null | undefined,
  model: SessionModelDescriptor,
  options: readonly SessionReasoningOption[],
): string {
  const optionIds = new Set(options.map((option) => option.id));
  const profile = catalog?.modelProfiles?.find((entry) => entry.modelId === model.id);
  const matchingConfigOption = profile?.configOptions.find((option) =>
    option.options?.some((choice) => optionIds.has(choice.id)),
  ) ?? profile?.configOptions.find((option) => option.kind === "select");
  return matchingConfigOption?.backendKey ??
    matchingConfigOption?.id ??
    parameterKeyFallback(options);
}

function ModelParamsInline(props: {
  parameterKey: string;
  options: SessionReasoningOption[];
}) {
  const title = `${props.parameterKey}: ${props.options.map((option) => option.id).join(", ")}`;
  return (
    <span
      className="hidden min-[900px]:flex min-w-0 shrink-0 items-center justify-end gap-1 overflow-hidden"
      title={title}
    >
      {props.options.map((option) => (
        <span
          key={option.id}
          title={`${props.parameterKey}: ${option.id}`}
          className="shrink-0 rounded-full border border-[var(--app-border)] bg-[var(--app-bg)] px-1.5 py-0.5 text-[11px] text-[var(--app-hint)]"
        >
          {option.id}
        </span>
      ))}
    </span>
  );
}

function ModelParamsBadge(props: {
  parameterKey: string;
  options: SessionReasoningOption[];
}) {
  const tooltipId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [tooltipStyle, setTooltipStyle] = useState<CSSProperties>({});

  const clearCloseTimer = () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  const openTooltip = (autoClose: boolean) => {
    clearCloseTimer();
    setOpen(true);
    if (autoClose) {
      closeTimerRef.current = window.setTimeout(() => setOpen(false), 3600);
    }
  };

  const closeTooltip = () => {
    clearCloseTimer();
    setOpen(false);
  };

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) {
      return;
    }
    const triggerRect = triggerRef.current.getBoundingClientRect();
    const tooltipRect = tooltipRef.current?.getBoundingClientRect();
    const longestTokenLength = Math.max(
      props.parameterKey.length,
      ...props.options.map((option) => option.id.length),
    );
    const width = Math.min(
      Math.max(148, 48 + longestTokenLength * 8),
      220,
      window.innerWidth - 16,
    );
    const height = tooltipRect?.height ??
      Math.min(168, 42 + Math.ceil(props.options.length / 2) * 26);
    const left = Math.min(
      Math.max(8, triggerRect.right - width),
      Math.max(8, window.innerWidth - width - 8),
    );
    const belowTop = triggerRect.bottom + 8;
    const aboveTop = triggerRect.top - height - 8;
    const top = belowTop + height <= window.innerHeight - 8
      ? belowTop
      : Math.max(8, aboveTop);
    setTooltipStyle({
      left,
      top,
      width,
    });
  }, [open, props.options.length]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (
        target &&
        (triggerRef.current?.contains(target) || tooltipRef.current?.contains(target))
      ) {
        return;
      }
      closeTooltip();
    };
    const handleViewportChange = () => closeTooltip();
    document.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
    };
  }, [open]);

  useEffect(() => {
    return () => clearCloseTimer();
  }, []);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="shrink-0 cursor-help rounded-full border border-[var(--app-border)] bg-[var(--app-bg)] px-1.5 py-0.5 text-[11px] text-[var(--app-hint)] transition-colors hover:text-[var(--app-fg)]"
        aria-label={`${props.options.length} parameters for ${props.parameterKey}`}
        aria-describedby={open ? tooltipId : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={`${props.parameterKey}: ${props.options.map((option) => option.id).join(", ")}`}
        onMouseEnter={() => openTooltip(false)}
        onMouseLeave={closeTooltip}
        onPointerDown={(event) => {
          if (event.pointerType !== "mouse") {
            event.stopPropagation();
          }
        }}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          openTooltip(true);
        }}
      >
        {props.options.length} params
      </button>
      {open ? createPortal(
        <div
          ref={tooltipRef}
          id={tooltipId}
          role="tooltip"
          style={tooltipStyle}
          className="fixed z-[120] rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-2 text-xs text-[var(--app-fg)] shadow-xl"
        >
          <div className="mb-1.5 truncate font-mono text-[11px] text-[var(--app-hint)]">
            {props.parameterKey}
          </div>
          <div className="flex flex-wrap gap-1">
            {props.options.map((option) => (
              <span
                key={option.id}
                className="rounded-md bg-[var(--app-subtle-bg)] px-1.5 py-1 font-mono text-[11px] text-[var(--app-fg)]"
              >
                {option.id}
              </span>
            ))}
          </div>
        </div>,
        document.body,
      ) : null}
    </>
  );
}

export function resolveSelectedModelDraft(args: {
  catalog: ProviderModelCatalog | null | undefined;
  selectedModelId?: string | null | undefined;
  selectedReasoningId?: string | null | undefined;
  allowProviderDefault?: boolean | undefined;
  preserveMissingSelectedModel?: boolean | undefined;
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
  const model = selectedModel(
    args.catalog,
    args.selectedModelId,
    args.preserveMissingSelectedModel,
  );
  const selectedReasoningId = args.selectedReasoningId !== undefined
    ? args.selectedReasoningId
    : model && "defaultReasoningId" in model && model.defaultReasoningId === null
      ? null
      : undefined;
  return {
    model,
    reasoning: selectedReasoning(model, selectedReasoningId),
  };
}

export function ModelCatalogList(props: {
  catalog: ProviderModelCatalog | null | undefined;
  selectedModelId?: string | null;
  loading?: boolean;
  readOnly?: boolean;
  emptyLabel?: string;
  paramDisplay?: "count" | "tooltip" | "responsive";
  hideImplicitDefaultVariant?: boolean;
  onModelSelect?: (modelId: string) => void;
  onDeleteManualModel?: (modelId: string) => void;
  deleteManualModelDisabled?: boolean;
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
        const reasoningOptions = model.reasoningOptions ?? [];
        const displayOptions = visibleParameterOptions(
          reasoningOptions,
          props.hideImplicitDefaultVariant ?? true,
        );
        const optionCount = displayOptions.length;
        const parameterKey = modelParameterKey(props.catalog, model, displayOptions);
        const paramDisplay = props.paramDisplay ?? "count";
        const showDelete = !interactive && manual && props.onDeleteManualModel !== undefined;
        const label = (
          <>
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <span className="min-w-0 truncate font-mono">{model.id}</span>
              <ModelSourceBadge manual={manual} />
            </span>
            {isSelected ? (
              <Check size={14} className="shrink-0 text-[var(--app-success)]" />
            ) : null}
            {optionCount > 1 ? (
              paramDisplay === "responsive" && !interactive ? (
                <>
                  <span className="min-[900px]:hidden">
                    <ModelParamsBadge parameterKey={parameterKey} options={displayOptions} />
                  </span>
                  <ModelParamsInline parameterKey={parameterKey} options={displayOptions} />
                </>
              ) : paramDisplay === "tooltip" && !interactive ? (
                <ModelParamsBadge parameterKey={parameterKey} options={displayOptions} />
              ) : (
                <span className="shrink-0 text-[11px] text-[var(--app-hint)]">
                  {optionCount} params
                </span>
              )
            ) : null}
            {showDelete ? (
              <button
                type="button"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  props.onDeleteManualModel?.(model.id);
                }}
                disabled={props.deleteManualModelDisabled}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-hint)] transition-colors hover:text-[var(--app-danger)] disabled:cursor-default disabled:opacity-50"
                aria-label={`Delete ${model.id}`}
                title={`Delete ${model.id}`}
              >
                <Trash2 size={13} />
              </button>
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
  const [draftReasoningId, setDraftReasoningId] = useState<string | null | undefined>(undefined);
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
  const panelReasoningOptions = visibleParameterOptions(panelModel?.reasoningOptions ?? [], true);
  const panelReasoning = selectedReasoning(
    panelModel,
    draftReasoningId !== undefined ? draftReasoningId : reasoning?.id ?? null,
  );
  const panelHasNoVariantOption =
    panelModel?.defaultReasoningId === null && panelReasoningOptions.length > 0;
  const visibleOptionCount =
    panelView === "param-list"
      ? Math.max(panelReasoningOptions.length + (panelHasNoVariantOption ? 1 : 0), 1)
      : Math.max(models.length, props.loading ? 1 : 0);

  /* Reset to model-list when panel closes */
  useEffect(() => {
    if (!open) {
      setPanelView("model-list");
      setDraftModelId(null);
      setDraftReasoningId(undefined);
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
    const hasNoVariantOption =
      nextModel?.defaultReasoningId === null && nextReasoningOptions.length > 0;

    if (nextReasoningOptions.length > 1 || hasNoVariantOption) {
      setDraftModelId(modelId);
      setDraftReasoningId(defaultReasoningId);
      setPanelView("param-list");
    } else {
      props.onModelChange(modelId, defaultReasoningId);
      /* 0 or 1 option — nothing further to choose */
      setOpen(false);
    }
  };

  const handleReasoningSelect = (reasoningId: string | null) => {
    if (draftModelId && draftModelId !== model?.id) {
      props.onModelChange(draftModelId, reasoningId);
    } else if (reasoningId === null) {
      const targetModelId = panelModel?.id ?? model?.id;
      if (targetModelId) {
        props.onModelChange(targetModelId, null);
      }
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
    labelParts.push(model?.id ?? "Model");
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
                        {panelModel?.id}
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
                    {panelReasoningOptions.length > 0 || panelHasNoVariantOption ? (
                      <>
                        {panelHasNoVariantOption ? (
                          <button
                            type="button"
                            onClick={() => handleReasoningSelect(null)}
                            className={joinClassNames(
                              "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors",
                              panelReasoning === null
                                ? "bg-[var(--app-subtle-bg)] text-[var(--app-fg)] font-medium"
                                : "text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]/60",
                            )}
                          >
                            <span className="flex-1 truncate">No variant</span>
                            {panelReasoning === null ? (
                              <Check size={14} className="shrink-0 text-[var(--app-success)]" />
                            ) : null}
                          </button>
                        ) : null}
                        {panelReasoningOptions.map((r) => (
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
                            {r.id === panelReasoning?.id ? (
                              <Check size={14} className="shrink-0 text-[var(--app-success)]" />
                            ) : null}
                          </button>
                        ))}
                      </>
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
