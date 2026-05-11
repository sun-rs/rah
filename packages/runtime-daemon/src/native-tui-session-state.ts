import type { NativeTuiPromptState } from "@rah/runtime-protocol";
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
  clientMessageId?: string;
  clientTurnId?: string;
};

export type NativeTuiSubmittedInput = {
  clientId: string;
  text: string;
  submittedAt: string;
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
  stopTurnId?: string;
  stopTimer?: ReturnType<typeof setTimeout>;
  lastInterruptCompletedAtMs?: number;
  promptClearTimer?: ReturnType<typeof setTimeout>;
  promptClearScheduledAtMs?: number;
  queuedDrainTimer?: ReturnType<typeof setTimeout>;
  recentOutputTail?: string;
  bindingTimer?: ReturnType<typeof setInterval>;
  bindingWarningEmitted?: boolean;
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
  if (native.promptClearTimer) {
    clearTimeout(native.promptClearTimer);
    delete native.promptClearTimer;
  }
  if (native.queuedDrainTimer) {
    clearTimeout(native.queuedDrainTimer);
    delete native.queuedDrainTimer;
  }
  delete native.promptClearScheduledAtMs;
  delete native.stopPending;
  delete native.stopTurnId;
}

export function enqueueNativeTuiQueuedInput(
  native: NativeTuiSessionState,
  input: NativeTuiQueuedInput,
  maxQueueLength: number,
): boolean {
  if (native.queuedInputs.length >= maxQueueLength) {
    return false;
  }
  native.queuedInputs.push(input);
  return true;
}

export function cancelNativeTuiQueuedInputsForClient(
  native: NativeTuiSessionState,
  clientId: string,
): void {
  native.queuedInputs = native.queuedInputs.filter((queued) => queued.clientId !== clientId);
}

export function dequeueNativeTuiQueuedInput(
  native: NativeTuiSessionState,
): NativeTuiQueuedInput | undefined {
  return native.queuedInputs.shift();
}
