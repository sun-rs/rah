import { randomUUID } from "node:crypto";
import type {
  SessionInputQueuePolicy,
  SessionInputRequest,
  SessionQueuedInput,
} from "@rah/runtime-protocol";
import type { RuntimeServices } from "./provider-adapter";

export type RuntimeQueuedInput = SessionInputRequest & {
  clientMessageId: string;
  queuedAt: string;
  state: "queued" | "submitting";
};

export class SessionInputQueueConflictError extends Error {
  readonly code = "SESSION_INPUT_QUEUE_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "SessionInputQueueConflictError";
  }
}

const QUEUE_EVENT_SOURCE = {
  provider: "system" as const,
  channel: "system" as const,
  authority: "authoritative" as const,
};

export function runtimeQueuedInput(request: SessionInputRequest): RuntimeQueuedInput {
  return {
    ...request,
    clientMessageId: request.clientMessageId ?? randomUUID(),
    queuedAt: new Date().toISOString(),
    state: "queued",
  };
}

export function projectSessionInputQueue(
  queue: readonly RuntimeQueuedInput[],
): SessionQueuedInput[] {
  return queue.map((item, index) => ({
    clientMessageId: item.clientMessageId,
    ...(item.clientTurnId ? { clientTurnId: item.clientTurnId } : {}),
    text: item.text,
    ...(item.attachments?.length ? { attachments: item.attachments.map((attachment) => ({ ...attachment })) } : {}),
    ...(item.annotations?.length
      ? {
          annotations: item.annotations.map((annotation) => ({
            ...annotation,
            ...(annotation.source ? { source: { ...annotation.source } } : {}),
          })),
        }
      : {}),
    queuedAt: item.queuedAt,
    position: index + 1,
    state: item.state,
  }));
}

export function publishSessionInputQueue(
  services: RuntimeServices,
  sessionId: string,
  queue: readonly RuntimeQueuedInput[],
): void {
  if (!services.sessionStore.getSession(sessionId)) {
    return;
  }
  const items = projectSessionInputQueue(queue);
  services.sessionStore.patchManagedSession(sessionId, { inputQueue: items });
  services.eventBus.publish({
    sessionId,
    type: "session.input_queue.changed",
    source: QUEUE_EVENT_SOURCE,
    payload: { items },
  });
}

export function publishSessionInputQueuePolicy(
  services: RuntimeServices,
  sessionId: string,
  policy: SessionInputQueuePolicy,
): void {
  if (!services.sessionStore.getSession(sessionId)) {
    return;
  }
  services.sessionStore.patchManagedSession(sessionId, { inputQueuePolicy: policy });
  services.eventBus.publish({
    sessionId,
    type: "session.input_queue.policy_changed",
    source: QUEUE_EVENT_SOURCE,
    payload: { policy },
  });
}

export function updateRuntimeQueuedInput(
  queue: RuntimeQueuedInput[],
  clientMessageId: string,
  text: string,
): boolean {
  const item = queue.find((entry) => entry.clientMessageId === clientMessageId);
  if (!item || item.state !== "queued") {
    return false;
  }
  item.text = text;
  return true;
}

export function markRuntimeQueuedInputSubmitting(
  queue: RuntimeQueuedInput[],
  clientMessageId: string,
): boolean {
  const item = queue.find((entry) => entry.clientMessageId === clientMessageId);
  if (!item || item.state !== "queued") {
    return false;
  }
  item.state = "submitting";
  return true;
}

export function markRuntimeQueuedInputQueued(
  queue: RuntimeQueuedInput[],
  clientMessageId: string,
): boolean {
  const item = queue.find((entry) => entry.clientMessageId === clientMessageId);
  if (!item) {
    return false;
  }
  item.state = "queued";
  return true;
}

export function deleteRuntimeQueuedInput(
  queue: RuntimeQueuedInput[],
  clientMessageId: string,
): boolean {
  const index = queue.findIndex((entry) => entry.clientMessageId === clientMessageId);
  if (index < 0) {
    return false;
  }
  queue.splice(index, 1);
  return true;
}

export function reorderRuntimeQueuedInput(
  queue: RuntimeQueuedInput[],
  clientMessageId: string,
  position: number,
): boolean {
  if (!Number.isFinite(position)) {
    return false;
  }
  const currentIndex = queue.findIndex((entry) => entry.clientMessageId === clientMessageId);
  if (currentIndex < 0 || queue[currentIndex]?.state !== "queued") {
    return false;
  }

  const requestedIndex = Math.trunc(position) - 1;
  if (requestedIndex === currentIndex) {
    return true;
  }

  const [item] = queue.splice(currentIndex, 1);
  if (!item) {
    return false;
  }
  const firstQueuedIndex = queue.findIndex((entry) => entry.state === "queued");
  const queuedStart = firstQueuedIndex < 0 ? queue.length : firstQueuedIndex;
  const targetIndex = Math.max(queuedStart, Math.min(queue.length, requestedIndex));
  queue.splice(targetIndex, 0, item);
  return true;
}

export function withdrawRuntimeQueuedInput(
  queue: RuntimeQueuedInput[],
  clientMessageId: string,
): boolean {
  const item = queue.find((entry) => entry.clientMessageId === clientMessageId);
  if (!item || item.state !== "queued") {
    return false;
  }
  return deleteRuntimeQueuedInput(queue, clientMessageId);
}

export function restoreRuntimeQueuedInput(
  queue: RuntimeQueuedInput[],
  input: RuntimeQueuedInput,
): boolean {
  const existing = queue.find((entry) => entry.clientMessageId === input.clientMessageId);
  if (existing) {
    existing.state = "queued";
    return false;
  }
  queue.unshift({ ...input, state: "queued" });
  return true;
}
