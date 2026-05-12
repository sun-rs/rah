import type {
  TimelineRuntimeModel,
  TimelineRuntimeModelSource,
} from "@rah/runtime-protocol";

export function timelineRuntimeModel(args: {
  modelId?: unknown;
  optionId?: unknown;
  optionKind?: TimelineRuntimeModel["optionKind"];
  source: TimelineRuntimeModelSource;
}): TimelineRuntimeModel | undefined {
  const modelId = typeof args.modelId === "string" && args.modelId.trim()
    ? args.modelId.trim()
    : undefined;
  const optionId = typeof args.optionId === "string" && args.optionId.trim()
    ? args.optionId.trim()
    : undefined;
  if (!modelId && !optionId) {
    return undefined;
  }
  return {
    ...(modelId ? { modelId } : {}),
    ...(optionId ? { optionId } : {}),
    ...(args.optionKind && optionId ? { optionKind: args.optionKind } : {}),
    source: args.source,
  };
}

export function codexRuntimeModelFromTurnContext(payload: Record<string, unknown>) {
  const collaborationMode =
    payload.collaboration_mode &&
    typeof payload.collaboration_mode === "object" &&
    !Array.isArray(payload.collaboration_mode)
      ? (payload.collaboration_mode as Record<string, unknown>)
      : undefined;
  const settings =
    collaborationMode?.settings &&
    typeof collaborationMode.settings === "object" &&
    !Array.isArray(collaborationMode.settings)
      ? (collaborationMode.settings as Record<string, unknown>)
      : undefined;
  return timelineRuntimeModel({
    modelId: payload.model ?? settings?.model,
    optionId: payload.effort ?? settings?.reasoning_effort,
    optionKind: "reasoning_effort",
    source: "native",
  });
}

export function openCodeRuntimeModelFromMessage(info: {
  providerID?: string;
  modelID?: string;
  variant?: unknown;
}) {
  const modelId =
    typeof info.providerID === "string" && info.providerID.trim() &&
    typeof info.modelID === "string" && info.modelID.trim()
      ? `${info.providerID.trim()}/${info.modelID.trim()}`
      : info.modelID;
  return timelineRuntimeModel({
    modelId,
    optionId: info.variant,
    optionKind: "model_variant",
    source: "native",
  });
}
