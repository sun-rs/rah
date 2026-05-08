import type { RahEvent } from "@rah/runtime-protocol";

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
import type { TerminalWrapperPromptState } from "./terminal-wrapper-control";

type NativeTuiMirrorRuntimeDeps = {
  eventBus: EventBus;
  ptyHub: PtyHub;
  sessionStore: SessionStore;
  nativeTuiMirrors: NativeTuiMirrorProvider;
  diagnostics: NativeTuiDiagnosticStore;
  getSession: (sessionId: string) => NativeTuiSessionState | undefined;
  updatePromptState: (sessionId: string, promptState: TerminalWrapperPromptState) => void;
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
    const activeTurnId = this.deps.sessionStore.getSession(native.sessionId)?.activeTurnId;
    const nextPromptState = nextPromptStateFromActivity(native.promptState, activity);
    if (shouldIgnoreStaleMirrorStateActivity(native, meta, activity, nextPromptState)) {
      return [];
    }
    const shouldClearDirtyPromptForCurrentTurn =
      native.promptState === "prompt_dirty" &&
      isTurnEndingActivity(activity) &&
      (activity.type === "turn_canceled" ||
        (activeTurnId !== undefined && activity.turnId === activeTurnId));
    const events = applyProviderActivity(
      {
        eventBus: this.deps.eventBus,
        ptyHub: this.deps.ptyHub,
        sessionStore: this.deps.sessionStore,
      },
      native.sessionId,
      meta,
      activity,
    );
    if (shouldClearDirtyPromptForCurrentTurn) {
      native.promptTracker.draftText = "";
      this.deps.updatePromptState(native.sessionId, "prompt_clean");
    } else if (nextPromptState !== native.promptState) {
      this.deps.updatePromptState(native.sessionId, nextPromptState);
    } else if (
      native.promptState !== "prompt_dirty" &&
      native.promptTracker.draftText.length === 0 &&
      activity.type === "timeline_item" &&
      activity.item.kind === "assistant_message" &&
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
