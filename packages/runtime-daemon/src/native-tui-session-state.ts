import type {
  NativeTuiPromptState,
  SessionQueuedInputState,
} from "@rah/runtime-protocol";
import type { IndependentTerminalProcess } from "./independent-terminal";
import type { NativeTuiLaunchSpec } from "./native-tui-launch-spec";
import type {
  NativeTuiProviderMirror,
  NativeTuiProviderRuntimeSession,
} from "./native-tui-provider-runtime";
import type { LocalTerminalPromptTracker } from "./native-tui-prompt-state";

export type NativeTuiQueuedInput = {
  clientId: string;
  text: string;
  queuedAt: string;
  clientMessageId: string;
  clientTurnId?: string;
  state: SessionQueuedInputState;
};

export type NativeTuiSubmittedInput = {
  clientId: string;
  text: string;
  submittedAt: string;
  interruptedAt?: string;
  clientMessageId?: string;
  clientTurnId?: string;
};

export type NativeTuiSessionState = {
  sessionId: string;
  process: IndependentTerminalProcess;
  provider: NativeTuiLaunchSpec["provider"];
  cwd: string;
  startupTimestampMs: number;
  launchEnv?: Record<string, string>;
  providerSessionId?: string;
  promptState: NativeTuiPromptState;
  promptTracker: LocalTerminalPromptTracker;
  queuedInputs: NativeTuiQueuedInput[];
  submittedInputs?: NativeTuiSubmittedInput[];
  lastInjectedInputAtMs?: number;
  clearPromptBeforeNextInput?: boolean;
  stopPending?: boolean;
  stopTimer?: ReturnType<typeof setTimeout>;
  lastInterruptCompletedAtMs?: number;
  queuedDrainTimer?: ReturnType<typeof setTimeout>;
  recentOutputTail?: string;
  bindingTimer?: ReturnType<typeof setInterval>;
  bindingWarningEmitted?: boolean;
  fatalObservationError?: string;
  mirrorTimer?: ReturnType<typeof setInterval>;
  mirrorWakeTimer?: ReturnType<typeof setTimeout>;
  mirrorWarningEmitted?: boolean;
  mirrorFailureWarningEmitted?: boolean;
  providerMirror?: NativeTuiProviderMirror;
};

export function nativeTuiProviderRuntimeSession(
  native: NativeTuiSessionState,
): NativeTuiProviderRuntimeSession {
  return {
    sessionId: native.sessionId,
    provider: native.provider,
    cwd: native.cwd,
    startupTimestampMs: native.startupTimestampMs,
    ...(native.launchEnv ? { launchEnv: native.launchEnv } : {}),
    ...(native.providerSessionId ? { providerSessionId: native.providerSessionId } : {}),
  };
}

export function clearNativeTuiSessionTimers(native: NativeTuiSessionState | undefined): void {
  if (!native) {
    return;
  }
  if (native.bindingTimer) {
    clearInterval(native.bindingTimer);
    delete native.bindingTimer;
  }
  if (native.mirrorTimer) {
    clearInterval(native.mirrorTimer);
    delete native.mirrorTimer;
  }
  if (native.mirrorWakeTimer) {
    clearTimeout(native.mirrorWakeTimer);
    delete native.mirrorWakeTimer;
  }
  if (native.stopTimer) {
    clearTimeout(native.stopTimer);
    delete native.stopTimer;
  }
  if (native.queuedDrainTimer) {
    clearTimeout(native.queuedDrainTimer);
    delete native.queuedDrainTimer;
  }
  delete native.stopPending;
}

export function enqueueNativeTuiQueuedInput(
  native: NativeTuiSessionState,
  input: Omit<NativeTuiQueuedInput, "state">,
  maxQueueLength: number,
): boolean {
  if (native.queuedInputs.length >= maxQueueLength) {
    return false;
  }
  native.queuedInputs.push({ ...input, state: "queued" });
  return true;
}

export function cancelNativeTuiQueuedInputsForClient(
  native: NativeTuiSessionState,
  clientId: string,
): void {
  native.queuedInputs = native.queuedInputs.filter((queued) => queued.clientId !== clientId);
}

export function markNextNativeTuiQueuedInputSubmitting(
  native: NativeTuiSessionState,
): NativeTuiQueuedInput | undefined {
  if (native.queuedInputs.some((item) => item.state === "submitting")) {
    return undefined;
  }
  const queued = native.queuedInputs.find((item) => item.state === "queued");
  if (!queued) {
    return undefined;
  }
  queued.state = "submitting";
  return queued;
}

export function confirmNativeTuiQueuedInput(
  native: NativeTuiSessionState,
  clientMessageId: string,
): boolean {
  const index = native.queuedInputs.findIndex(
    (item) => item.clientMessageId === clientMessageId,
  );
  if (index < 0) {
    return false;
  }
  native.queuedInputs.splice(index, 1);
  return true;
}

export function updateNativeTuiQueuedInput(
  native: NativeTuiSessionState,
  clientMessageId: string,
  text: string,
): boolean {
  const queued = native.queuedInputs.find(
    (item) => item.clientMessageId === clientMessageId && item.state === "queued",
  );
  if (!queued) {
    return false;
  }
  queued.text = text;
  return true;
}

export function deleteNativeTuiQueuedInput(
  native: NativeTuiSessionState,
  clientMessageId: string,
): boolean {
  const index = native.queuedInputs.findIndex(
    (item) => item.clientMessageId === clientMessageId && item.state === "queued",
  );
  if (index < 0) {
    return false;
  }
  native.queuedInputs.splice(index, 1);
  return true;
}
