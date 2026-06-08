import type {
  RahEvent,
  SessionHistoryItemDetailKind,
  SessionHistoryPageResponse,
  SessionHistoryScope,
  ToolCall,
  ToolCallDetail,
  WorkbenchObservation,
} from "@rah/runtime-protocol";

const SMALL_RECORD_MAX_BYTES = 2_048;
const SUBJECT_LIST_LIMIT = 20;

function jsonByteSize(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return 0;
  }
}

function compactRecord<T extends Record<string, unknown>>(value: T | undefined): T | undefined {
  if (value === undefined) {
    return undefined;
  }
  return jsonByteSize(value) <= SMALL_RECORD_MAX_BYTES ? value : undefined;
}

function detailSize(detail: ToolCallDetail | undefined): number {
  return detail === undefined ? 0 : jsonByteSize(detail);
}

function compactToolCall(toolCall: ToolCall): ToolCall {
  const compactInput = compactRecord(toolCall.input);
  const compactResult = compactRecord(toolCall.result);
  const omittedInputSize =
    toolCall.input && compactInput === undefined ? jsonByteSize(toolCall.input) : 0;
  const omittedResultSize =
    toolCall.result && compactResult === undefined ? jsonByteSize(toolCall.result) : 0;
  const omittedDetailSize = detailSize(toolCall.detail);
  const omittedSize = omittedDetailSize + omittedInputSize + omittedResultSize;
  const compacted: ToolCall = {
    id: toolCall.id,
    family: toolCall.family,
    providerToolName: toolCall.providerToolName,
    ...(toolCall.title !== undefined ? { title: toolCall.title } : {}),
    ...(toolCall.summary !== undefined ? { summary: toolCall.summary } : {}),
    ...(compactInput !== undefined ? { input: compactInput } : {}),
    ...(compactResult !== undefined ? { result: compactResult } : {}),
    ...(omittedSize > 0
      ? {
          detailAvailable: true,
          detailSizeBytes: omittedSize,
        }
      : {}),
  };
  return compacted;
}

function compactObservation(observation: WorkbenchObservation): WorkbenchObservation {
  const compactMetrics = compactRecord(observation.metrics);
  const compacted: WorkbenchObservation = {
    id: observation.id,
    kind: observation.kind,
    status: observation.status,
    title: observation.title,
    ...(observation.summary !== undefined ? { summary: observation.summary } : {}),
    ...(observation.subject !== undefined
      ? {
          subject: {
            ...observation.subject,
            ...(observation.subject.files
              ? { files: observation.subject.files.slice(0, SUBJECT_LIST_LIMIT) }
              : {}),
            ...(observation.subject.urls
              ? { urls: observation.subject.urls.slice(0, SUBJECT_LIST_LIMIT) }
              : {}),
          },
        }
      : {}),
    ...(observation.exitCode !== undefined ? { exitCode: observation.exitCode } : {}),
    ...(observation.durationMs !== undefined ? { durationMs: observation.durationMs } : {}),
    ...(compactMetrics !== undefined ? { metrics: compactMetrics } : {}),
    ...(observation.detail !== undefined
      ? {
          detailAvailable: true,
          detailSizeBytes: detailSize(observation.detail),
        }
      : {}),
  };
  return compacted;
}

function withoutRaw<T extends RahEvent>(event: T): T {
  const { raw: _raw, ...rest } = event;
  return rest as T;
}

export function matchesSessionHistoryScope(
  event: RahEvent,
  scope: SessionHistoryScope,
): boolean {
  if (scope === "all") {
    return true;
  }
  switch (event.type) {
    case "tool.call.started":
    case "tool.call.delta":
    case "tool.call.completed":
    case "observation.started":
    case "observation.updated":
    case "observation.completed":
    case "tool.call.failed":
    case "observation.failed":
      return false;
    default:
      return true;
  }
}

export function summarizeHistoryEvent(event: RahEvent): RahEvent {
  switch (event.type) {
    case "tool.call.started":
    case "tool.call.completed":
      return {
        ...withoutRaw(event),
        payload: {
          ...event.payload,
          toolCall: compactToolCall(event.payload.toolCall),
        },
      };
    case "tool.call.delta":
      return {
        ...withoutRaw(event),
        payload: {
          ...event.payload,
          detail: { artifacts: [] },
        },
      };
    case "tool.call.failed":
      if (event.payload.detail === undefined) {
        return withoutRaw(event);
      }
      return {
        ...withoutRaw(event),
        payload: {
          toolCallId: event.payload.toolCallId,
          error: event.payload.error,
          detailAvailable: true,
          detailSizeBytes: detailSize(event.payload.detail),
        },
      };
    case "observation.started":
    case "observation.updated":
    case "observation.completed":
    case "observation.failed":
      return {
        ...withoutRaw(event),
        payload: {
          ...event.payload,
          observation: compactObservation(event.payload.observation),
        },
      };
    default:
      return withoutRaw(event);
  }
}

export function summarizeHistoryPage(page: SessionHistoryPageResponse): SessionHistoryPageResponse {
  const events = page.events.map(summarizeHistoryEvent);
  return {
    ...page,
    events,
    detailMode: "summary",
    approximateBytes: jsonByteSize({ ...page, events }),
  };
}

export function fullHistoryPage(page: SessionHistoryPageResponse): SessionHistoryPageResponse {
  return {
    ...page,
    detailMode: "full",
    approximateBytes: jsonByteSize(page),
  };
}

export function historyEventMatchesItem(
  event: RahEvent,
  kind: SessionHistoryItemDetailKind,
  itemId: string,
): boolean {
  if (kind === "tool_call") {
    switch (event.type) {
      case "tool.call.started":
      case "tool.call.completed":
        return event.payload.toolCall.id === itemId;
      case "tool.call.delta":
      case "tool.call.failed":
        return event.payload.toolCallId === itemId;
      default:
        return false;
    }
  }
  if (kind === "observation") {
    switch (event.type) {
      case "observation.started":
      case "observation.updated":
      case "observation.completed":
      case "observation.failed":
        return event.payload.observation.id === itemId;
      default:
        return false;
    }
  }
  return false;
}
