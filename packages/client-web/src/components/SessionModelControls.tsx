import { Cpu, Gauge } from "lucide-react";
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
  model: SessionModelDescriptor | null,
  selectedReasoningId: string | null | undefined,
): SessionReasoningOption | null {
  const options = model?.reasoningOptions ?? [];
  if (options.length === 0) {
    return null;
  }
  return (
    options.find((option) => option.id === selectedReasoningId) ??
    options.find((option) => option.id === model?.defaultReasoningId) ??
    options[0] ??
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
  if (args.allowProviderDefault && !args.selectedModelId && (args.catalog?.models.length ?? 0) === 0) {
    return { model: null, reasoning: null };
  }
  const model = selectedModel(args.catalog, args.selectedModelId);
  return {
    model,
    reasoning: selectedReasoning(model, args.selectedReasoningId),
  };
}

export function SessionModelControls(props: {
  catalog: ProviderModelCatalog | null | undefined;
  selectedModelId?: string | null;
  selectedReasoningId?: string | null;
  loading?: boolean;
  disabled?: boolean;
  compact?: boolean;
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
  if (models.length === 0 && !props.loading) {
    return null;
  }

  const controlClassName = props.compact
    ? "h-8 rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2 text-[11px] text-[var(--app-fg)]"
    : "inline-flex h-8 md:h-9 items-center gap-1.5 rounded-full border border-[var(--app-border)] bg-[var(--app-bg)]/90 pl-2 pr-2 text-[11px] text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)]";
  const selectClassName = props.compact
    ? "h-8 rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2 text-[11px] text-[var(--app-fg)]"
    : "max-w-[8.5rem] appearance-none bg-transparent text-[11px] text-[var(--app-fg)] focus:outline-none";
  const reasoningOptions = model?.reasoningOptions ?? [];

  return (
    <div className={`flex items-center gap-1.5 ${props.compact ? "min-h-8" : "min-h-8 md:min-h-9"}`}>
      <label className={props.compact ? "flex items-center gap-2" : controlClassName}>
        <span className="sr-only">Model</span>
        <Cpu size={12} className="shrink-0 text-[var(--app-hint)]" />
        <select
          value={model?.id ?? ""}
          disabled={props.disabled || props.loading || models.length === 0}
          onChange={(event) => {
            if (event.target.value === "") {
              props.onModelChange("", null);
              return;
            }
            const nextModel = models.find((entry) => entry.id === event.target.value);
            props.onModelChange(event.target.value, nextModel?.defaultReasoningId ?? null);
          }}
          className={props.compact ? `${selectClassName} min-w-[8rem] max-w-[10rem]` : selectClassName}
          title="Model"
        >
          {props.loading && models.length === 0 && !props.allowProviderDefault ? (
            <option value="">Loading models…</option>
          ) : null}
          {props.allowProviderDefault && models.length === 0 ? <option value="">Default</option> : null}
          {models.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </select>
      </label>
      {reasoningOptions.length > 1 ? (
        <label className={props.compact ? "flex items-center gap-2" : controlClassName}>
          <span className="sr-only">Reasoning effort</span>
          <Gauge size={12} className="shrink-0 text-[var(--app-hint)]" />
          <select
            value={reasoning?.id ?? ""}
            disabled={props.disabled || props.loading}
            onChange={(event) => props.onReasoningChange(event.target.value)}
            className={props.compact ? `${selectClassName} min-w-[5.5rem] max-w-[7rem]` : selectClassName}
            title="Reasoning effort"
          >
            {reasoningOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  );
}
