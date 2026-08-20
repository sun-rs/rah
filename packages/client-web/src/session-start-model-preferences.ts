import type { SessionConfigValue } from "@rah/runtime-protocol";

export type RememberableStartOptions = {
  model?: string;
  reasoningId?: string;
  optionValues?: Record<string, SessionConfigValue>;
  onSessionCreated?: (sessionId: string) => void;
};

export async function startSessionAndRememberModel<Options extends RememberableStartOptions>(
  startSession: (options?: Options) => Promise<string | null>,
  rememberModel: (
    sessionId: string,
    draft: {
      modelId?: string | null;
      reasoningId?: string | null;
      optionValues?: Record<string, SessionConfigValue>;
    },
  ) => void,
  options?: Options,
): Promise<string | null> {
  const rememberStartedModel = (sessionId: string) => {
    if (!options?.model) {
      return;
    }
    rememberModel(sessionId, {
      modelId: options.model,
      ...(options.reasoningId !== undefined ? { reasoningId: options.reasoningId } : {}),
      ...(options.optionValues !== undefined ? { optionValues: options.optionValues } : {}),
    });
  };
  const forwardedOptions = options
    ? {
        ...options,
        onSessionCreated: (sessionId: string) => {
          rememberStartedModel(sessionId);
          options.onSessionCreated?.(sessionId);
        },
      }
    : undefined;
  const result = await startSession(forwardedOptions as Options | undefined);
  if (result) {
    rememberStartedModel(result);
  }
  return result;
}
