import type { NativeTuiPromptState } from "@rah/runtime-protocol";
import type { ProviderActivity, ProviderActivityMeta } from "./provider-activity";

export type NativeTuiMirrorGuardState = {
  promptState: NativeTuiPromptState;
  lastInjectedInputAtMs?: number;
};

function timestampMs(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isKnownStalePersistedMirrorActivity(
  state: NativeTuiMirrorGuardState,
  meta: ProviderActivityMeta,
): boolean {
  if (
    state.promptState !== "agent_busy" ||
    state.lastInjectedInputAtMs === undefined ||
    meta.channel !== "structured_persisted"
  ) {
    return false;
  }
  const activityTimestampMs = timestampMs(meta.ts);
  return activityTimestampMs !== null && activityTimestampMs < state.lastInjectedInputAtMs;
}

function isStatefulNativeTuiActivity(activity: ProviderActivity): boolean {
  switch (activity.type) {
    case "session_state":
    case "session_failed":
    case "session_exited":
    case "turn_started":
    case "turn_completed":
    case "turn_failed":
    case "turn_canceled":
      return true;
    default:
      return false;
  }
}

export function shouldIgnoreStaleMirrorStateActivity(
  state: NativeTuiMirrorGuardState,
  meta: ProviderActivityMeta,
  activity: ProviderActivity,
  nextPromptState: NativeTuiPromptState,
): boolean {
  if (!isKnownStalePersistedMirrorActivity(state, meta)) {
    return false;
  }
  return isStatefulNativeTuiActivity(activity) || nextPromptState === "prompt_clean";
}

export function shouldIgnoreStaleMirrorPromptClean(
  state: NativeTuiMirrorGuardState,
  meta: ProviderActivityMeta,
): boolean {
  return isKnownStalePersistedMirrorActivity(state, meta);
}
