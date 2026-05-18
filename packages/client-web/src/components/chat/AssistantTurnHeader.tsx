import type { ProviderKind, TimelineRuntimeModel } from "@rah/runtime-protocol";
import { ProviderLogo } from "../ProviderLogo";

function runtimeModelLabel(runtimeModel: TimelineRuntimeModel | undefined): string | null {
  if (!runtimeModel?.modelId && !runtimeModel?.optionId) {
    return null;
  }
  return [runtimeModel.modelId, runtimeModel.optionId].filter(Boolean).join(" · ");
}

export function AssistantTurnHeader(props: {
  provider: ProviderKind;
  runtimeModel?: TimelineRuntimeModel;
}) {
  const modelLabel = runtimeModelLabel(props.runtimeModel);
  if (!modelLabel) {
    return null;
  }

  return (
    <div
      className="mb-1.5 flex items-center gap-1.5 px-1 text-[10px] font-medium leading-3 tracking-[0.01em] text-[var(--app-hint)] opacity-75"
      title={`Model source: ${props.runtimeModel?.source ?? "unknown"}`}
      data-testid="chat-assistant-turn-header"
    >
      <ProviderLogo
        provider={props.provider}
        variant="bare"
        className="h-[11px] w-[11px]"
      />
      <span>{modelLabel}</span>
    </div>
  );
}
