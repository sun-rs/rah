import { useCallback, useEffect, useState } from "react";
import type { ProviderChoice } from "../components/ProviderSelector";
import type { SessionProjection } from "../types";
import {
  readSessionModelPreference,
  rememberSessionModelPreference,
} from "../session-model-preferences";
import {
  startSessionAndRememberModel,
  type RememberableStartOptions,
} from "../session-start-model-preferences";
import {
  readRememberedModelDrafts,
  type ModelDraft,
} from "../new-session-drafts";

function browserStorage(): Storage | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}

/** Owns model draft identity across New, optimistic startup and Resume. */
export function useSessionModelDrafts<StartOptions extends RememberableStartOptions>(args: {
  projections: ReadonlyMap<string, SessionProjection>;
  startSession: (options?: StartOptions) => Promise<string | null>;
}) {
  const [startModelDrafts, setStartModelDrafts] = useState<
    Record<ProviderChoice, ModelDraft>
  >(() => readRememberedModelDrafts());
  const [resumeModelDrafts, setResumeModelDrafts] = useState<
    Record<string, ModelDraft>
  >({});

  const persistedDraft = useCallback(
    (sessionId: string): ModelDraft | undefined => {
      const summary = args.projections.get(sessionId)?.summary;
      return summary
        ? readSessionModelPreference(browserStorage(), summary.session)
        : undefined;
    },
    [args.projections],
  );

  const modelDraftForSession = useCallback(
    (sessionId: string): ModelDraft | undefined =>
      resumeModelDrafts[sessionId] ?? persistedDraft(sessionId),
    [persistedDraft, resumeModelDrafts],
  );

  const updateResumeModelDraft = useCallback(
    (sessionId: string, nextDraft: ModelDraft) => {
      const summary = args.projections.get(sessionId)?.summary;
      if (summary) {
        rememberSessionModelPreference(
          browserStorage(),
          summary.session,
          nextDraft,
        );
      }
      setResumeModelDrafts((current) => ({
        ...current,
        [sessionId]: nextDraft,
      }));
    },
    [args.projections],
  );

  const startSessionWithRememberedModel = useCallback(
    (options?: StartOptions) =>
      startSessionAndRememberModel(
        args.startSession,
        updateResumeModelDraft,
        options,
      ),
    [args.startSession, updateResumeModelDraft],
  );

  useEffect(() => {
    setResumeModelDrafts((current) => {
      let next: Record<string, ModelDraft> | null = null;
      for (const [sessionId, projection] of args.projections) {
        if (current[sessionId]?.modelId) {
          continue;
        }
        const remembered = readSessionModelPreference(
          browserStorage(),
          projection.summary.session,
        );
        if (!remembered?.modelId) {
          continue;
        }
        next ??= { ...current };
        next[sessionId] = remembered;
      }
      return next ?? current;
    });
  }, [args.projections]);

  return {
    startModelDrafts,
    setStartModelDrafts,
    resumeModelDrafts,
    setResumeModelDrafts,
    modelDraftForSession,
    updateResumeModelDraft,
    startSessionWithRememberedModel,
  };
}
