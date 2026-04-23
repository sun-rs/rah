import type {
  PermissionResponseRequest,
  ProviderKind,
} from "@rah/runtime-protocol";
import type { ProviderActivity } from "./provider-activity";

export type TerminalWrapperPromptState =
  | "prompt_clean"
  | "prompt_dirty"
  | "agent_busy";

export interface WrapperHelloMessage {
  type: "wrapper.hello";
  provider: ProviderKind;
  cwd: string;
  rootDir: string;
  terminalPid: number;
  launchCommand: string[];
  resumeProviderSessionId?: string;
}

export interface WrapperProviderBoundMessage {
  type: "wrapper.provider_bound";
  sessionId: string;
  providerSessionId: string;
}

export interface WrapperPromptStateChangedMessage {
  type: "wrapper.prompt_state.changed";
  sessionId: string;
  state: TerminalWrapperPromptState;
}

export interface WrapperActivityMessage {
  type: "wrapper.activity";
  sessionId: string;
  activity: ProviderActivity;
}

export interface WrapperPtyOutputMessage {
  type: "wrapper.pty.output";
  sessionId: string;
  data: string;
}

export interface WrapperExitedMessage {
  type: "wrapper.exited";
  sessionId: string;
  exitCode?: number;
  signal?: string;
}

export type TerminalWrapperToDaemonMessage =
  | WrapperHelloMessage
  | WrapperProviderBoundMessage
  | WrapperPromptStateChangedMessage
  | WrapperActivityMessage
  | WrapperPtyOutputMessage
  | WrapperExitedMessage;

export interface WrapperReadyMessage {
  type: "wrapper.ready";
  sessionId: string;
  surfaceId: string;
  operatorGroupId: string;
}

export interface QueuedTurn {
  queuedTurnId: string;
  sourceSurfaceId: string;
  text: string;
}

export interface TurnEnqueueMessage {
  type: "turn.enqueue";
  sessionId: string;
  queuedTurn: QueuedTurn;
}

export interface TurnInjectMessage {
  type: "turn.inject";
  sessionId: string;
  queuedTurn: QueuedTurn;
}

export interface TurnInterruptMessage {
  type: "turn.interrupt";
  sessionId: string;
  sourceSurfaceId: string;
}

export interface PermissionResolveMessage {
  type: "permission.resolve";
  sessionId: string;
  requestId: string;
  response: PermissionResponseRequest;
}

export type TerminalWrapperFromDaemonMessage =
  | WrapperReadyMessage
  | TurnEnqueueMessage
  | TurnInjectMessage
  | TurnInterruptMessage
  | PermissionResolveMessage;

export interface TerminalWrapperBinding {
  sessionId: string;
  provider: ProviderKind;
  cwd: string;
  rootDir: string;
  terminalPid: number;
  launchCommand: string[];
  surfaceId: string;
  operatorGroupId: string;
  promptState: TerminalWrapperPromptState;
  providerSessionId?: string;
  resumeProviderSessionId?: string;
}

type RegisteredWrapper = TerminalWrapperBinding & {
  queuedTurns: QueuedTurn[];
  nextQueueSequence: number;
};

function nextQueuedTurnId(sessionId: string, sequence: number): string {
  return `${sessionId}:queued:${sequence}`;
}

/**
 * Draft runtime-owned registry for terminal wrapper sessions.
 *
 * This registry is intentionally local to the daemon for phase 1:
 * it models wrapper session identity, prompt boundary, and queued remote turns
 * without freezing any new protocol fields yet.
 */
export class TerminalWrapperRegistry {
  private readonly wrappers = new Map<string, RegisteredWrapper>();

  register(binding: TerminalWrapperBinding): TerminalWrapperBinding {
    this.wrappers.set(binding.sessionId, {
      ...binding,
      queuedTurns: [],
      nextQueueSequence: 1,
    });
    return binding;
  }

  get(sessionId: string): TerminalWrapperBinding | undefined {
    const wrapper = this.wrappers.get(sessionId);
    if (!wrapper) {
      return undefined;
    }
    const { queuedTurns: _queuedTurns, nextQueueSequence: _nextQueueSequence, ...binding } = wrapper;
    return binding;
  }

  bindProviderSession(sessionId: string, providerSessionId: string): TerminalWrapperBinding {
    const wrapper = this.require(sessionId);
    wrapper.providerSessionId = providerSessionId;
    return this.get(sessionId)!;
  }

  updatePromptState(
    sessionId: string,
    promptState: TerminalWrapperPromptState,
  ): TerminalWrapperBinding {
    const wrapper = this.require(sessionId);
    wrapper.promptState = promptState;
    return this.get(sessionId)!;
  }

  enqueueRemoteTurn(
    sessionId: string,
    sourceSurfaceId: string,
    text: string,
  ): QueuedTurn {
    const wrapper = this.require(sessionId);
    const queuedTurn: QueuedTurn = {
      queuedTurnId: nextQueuedTurnId(sessionId, wrapper.nextQueueSequence),
      sourceSurfaceId,
      text,
    };
    wrapper.nextQueueSequence += 1;
    wrapper.queuedTurns.push(queuedTurn);
    return queuedTurn;
  }

  peekQueuedTurn(sessionId: string): QueuedTurn | undefined {
    return this.require(sessionId).queuedTurns[0];
  }

  dequeueInjectableTurn(sessionId: string): QueuedTurn | undefined {
    const wrapper = this.require(sessionId);
    if (wrapper.promptState !== "prompt_clean") {
      return undefined;
    }
    return wrapper.queuedTurns.shift();
  }

  queuedTurnCount(sessionId: string): number {
    return this.require(sessionId).queuedTurns.length;
  }

  remove(sessionId: string): void {
    this.wrappers.delete(sessionId);
  }

  private require(sessionId: string): RegisteredWrapper {
    const wrapper = this.wrappers.get(sessionId);
    if (!wrapper) {
      throw new Error(`Unknown terminal wrapper session ${sessionId}.`);
    }
    return wrapper;
  }
}
