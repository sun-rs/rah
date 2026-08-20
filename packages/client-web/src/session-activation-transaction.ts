import type {
  SessionActivationResponse,
  SessionInputAnnotation,
  SessionInputAttachment,
  SessionInputRequest,
} from "@rah/runtime-protocol";
import { createClientSideId } from "./session-store-session-commands";

/**
 * The browser-owned portion of a start/resume/attach transaction.
 *
 * One object owns the draft payload and its stable identities until the daemon
 * proves provider acceptance. Reusing these identities is what lets optimistic
 * UI, daemon queueing, provider echoes, and retries describe the same turn.
 */
export interface SessionActivationInput {
  text: string;
  attachments: SessionInputAttachment[];
  annotations: SessionInputAnnotation[];
  hasInput: boolean;
  clientMessageId: string;
  clientTurnId: string;
}

export function createSessionActivationInput(args?: {
  text?: string | undefined;
  attachments?: SessionInputAttachment[] | undefined;
  annotations?: SessionInputAnnotation[] | undefined;
}): SessionActivationInput {
  const text = args?.text ?? "";
  const attachments = args?.attachments ?? [];
  const annotations = args?.annotations ?? [];
  return {
    text,
    attachments,
    annotations,
    hasInput: Boolean(text.trim() || attachments.length > 0 || annotations.length > 0),
    clientMessageId: createClientSideId("client-message"),
    clientTurnId: createClientSideId("client-turn"),
  };
}

export function sessionActivationInputRequest(
  clientId: string,
  input: SessionActivationInput,
): SessionInputRequest | undefined {
  if (!input.hasInput) return undefined;
  return {
    clientId,
    text: input.text,
    clientMessageId: input.clientMessageId,
    clientTurnId: input.clientTurnId,
    ...(input.attachments.length ? { attachments: input.attachments } : {}),
    ...(input.annotations.length ? { annotations: input.annotations } : {}),
  };
}

export function requireSessionActivationAcceptance(
  response: SessionActivationResponse,
  input: SessionActivationInput,
): void {
  if (!input.hasInput) return;
  const accepted = response.initialInputAcceptance;
  if (
    accepted?.clientMessageId !== input.clientMessageId ||
    accepted.clientTurnId !== input.clientTurnId
  ) {
    throw new Error(
      "The daemon did not acknowledge the submitted first question; activation did not commit.",
    );
  }
}
