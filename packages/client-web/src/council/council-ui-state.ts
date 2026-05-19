import type {
  CouncilAgentConfig,
  ProviderModelCatalog,
  SessionConfigValue,
  SessionModelDescriptor,
  SessionReasoningOption,
} from "@rah/runtime-protocol";
import { buildModelOptionValuesFromReasoning } from "../provider-capabilities";
import { resolveSessionModeControlState } from "../session-mode-ui";

export type CouncilAgentDraftProvider = CouncilAgentConfig["provider"];

export type CouncilAgentDraft = {
  id: string;
  provider: CouncilAgentDraftProvider;
  label: string;
  role: string;
  modelId: string | null;
  reasoningId: string | null;
  modeId: string | null;
};

function normalizeCouncilAgentLabel(value: string): string {
  return value.replace(/[\\/]+/g, "-");
}

export function createDefaultCouncilAgentDrafts(): CouncilAgentDraft[] {
  return [
    {
      id: "draft-1",
      provider: "codex",
      label: "",
      role: "",
      modelId: null,
      reasoningId: null,
      modeId: null,
    },
    {
      id: "draft-2",
      provider: "claude",
      label: "",
      role: "",
      modelId: null,
      reasoningId: null,
      modeId: null,
    },
    {
      id: "draft-3",
      provider: "opencode",
      label: "",
      role: "",
      modelId: null,
      reasoningId: null,
      modeId: null,
    },
  ];
}

export function resolveCouncilAgentModelSelection(args: {
  draft: CouncilAgentDraft;
  catalog?: ProviderModelCatalog | null;
}): {
  model: SessionModelDescriptor | null;
  modelId: string | null;
  reasoning: SessionReasoningOption | null;
  reasoningId: string | null;
  reasoningOptions: SessionReasoningOption[];
} {
  const catalog = args.catalog;
  const models = catalog?.models ?? [];
  const requestedModelId = args.draft.modelId?.trim() || null;
  const model =
    (requestedModelId ? models.find((entry) => entry.id === requestedModelId) : null) ??
    models[0] ??
    null;
  const reasoningOptions = model?.reasoningOptions ?? [];
  const reasoning =
    reasoningOptions.find((entry) => entry.id === args.draft.reasoningId) ??
    reasoningOptions.at(-1) ??
    null;
  return {
    model,
    modelId: model?.id ?? null,
    reasoning,
    reasoningId: reasoning?.id ?? null,
    reasoningOptions,
  };
}

export function normalizeCouncilAgentDraftForCatalog(args: {
  draft: CouncilAgentDraft;
  catalog?: ProviderModelCatalog | null;
}): CouncilAgentDraft {
  const selection = resolveCouncilAgentModelSelection(args);
  if (
    args.draft.modelId === selection.modelId &&
    args.draft.reasoningId === selection.reasoningId
  ) {
    return args.draft;
  }
  return {
    ...args.draft,
    modelId: selection.modelId,
    reasoningId: selection.reasoningId,
  };
}

export function resolveCouncilAgentAutoLabel(args: {
  draft: CouncilAgentDraft;
  catalog?: ProviderModelCatalog | null;
}): string {
  const selection = resolveCouncilAgentModelSelection(args);
  const modelLabel = selection.model?.label ?? selection.modelId;
  const reasoningLabel = selection.reasoning?.label ?? selection.reasoningId;
  if (modelLabel && reasoningLabel) {
    return `${modelLabel}-${reasoningLabel}`;
  }
  if (modelLabel) {
    return modelLabel;
  }
  return `${args.draft.provider} agent`;
}

export function resolveCouncilAgentDraftLabel(args: {
  draft: CouncilAgentDraft;
  catalog?: ProviderModelCatalog | null;
}): string {
  return normalizeCouncilAgentLabel(args.draft.label.trim() || resolveCouncilAgentAutoLabel(args));
}

export function councilAgentDraftToConfig(args: {
  draft: CouncilAgentDraft;
  catalog?: ProviderModelCatalog | null;
}): CouncilAgentConfig {
  const selectedModel = resolveCouncilAgentModelSelection(args);
  const modelId = selectedModel.modelId;
  const reasoningId = selectedModel.reasoningId;
  const optionValues = buildModelOptionValuesFromReasoning({
    catalog: args.catalog,
    modelId,
    reasoningId,
  }) as Record<string, SessionConfigValue> | undefined;
  const modeState = resolveSessionModeControlState({
    provider: args.draft.provider,
    draft: args.draft.modeId ? { accessModeId: args.draft.modeId, planEnabled: false } : null,
    catalog: args.catalog ?? null,
  });
  const modeId = args.draft.modeId ?? modeState.effectiveModeId;
  const label = resolveCouncilAgentDraftLabel(args);
  return {
    id: label,
    provider: args.draft.provider,
    label,
    ...(args.draft.role.trim() ? { role: args.draft.role.trim() } : {}),
    ...(modelId ? { modelId } : {}),
    ...(reasoningId !== null ? { reasoningId } : {}),
    ...(optionValues ? { optionValues } : {}),
    ...(modeId ? { modeId } : {}),
  };
}
