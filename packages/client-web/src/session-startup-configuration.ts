import type {
  SessionConfigValue,
  SessionSummary,
} from "@rah/runtime-protocol";

/**
 * Configuration captured when a Start/Resume action is submitted.
 *
 * The daemon remains authoritative, but its first discovery snapshot can race
 * the start response and briefly describe provider defaults. Keep the user's
 * submitted controls attached to the local Starting projection until the
 * runtime leaves the Starting phase so the composer never lies about the
 * configuration being launched.
 */
export interface PendingSessionStartupConfiguration {
  modelId?: string;
  reasoningId?: string | null;
  optionValues?: Record<string, SessionConfigValue>;
  modeId?: string;
}

export function createPendingSessionStartupConfiguration(args: {
  modelId?: string;
  reasoningId?: string | null;
  optionValues?: Record<string, SessionConfigValue>;
  modeId?: string;
}): PendingSessionStartupConfiguration | undefined {
  const modelId = args.modelId?.trim();
  const modeId = args.modeId?.trim();
  if (
    !modelId &&
    !modeId &&
    args.reasoningId === undefined &&
    args.optionValues === undefined
  ) {
    return undefined;
  }
  return {
    ...(modelId ? { modelId } : {}),
    ...(args.reasoningId !== undefined ? { reasoningId: args.reasoningId } : {}),
    ...(args.optionValues !== undefined ? { optionValues: args.optionValues } : {}),
    ...(modeId ? { modeId } : {}),
  };
}

export function applyPendingSessionStartupConfiguration(
  summary: SessionSummary,
  configuration: PendingSessionStartupConfiguration | undefined,
): SessionSummary {
  if (!configuration) {
    return summary;
  }

  const currentSession = summary.session;
  const session = { ...currentSession };
  if (configuration.modelId || configuration.reasoningId !== undefined) {
    session.model = {
      currentModelId:
        configuration.modelId ?? currentSession.model?.currentModelId ?? null,
      ...(configuration.reasoningId !== undefined
        ? { currentReasoningId: configuration.reasoningId }
        : currentSession.model?.currentReasoningId !== undefined
          ? { currentReasoningId: currentSession.model.currentReasoningId }
          : {}),
      availableModels: currentSession.model?.availableModels ?? [],
      mutable: currentSession.model?.mutable ?? true,
      source: currentSession.model?.source ?? "fallback",
    };
  }
  if (configuration.modeId) {
    session.mode = {
      currentModeId: configuration.modeId,
      availableModes: currentSession.mode?.availableModes ?? [],
      mutable: currentSession.mode?.mutable ?? true,
      source: currentSession.mode?.source ?? "local",
    };
  }
  if (configuration.optionValues !== undefined) {
    session.config = {
      values: {
        ...(currentSession.config?.values ?? {}),
        ...configuration.optionValues,
      },
      source: currentSession.config?.source ?? "fallback",
      ...(currentSession.config?.revision
        ? { revision: currentSession.config.revision }
        : {}),
    };
  }
  return { ...summary, session };
}
