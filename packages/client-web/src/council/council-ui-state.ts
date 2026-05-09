import type {
  CouncilAgentConfig,
  ProviderModelCatalog,
  SessionConfigValue,
} from "@rah/runtime-protocol";
import type { ProviderChoice } from "../components/ProviderSelector";
import { resolveSelectedModelDraft } from "../components/SessionModelControls";
import { buildModelOptionValuesFromReasoning } from "../provider-capabilities";
import { resolveSessionModeControlState } from "../session-mode-ui";

export type CouncilAgentDraft = {
  id: string;
  provider: ProviderChoice;
  label: string;
  role: string;
  modelId: string | null;
  reasoningId: string | null;
  modeId: string | null;
};

export function createDefaultCouncilAgentDrafts(): CouncilAgentDraft[] {
  return [
    {
      id: "codex-lead",
      provider: "codex",
      label: "Codex Lead",
      role: "Implementer / planner",
      modelId: null,
      reasoningId: null,
      modeId: null,
    },
    {
      id: "claude-reviewer",
      provider: "claude",
      label: "Claude Reviewer",
      role: "Architecture and review",
      modelId: null,
      reasoningId: null,
      modeId: null,
    },
  ];
}

export function councilAgentDraftToConfig(args: {
  draft: CouncilAgentDraft;
  catalog?: ProviderModelCatalog | null;
}): CouncilAgentConfig {
  const selectedModel = resolveSelectedModelDraft({
    catalog: args.catalog,
    selectedModelId: args.draft.modelId,
    selectedReasoningId: args.draft.reasoningId,
  });
  const modelId = selectedModel.model?.id ?? null;
  const reasoningId = selectedModel.reasoning?.id ?? null;
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
  return {
    id: args.draft.id,
    provider: args.draft.provider,
    label: args.draft.label,
    ...(args.draft.role.trim() ? { role: args.draft.role.trim() } : {}),
    ...(modelId ? { modelId } : {}),
    ...(reasoningId !== null ? { reasoningId } : {}),
    ...(optionValues ? { optionValues } : {}),
    ...(modeId ? { modeId } : {}),
  };
}
