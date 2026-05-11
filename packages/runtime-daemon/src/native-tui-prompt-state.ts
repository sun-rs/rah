import type { NativeTuiPromptState } from "@rah/runtime-protocol";
import type { ProviderActivity } from "./provider-activity";

export interface LocalTerminalPromptTracker {
  draftText: string;
}

export function nextPromptStateFromActivity(
  current: NativeTuiPromptState,
  activity: ProviderActivity,
): NativeTuiPromptState {
  if (current === "prompt_dirty") {
    return "prompt_dirty";
  }
  switch (activity.type) {
    case "turn_started":
    case "turn_step_started":
    case "runtime_status":
      if (
        activity.type === "runtime_status" &&
        !["thinking", "streaming", "retrying"].includes(activity.status)
      ) {
        return current;
      }
      return "agent_busy";
    case "turn_completed":
    case "turn_failed":
    case "turn_canceled":
    case "session_failed":
    case "session_exited":
      return "prompt_clean";
    default:
      return current;
  }
}

function isPrintableInput(char: string): boolean {
  return char >= " " && char !== "\u007f";
}

export function applyLocalTerminalInput(params: {
  tracker: LocalTerminalPromptTracker;
  promptState: NativeTuiPromptState;
  data: string;
}): NativeTuiPromptState {
  if (params.promptState === "agent_busy") {
    params.tracker.draftText = "";
    return "agent_busy";
  }

  if (params.data.includes("\u001b")) {
    return params.tracker.draftText.length > 0 ? "prompt_dirty" : params.promptState;
  }

  for (const char of params.data) {
    if (char === "\r" || char === "\n") {
      if (params.tracker.draftText.length > 0) {
        params.tracker.draftText = "";
        return "agent_busy";
      }
      continue;
    }

    if (char === "\u007f" || char === "\b") {
      params.tracker.draftText = params.tracker.draftText.slice(
        0,
        Math.max(0, params.tracker.draftText.length - 1),
      );
      continue;
    }

    if (char === "\u0015" || char === "\u0003") {
      params.tracker.draftText = "";
      continue;
    }

    if (isPrintableInput(char)) {
      params.tracker.draftText += char;
    }
  }

  return params.tracker.draftText.length > 0 ? "prompt_dirty" : "prompt_clean";
}
