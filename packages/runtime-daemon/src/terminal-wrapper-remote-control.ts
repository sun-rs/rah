import type { TerminalWrapperPromptState } from "./terminal-wrapper-control";

export type TerminalWrapperRemoteControlTone = "danger" | "success";

export interface TerminalWrapperRemoteControlInput {
  providerLabel: string;
  hasPendingTurn: boolean;
  hasActiveTurn: boolean;
  promptState: TerminalWrapperPromptState;
  cancelRequested: boolean;
  reclaimRequested: boolean;
}

export interface TerminalWrapperRemoteControlState {
  busy: boolean;
  controlAvailable: boolean;
  status: string;
  footer: string;
  tone: TerminalWrapperRemoteControlTone;
}

export function deriveTerminalWrapperRemoteControlState(
  input: TerminalWrapperRemoteControlInput,
): TerminalWrapperRemoteControlState {
  const busy =
    input.cancelRequested ||
    input.hasActiveTurn ||
    input.promptState === "agent_busy";
  const controlAvailable = !input.hasPendingTurn && !busy;
  const status = input.cancelRequested
    ? "Stopping"
    : input.hasPendingTurn
      ? "Queued"
    : busy
      ? input.reclaimRequested
        ? "Thinking (reclaim pending)"
        : "Thinking"
      : "Waiting for Esc reclaim";
  const footer = input.cancelRequested
    ? `Stop requested. Waiting for ${input.providerLabel} to release control.`
    : input.hasPendingTurn
      ? "Queued input will run when ready."
    : busy
      ? input.reclaimRequested
        ? "Will return to local control when this turn finishes."
        : "Only after this turn: Esc works."
      : "Press Esc to resume local control.";

  return {
    busy,
    controlAvailable,
    status,
    footer,
    tone: controlAvailable ? "success" : "danger",
  };
}
