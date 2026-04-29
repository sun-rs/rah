import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, ChevronLeft, Cpu, LoaderCircle } from "lucide-react";
import type {
  ProviderModelCatalog,
  SessionModelDescriptor,
  SessionReasoningOption,
} from "@rah/runtime-protocol";

function selectedModel(
  catalog: ProviderModelCatalog | null | undefined,
  selectedModelId: string | null | undefined,
): SessionModelDescriptor | null {
  if (!catalog || catalog.models.length === 0) {
    return null;
  }
  return (
    catalog.models.find((model) => model.id === selectedModelId) ??
    catalog.models.find((model) => model.id === catalog.currentModelId) ??
    catalog.models.find((model) => model.isDefault) ??
    catalog.models[0] ??
    null
  );
}

function selectedReasoning(
  catalog: ProviderModelCatalog | null | undefined,
  model: SessionModelDescriptor | null,
  selectedReasoningId: string | null | undefined,
): SessionReasoningOption | null {
  const options = model?.reasoningOptions ?? [];
  if (options.length === 0) {
    return null;
  }
  return (
    options.find((option) => option.id === selectedReasoningId) ??
    (catalog?.currentModelId === model?.id
      ? options.find((option) => option.id === catalog?.currentReasoningId)
      : undefined) ??
    options.find((option) => option.id === model?.defaultReasoningId) ??
    options[0] ??
    null
  );
}

function defaultReasoningIdForModel(
  catalog: ProviderModelCatalog | null | undefined,
  model: SessionModelDescriptor | undefined,
): string | null {
  if (!model) {
    return null;
  }
  const options = model.reasoningOptions ?? [];
  if (options.length === 0) {
    return null;
  }
  if (
    catalog?.currentModelId === model.id &&
    options.some((option) => option.id === catalog.currentReasoningId)
  ) {
    return catalog.currentReasoningId ?? null;
  }
  return (
    model.defaultReasoningId ??
    options[0]?.id ??
    null
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
    reasoning: selectedReasoning(args.catalog, model, args.selectedReasoningId),
  };
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
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const modelViewRef = useRef<HTMLDivElement>(null);
  const paramViewRef = useRef<HTMLDivElement>(null);
  const modelListRef = useRef<HTMLDivElement>(null);
  const paramListRef = useRef<HTMLDivElement>(null);
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({});
  const visibleOptionCount =
    panelView === "param-list"
      ? Math.max(reasoningOptions.length, 1)
      : Math.max(models.length, props.loading ? 1 : 0);

  /* Reset to model-list when panel closes */
  useEffect(() => {
    if (!open) {
      setPanelView("model-list");
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
    props.onModelChange(modelId, defaultReasoningIdForModel(props.catalog, nextModel));

    if (nextReasoningOptions.length > 1) {
      setPanelView("param-list");
    } else {
      /* 0 or 1 option — nothing further to choose */
      setOpen(false);
    }
  };

  const handleReasoningSelect = (reasoningId: string) => {
    props.onReasoningChange(reasoningId);
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
    ? `${pillBase} h-8 w-8 shrink-0 justify-center p-0`
    : props.compact
      ? `${pillBase} h-9 w-full justify-start px-2.5`
      : props.mobileIconOnly
        ? `${pillBase} h-10 w-10 shrink-0 justify-center p-0 md:h-9 md:w-auto md:justify-start md:px-3 lg:h-8`
        : `${pillBase} h-8 md:h-9 px-2.5 md:px-3`;

  const optionBtn = (isSelected: boolean) =>
    `flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ` +
    (isSelected
      ? "bg-[var(--app-subtle-bg)] text-[var(--app-fg)] font-medium"
      : "text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]/60");

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={props.disabled || props.loading}
        onClick={() => setOpen((v) => !v)}
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
              props.mobileIconOnly ? "hidden md:inline" : ""
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
            } ${props.mobileIconOnly ? "hidden md:block" : ""}`}
          />
        )}
      </button>

      {open &&
        createPortal(
          <div
            ref={panelRef}
            data-session-model-panel="true"
            className="rah-popover-panel fixed z-[60] overflow-hidden rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] shadow-2xl focus:outline-none"
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
                  <div
                    ref={modelListRef}
                    className="min-h-0 flex-1 overflow-y-auto custom-scrollbar p-1.5"
                  >
                    {models.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => handleModelSelect(m.id)}
                        className={optionBtn(m.id === model?.id)}
                      >
                        <span className="flex-1 truncate">{m.label}</span>
                        {m.id === model?.id && (
                          <Check size={14} className="shrink-0 text-[var(--app-success)]" />
                        )}
                        {(m.reasoningOptions?.length ?? 0) > 1 && (
                          <span className="shrink-0 text-[11px] text-[var(--app-hint)]">
                            {m.reasoningOptions?.length} params
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
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
                        {model?.label}
                      </div>
                      <div className="text-[11px] text-[var(--app-hint)]">
                        Select parameter
                      </div>
                    </div>
                  </div>
                  <div
                    ref={paramListRef}
                    className="min-h-0 flex-1 overflow-y-auto custom-scrollbar p-1.5"
                  >
                    {reasoningOptions.length > 1 ? (
                      reasoningOptions.map((r) => (
                        <button
                          key={r.id}
                          type="button"
                          onClick={() => handleReasoningSelect(r.id)}
                          className={optionBtn(r.id === reasoning?.id)}
                        >
                          <span className="flex-1 truncate">{r.label}</span>
                          {r.id === reasoning?.id && (
                            <Check size={14} className="shrink-0 text-[var(--app-success)]" />
                          )}
                        </button>
                      ))
                    ) : reasoningOptions.length === 1 ? (
                      <div className="px-2.5 py-2 text-sm text-[var(--app-hint)]">
                        {reasoningOptions[0]?.label}
                      </div>
                    ) : (
                      <div className="px-2.5 py-2 text-sm text-[var(--app-hint)]">
                        No parameters for this model
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
