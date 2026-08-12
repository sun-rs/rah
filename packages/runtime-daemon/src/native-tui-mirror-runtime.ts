import type { NativeTuiPromptState, RahEvent } from "@rah/runtime-protocol";
import { performance } from "node:perf_hooks";

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
  nativeTuiMirrorMaxIntervalMs,
  nativeTuiMirrorWarnAfterMs,
} from "./native-tui-runtime-config";
import {
  nativeTuiProviderRuntimeSession,
  type NativeTuiSubmittedInput,
  type NativeTuiSessionState,
} from "./native-tui-session-state";
import { nextPromptStateFromActivity } from "./native-tui-prompt-state";
import type { NativeTuiMirrorProvider } from "./native-tui-mirror-provider";
import type {
  NativeTuiMirrorUpdate,
  NativeTuiProviderActivityEnvelope,
} from "./native-tui-provider-runtime-types";
import {
  applyProviderActivity,
  type ProviderActivity,
  type ProviderActivityMeta,
} from "./provider-activity";
import {
  BoundedTaskScheduler,
  TaskSchedulerOverloadedError,
} from "./bounded-task-scheduler";
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
  confirmQueuedInputHandoff: (sessionId: string, clientMessageId: string) => void;
  scheduler?: BoundedTaskScheduler;
  mirrorIntervalMs?: number;
  mirrorMaxIntervalMs?: number;
};

type MirrorPollOutcome = "active" | "idle" | "backoff";

const MAX_MIRROR_ACTIVITIES_PER_SLICE = 32;
const MAX_MIRROR_ACTIVITY_SLICE_MS = 4;

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
  private readonly scheduler: BoundedTaskScheduler;
  private readonly ownsScheduler: boolean;
  private readonly mirrorIntervalMs: number;
  private readonly mirrorMaxIntervalMs: number;
  private closed = false;

  constructor(private readonly deps: NativeTuiMirrorRuntimeDeps) {
    this.scheduler =
      deps.scheduler ??
      // Mirror ingestion is latency-sensitive but not parallel work. A single
      // process-wide lane prevents two large provider batches from parsing on
      // the daemon event loop at once while adaptive polling keeps active
      // sessions responsive.
      new BoundedTaskScheduler({ maxConcurrency: 1, maxQueued: 64 });
    this.ownsScheduler = deps.scheduler === undefined;
    this.mirrorIntervalMs = Math.max(
      1,
      Math.floor(deps.mirrorIntervalMs ?? nativeTuiMirrorIntervalMs()),
    );
    this.mirrorMaxIntervalMs = Math.max(
      this.mirrorIntervalMs,
      Math.floor(deps.mirrorMaxIntervalMs ?? nativeTuiMirrorMaxIntervalMs()),
    );
  }

  startSessionMirror(sessionId: string): void {
    const native = this.deps.getSession(sessionId);
    if (!native || !this.deps.nativeTuiMirrors.supports(native.provider)) {
      return;
    }
    native.mirrorPollingEnabled = true;
    native.mirrorPollIntervalMs = this.mirrorIntervalMs;
    this.requestMirrorSession(sessionId, true);
  }

  mirrorSession(sessionId: string): void {
    this.requestMirrorSession(sessionId, true);
  }

  private requestMirrorSession(sessionId: string, resetCadence: boolean): void {
    if (this.closed) {
      return;
    }
    const native = this.deps.getSession(sessionId);
    if (!native || !native.providerSessionId) {
      return;
    }
    if (resetCadence) {
      native.mirrorPollIntervalMs = this.mirrorIntervalMs;
      if (native.mirrorTimer) {
        clearTimeout(native.mirrorTimer);
        delete native.mirrorTimer;
      }
    }
    if (native.mirrorInFlight) {
      native.mirrorRerunRequested = true;
      return;
    }
    native.mirrorInFlight = true;
    const providerSessionId = native.providerSessionId;
    void this.runMirrorSession(native, providerSessionId);
  }

  private async runMirrorSession(
    native: NativeTuiSessionState,
    providerSessionId: string,
  ): Promise<void> {
    let update: NativeTuiMirrorUpdate | undefined;
    let overloaded = false;
    let pollOutcome: MirrorPollOutcome = "backoff";
    try {
      update = await this.scheduler.schedule(() =>
        this.deps.nativeTuiMirrors.updateMirror(
          nativeTuiProviderRuntimeSession(native),
          native.providerMirror,
        ),
      );
    } catch (error) {
      if (error instanceof TaskSchedulerOverloadedError) {
        overloaded = true;
      } else {
        update = {
          status: "failed",
          ...(native.providerMirror ? { mirror: native.providerMirror } : {}),
          phase: "mirror_tick",
          error,
        };
      }
    }
    const current = this.deps.getSession(native.sessionId);
    if (current !== native) {
      native.mirrorInFlight = false;
      delete native.mirrorRerunRequested;
      return;
    }
    if (current.providerSessionId !== providerSessionId) {
      native.mirrorInFlight = false;
      delete native.mirrorRerunRequested;
      setImmediate(() => {
        this.requestMirrorSession(native.sessionId, true);
      }).unref?.();
      return;
    }
    try {
      if (overloaded || !update) {
        // Admission control is deliberate backpressure, not a provider
        // failure. The session's regular timer will retry without accumulating
        // another queued mirror job.
        return;
      }
      if (update.mirror) {
        native.providerMirror = update.mirror;
      }
      switch (update.status) {
        case "unbound":
        case "unsupported":
          pollOutcome = "idle";
          break;
        case "missing":
          this.warnIfMirrorSourceIsMissing(native);
          break;
        case "failed":
          this.warnIfMirrorFailed(native, update.error, update.phase);
          break;
        case "ok":
          this.resolveMirrorDiagnostic(native);
          await this.applyProviderActivitiesInSlices(
            native,
            providerSessionId,
            update.items,
          );
          this.resolveMirrorFailureDiagnostic(native);
          pollOutcome =
            update.items.length > 0 ||
            update.hasMore === true ||
            native.promptState === "agent_busy"
              ? "active"
              : "idle";
          if (update.hasMore) {
            native.mirrorRerunRequested = true;
          }
          break;
      }
    } finally {
      native.mirrorInFlight = false;
      if (native.mirrorRerunRequested) {
        delete native.mirrorRerunRequested;
        setImmediate(() => {
          this.requestMirrorSession(native.sessionId, false);
        }).unref?.();
      } else {
        this.scheduleNextMirror(native, pollOutcome);
      }
    }
  }

  private scheduleNextMirror(
    native: NativeTuiSessionState,
    outcome: MirrorPollOutcome,
  ): void {
    if (
      this.closed ||
      native.mirrorPollingEnabled !== true ||
      this.deps.getSession(native.sessionId) !== native
    ) {
      return;
    }
    const currentIntervalMs = Math.max(
      this.mirrorIntervalMs,
      native.mirrorPollIntervalMs ?? this.mirrorIntervalMs,
    );
    const nextIntervalMs =
      outcome === "active"
        ? this.mirrorIntervalMs
        : Math.min(this.mirrorMaxIntervalMs, currentIntervalMs * 2);
    native.mirrorPollIntervalMs = nextIntervalMs;
    const timer = setTimeout(() => {
      const current = this.deps.getSession(native.sessionId);
      if (current !== native) {
        return;
      }
      delete native.mirrorTimer;
      this.requestMirrorSession(native.sessionId, false);
    }, nextIntervalMs);
    timer.unref?.();
    native.mirrorTimer = timer;
  }

  shutdown(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.ownsScheduler) {
      this.scheduler.shutdown();
    }
  }

  private async applyProviderActivitiesInSlices(
    native: NativeTuiSessionState,
    providerSessionId: string,
    items: readonly NativeTuiProviderActivityEnvelope[],
  ): Promise<void> {
    let index = 0;
    while (index < items.length) {
      const startedAt = performance.now();
      let applied = 0;
      while (
        index < items.length &&
        applied < MAX_MIRROR_ACTIVITIES_PER_SLICE &&
        performance.now() - startedAt < MAX_MIRROR_ACTIVITY_SLICE_MS
      ) {
        const current = this.deps.getSession(native.sessionId);
        if (
          current !== native ||
          current.providerSessionId !== providerSessionId
        ) {
          return;
        }
        const item = items[index++]!;
        this.applyProviderActivity(native, item.meta, item.activity);
        applied += 1;
      }
      if (index < items.length) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
  }

  private applyProviderActivity(
    native: NativeTuiSessionState,
    meta: ProviderActivityMeta,
    activity: ProviderActivity,
  ): RahEvent[] {
    const attachedInput = attachSubmittedClientInput(native, activity);
    const activityWithClientInput = attachedInput.activity;
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
    if (attachedInput.input) {
      consumeSubmittedInput(native, attachedInput.input);
    }
    if (
      activityWithClientInput.type === "timeline_item" &&
      activityWithClientInput.item.kind === "user_message" &&
      activityWithClientInput.item.clientMessageId !== undefined
    ) {
      this.deps.confirmQueuedInputHandoff(
        native.sessionId,
        activityWithClientInput.item.clientMessageId,
      );
    }
    if (
      attachedInput.input?.interruptedAt !== undefined &&
      activityWithClientInput.type === "timeline_item" &&
      activityWithClientInput.item.kind === "user_message" &&
      activityWithClientInput.turnId !== undefined
    ) {
      events.push(
        ...applyProviderActivity(
          {
            eventBus: this.deps.eventBus,
            ptyHub: this.deps.ptyHub,
            sessionStore: this.deps.sessionStore,
          },
          native.sessionId,
          {
            provider: meta.provider,
            channel: "structured_persisted",
            authority: "derived",
            ts: attachedInput.input.interruptedAt,
          },
          {
            type: "turn_canceled",
            turnId: activityWithClientInput.turnId,
            reason: "interrupted",
            completedAt: attachedInput.input.interruptedAt,
          },
        ),
      );
      native.promptTracker.draftText = "";
      this.deps.updatePromptState(native.sessionId, "prompt_clean");
      return events;
    }
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
      activityWithClientInput.item.phase === "final_answer" &&
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

export function attachSubmittedClientInput(
  native: NativeTuiSessionState,
  activity: ProviderActivity,
): { activity: ProviderActivity; input?: NativeTuiSubmittedInput } {
  if (
    activity.type !== "timeline_item" ||
    activity.item.kind !== "user_message"
  ) {
    pruneSubmittedInputs(native);
    return { activity };
  }
  const inputs = native.submittedInputs;
  if (!inputs || inputs.length === 0) {
    return { activity };
  }
  const userItem = activity.item;
  if (userItem.clientMessageId !== undefined) {
    const match = inputs.find(
      (input) => input.clientMessageId === userItem.clientMessageId,
    );
    return {
      activity,
      ...(match ? { input: match } : {}),
    };
  }
  const userText = userItem.text;
  const exactMatch = inputs.find((input) => input.text === userText);
  // Some terminal providers can echo the local dirty draft immediately before
  // the Web-owned replacement text, even though RAH sent the provider-specific
  // clear sequence first. This is still an acknowledged handoff when the most
  // recent replacement submission is the exact suffix. Canonicalize the Chat
  // transcript back to the user-owned text and release the queue item.
  let replacementMatch: NativeTuiSubmittedInput | undefined;
  if (!exactMatch) {
    for (let index = inputs.length - 1; index >= 0; index -= 1) {
      const candidate = inputs[index];
      if (
        candidate?.replacesPromptDraft === true &&
        candidate.text.length > 0 &&
        userText.endsWith(candidate.text)
      ) {
        replacementMatch = candidate;
        break;
      }
    }
  }
  const match = exactMatch ?? replacementMatch;
  if (!match) {
    pruneSubmittedInputs(native);
    return { activity };
  }
  return {
    activity: {
      ...activity,
      item: {
        ...activity.item,
        ...(replacementMatch ? { text: replacementMatch.text } : {}),
        ...(match?.clientMessageId !== undefined ? { clientMessageId: match.clientMessageId } : {}),
        ...(match?.clientTurnId !== undefined ? { clientTurnId: match.clientTurnId } : {}),
      },
    },
    input: match,
  };
}

function consumeSubmittedInput(
  native: NativeTuiSessionState,
  input: NativeTuiSubmittedInput,
): void {
  const index = native.submittedInputs?.indexOf(input) ?? -1;
  if (index >= 0) {
    native.submittedInputs?.splice(index, 1);
  }
}

function pruneSubmittedInputs(native: NativeTuiSessionState): void {
  const inputs = native.submittedInputs;
  if (!inputs || inputs.length === 0) {
    return;
  }
  const cutoff = Date.now() - 10 * 60_000;
  native.submittedInputs = inputs.filter((input) => Date.parse(input.submittedAt) >= cutoff);
}
