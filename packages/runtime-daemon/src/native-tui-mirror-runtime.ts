import type { NativeTuiPromptState, RahEvent } from "@rah/runtime-protocol";

import { EventBus } from "./event-bus";
import {
  maybeRecordNativeTuiMirrorSourceMissingDiagnostic,
  recordNativeTuiMirrorFailureDiagnostic,
  resolveNativeTuiMirrorFailureDiagnostic,
  resolveNativeTuiMirrorSourceDiagnostic,
  type NativeTuiDiagnosticStore,
} from "./native-tui-diagnostics";
import {
  shouldIgnoreStaleMirrorPromptClean,
  shouldIgnoreStaleMirrorStateActivity,
} from "./native-tui-mirror-guard";
import {
  nativeTuiMirrorIntervalMs,
  nativeTuiMirrorWarnAfterMs,
} from "./native-tui-runtime-config";
import {
  nativeTuiProviderRuntimeSession,
  type NativeTuiSessionState,
} from "./native-tui-session-state";
import { nextPromptStateFromActivity } from "./native-tui-prompt-state";
import type { NativeTuiMirrorProvider } from "./native-tui-mirror-provider";
import {
  applyProviderActivity,
  type ProviderActivity,
  type ProviderActivityMeta,
} from "./provider-activity";
import { PtyHub } from "./pty-hub";
import { SessionStore } from "./session-store";

type NativeTuiMirrorRuntimeDeps = {
  eventBus: EventBus;
  ptyHub: PtyHub;
  sessionStore: SessionStore;
  nativeTuiMirrors: NativeTuiMirrorProvider;
  diagnostics: NativeTuiDiagnosticStore;
  getSession: (sessionId: string) => NativeTuiSessionState | undefined;
  updatePromptState: (sessionId: string, promptState: NativeTuiPromptState) => void;
};

function isTurnEndingActivity(activity: ProviderActivity): activity is Extract<
  ProviderActivity,
  { type: "turn_completed" | "turn_failed" | "turn_canceled" }
> {
  return (
    activity.type === "turn_completed" ||
    activity.type === "turn_failed" ||
    activity.type === "turn_canceled"
  );
}

export class NativeTuiMirrorRuntime {
  constructor(private readonly deps: NativeTuiMirrorRuntimeDeps) {}

  startSessionMirror(sessionId: string): void {
    const native = this.deps.getSession(sessionId);
    if (!native || !this.deps.nativeTuiMirrors.supports(native.provider)) {
      return;
    }
    const timer = setInterval(() => {
      this.mirrorSession(sessionId);
    }, nativeTuiMirrorIntervalMs());
    timer.unref?.();
    native.mirrorTimer = timer;
    this.mirrorSession(sessionId);
  }

  mirrorSession(sessionId: string): void {
    const native = this.deps.getSession(sessionId);
    if (!native || !native.providerSessionId) {
      return;
    }
    const update = this.deps.nativeTuiMirrors.updateMirror(
      nativeTuiProviderRuntimeSession(native),
      native.providerMirror,
    );
    if (update.mirror) {
      native.providerMirror = update.mirror;
    }
    switch (update.status) {
      case "unbound":
      case "unsupported":
        return;
      case "missing":
        this.warnIfMirrorSourceIsMissing(native);
        return;
      case "failed":
        this.warnIfMirrorFailed(native, update.error, update.phase);
        return;
      case "ok":
        this.resolveMirrorDiagnostic(native);
        for (const item of update.items) {
          this.applyProviderActivity(native, item.meta, item.activity);
        }
        this.resolveMirrorFailureDiagnostic(native);
    }
  }

  private applyProviderActivity(
    native: NativeTuiSessionState,
    meta: ProviderActivityMeta,
    activity: ProviderActivity,
  ): RahEvent[] {
    const activityWithClientInput = attachSubmittedClientInput(native, activity);
    const activeTurnId = this.deps.sessionStore.getSession(native.sessionId)?.activeTurnId;
    const nextPromptState = nextPromptStateFromActivity(native.promptState, activityWithClientInput);
    if (shouldIgnoreStaleMirrorStateActivity(native, meta, activityWithClientInput, nextPromptState)) {
      return [];
    }
    const shouldClearDirtyPromptForCurrentTurn =
      native.promptState === "prompt_dirty" &&
      isTurnEndingActivity(activityWithClientInput) &&
      (activityWithClientInput.type === "turn_canceled" ||
        (activeTurnId !== undefined && activityWithClientInput.turnId === activeTurnId));
    const events = applyProviderActivity(
      {
        eventBus: this.deps.eventBus,
        ptyHub: this.deps.ptyHub,
        sessionStore: this.deps.sessionStore,
      },
      native.sessionId,
      meta,
      activityWithClientInput,
    );
    if (shouldClearDirtyPromptForCurrentTurn) {
      native.promptTracker.draftText = "";
      this.deps.updatePromptState(native.sessionId, "prompt_clean");
    } else if (nextPromptState !== native.promptState) {
      this.deps.updatePromptState(native.sessionId, nextPromptState);
    } else if (
      native.promptState !== "prompt_dirty" &&
      native.promptTracker.draftText.length === 0 &&
      activityWithClientInput.type === "timeline_item" &&
      activityWithClientInput.item.kind === "assistant_message" &&
      native.provider === "claude"
    ) {
      if (shouldIgnoreStaleMirrorPromptClean(native, meta)) {
        return events;
      }
      native.promptTracker.draftText = "";
      this.deps.updatePromptState(native.sessionId, "prompt_clean");
    }
    return events;
  }

  private resolveMirrorDiagnostic(native: NativeTuiSessionState): void {
    resolveNativeTuiMirrorSourceDiagnostic(this.deps.diagnostics, native);
  }

  private resolveMirrorFailureDiagnostic(native: NativeTuiSessionState): void {
    const resolved = resolveNativeTuiMirrorFailureDiagnostic(this.deps.diagnostics, native);
    if (resolved) {
      native.mirrorFailureWarningEmitted = false;
    }
  }

  private warnIfMirrorSourceIsMissing(native: NativeTuiSessionState): void {
    if (native.mirrorWarningEmitted) {
      return;
    }
    native.mirrorWarningEmitted = maybeRecordNativeTuiMirrorSourceMissingDiagnostic(
      this.deps.diagnostics,
      native,
      nativeTuiMirrorWarnAfterMs(),
    );
  }

  private warnIfMirrorFailed(
    native: NativeTuiSessionState,
    error: unknown,
    phase: string,
  ): void {
    const alreadyLogged = native.mirrorFailureWarningEmitted === true;
    const logged = recordNativeTuiMirrorFailureDiagnostic(
      this.deps.diagnostics,
      native,
      error,
      phase,
      { alreadyLogged },
    );
    native.mirrorFailureWarningEmitted = alreadyLogged || logged;
  }
}

function attachSubmittedClientInput(
  native: NativeTuiSessionState,
  activity: ProviderActivity,
): ProviderActivity {
  if (
    activity.type !== "timeline_item" ||
    activity.item.kind !== "user_message" ||
    activity.item.clientMessageId !== undefined
  ) {
    pruneSubmittedInputs(native);
    return activity;
  }
  const inputs = native.submittedInputs;
  if (!inputs || inputs.length === 0) {
    return activity;
  }
  const userText = activity.item.text;
  const matchIndex = inputs.findIndex((input) => input.text === userText);
  if (matchIndex < 0) {
    pruneSubmittedInputs(native);
    return activity;
  }
  const [match] = inputs.splice(matchIndex, 1);
  return {
    ...activity,
    item: {
      ...activity.item,
      ...(match?.clientMessageId !== undefined ? { clientMessageId: match.clientMessageId } : {}),
      ...(match?.clientTurnId !== undefined ? { clientTurnId: match.clientTurnId } : {}),
    },
  };
}

function pruneSubmittedInputs(native: NativeTuiSessionState): void {
  const inputs = native.submittedInputs;
  if (!inputs || inputs.length === 0) {
    return;
  }
  const cutoff = Date.now() - 10 * 60_000;
  native.submittedInputs = inputs.filter((input) => Date.parse(input.submittedAt) >= cutoff);
}
