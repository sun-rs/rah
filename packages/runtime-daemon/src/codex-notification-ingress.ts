import type { JsonRpcNotification } from "./codex-live-types";

const DEFAULT_MAX_OUTPUT_TEXT_BYTES = 256 * 1024;
const OUTPUT_DETAIL_INCOMPLETE_FIELD = "__rahOutputDetailIncomplete";

type PreparedCodexNotification = {
  notification: JsonRpcNotification;
  processOutputKey?: string;
  completionOutputKey?: string;
  truncatedProcessOutput: boolean;
};

export type CodexNotificationCoalescing =
  | {
      key: string;
      mode: "latest";
    }
  | {
      key: string;
      mode: "utf8-delta" | "base64-delta" | "utf8-msg-chunk";
      chunk: string;
    };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function utf8Tail(value: string, maxBytes: number): {
  value: string;
  truncated: boolean;
} {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return { value, truncated: false };
  }
  // Work only on a byte-bounded suffix. This avoids allocating a Buffer the
  // size of an arbitrarily large provider payload merely to retain its tail.
  let candidate = value.slice(-maxBytes);
  let low = 0;
  let high = candidate.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (Buffer.byteLength(candidate.slice(middle), "utf8") <= maxBytes) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  candidate = candidate.slice(low);
  if (
    candidate.length > 0 &&
    candidate.charCodeAt(0) >= 0xdc00 &&
    candidate.charCodeAt(0) <= 0xdfff
  ) {
    candidate = candidate.slice(1);
  }
  return { value: candidate, truncated: true };
}

function base64Tail(value: string, maxDecodedBytes: number): {
  value: string;
  truncated: boolean;
} {
  const maxEncodedCharacters = Math.ceil(maxDecodedBytes / 3) * 4;
  if (value.length <= maxEncodedCharacters) {
    return { value, truncated: false };
  }
  let start = value.length - maxEncodedCharacters;
  start += (4 - (start % 4)) % 4;
  return { value: value.slice(start), truncated: true };
}

function boundedTextFields(
  source: Record<string, unknown>,
  fields: readonly string[],
  maxBytes: number,
): { value: Record<string, unknown>; truncated: boolean } {
  let value = source;
  let truncated = false;
  for (const field of fields) {
    const current = source[field];
    if (typeof current !== "string") {
      continue;
    }
    const bounded = utf8Tail(current, maxBytes);
    if (!bounded.truncated) {
      continue;
    }
    if (value === source) {
      value = { ...source };
    }
    value[field] = bounded.value;
    truncated = true;
  }
  return { value, truncated };
}

function processOutputDeltaKey(notification: JsonRpcNotification): string | undefined {
  const params = record(notification.params);
  if (!params) {
    return undefined;
  }
  switch (notification.method) {
    case "item/commandExecution/outputDelta":
    case "item/fileChange/outputDelta":
      return typeof params.itemId === "string" ? params.itemId : undefined;
    case "command/exec/outputDelta":
    case "process/outputDelta":
      return typeof params.processId === "string" ? params.processId : undefined;
    case "codex/event/exec_command_output_delta": {
      const msg = record(params.msg);
      return typeof msg?.call_id === "string" ? msg.call_id : undefined;
    }
    default:
      return undefined;
  }
}

function completionOutputKey(notification: JsonRpcNotification): string | undefined {
  const params = record(notification.params);
  if (!params) {
    return undefined;
  }
  if (notification.method === "item/completed") {
    const item = record(params.item);
    const type = item?.type;
    return item &&
      (type === "commandExecution" || type === "fileChange") &&
      typeof item.id === "string"
      ? item.id
      : undefined;
  }
  if (
    notification.method === "codex/event/exec_command_end" ||
    notification.method === "codex/event/patch_apply_end"
  ) {
    const msg = record(params.msg);
    return typeof msg?.call_id === "string" ? msg.call_id : undefined;
  }
  return undefined;
}

/**
 * Bounds the only provider fields known to carry arbitrarily large process
 * output. Semantic metadata remains intact, while the conversation feed gets
 * a bounded tail and durable-detail availability is downgraded explicitly.
 */
export function prepareCodexNotificationForIngress(
  notification: JsonRpcNotification,
  maxOutputTextBytes = DEFAULT_MAX_OUTPUT_TEXT_BYTES,
): PreparedCodexNotification {
  let next = notification;
  let params = record(notification.params);
  let truncatedProcessOutput = false;
  const processKey = processOutputDeltaKey(notification);
  const completedKey = completionOutputKey(notification);

  if (params) {
    let nextParams = params;
    const direct = boundedTextFields(
      params,
      ["delta", "output", "stdout", "stderr"],
      maxOutputTextBytes,
    );
    if (direct.value !== params) {
      nextParams = direct.value;
    }
    truncatedProcessOutput ||= direct.truncated;

    if (typeof params.deltaBase64 === "string") {
      const bounded = base64Tail(params.deltaBase64, maxOutputTextBytes);
      if (bounded.truncated) {
        if (nextParams === params) {
          nextParams = { ...params };
        }
        nextParams.deltaBase64 = bounded.value;
        truncatedProcessOutput = true;
      }
    }

    const originalItem = record(params.item);
    if (originalItem) {
      const bounded = boundedTextFields(
        originalItem,
        ["aggregatedOutput", "aggregated_output", "output", "stdout", "stderr"],
        maxOutputTextBytes,
      );
      if (bounded.value !== originalItem) {
        if (nextParams === params) {
          nextParams = { ...params };
        }
        nextParams.item = bounded.value;
      }
      truncatedProcessOutput ||= bounded.truncated;
    }

    const originalMsg = record(params.msg);
    if (originalMsg) {
      const bounded = boundedTextFields(
        originalMsg,
        ["aggregatedOutput", "aggregated_output", "output", "stdout", "stderr", "chunk"],
        maxOutputTextBytes,
      );
      if (bounded.value !== originalMsg) {
        if (nextParams === params) {
          nextParams = { ...params };
        }
        nextParams.msg = bounded.value;
      }
      truncatedProcessOutput ||= bounded.truncated;
    }

    if (nextParams !== params) {
      params = nextParams;
      next = { ...notification, params };
    }
  }

  return {
    notification: next,
    ...(processKey ? { processOutputKey: processKey } : {}),
    ...(completedKey ? { completionOutputKey: completedKey } : {}),
    truncatedProcessOutput,
  };
}

export function markCodexCompletionOutputIncomplete(
  notification: JsonRpcNotification,
): JsonRpcNotification {
  const params = record(notification.params);
  if (!params) {
    return notification;
  }
  if (notification.method === "item/completed") {
    const item = record(params.item);
    return item
      ? {
          ...notification,
          params: {
            ...params,
            item: { ...item, [OUTPUT_DETAIL_INCOMPLETE_FIELD]: true },
          },
        }
      : notification;
  }
  const msg = record(params.msg);
  return msg
    ? {
        ...notification,
        params: {
          ...params,
          msg: { ...msg, [OUTPUT_DETAIL_INCOMPLETE_FIELD]: true },
        },
      }
    : notification;
}

export function isCodexOutputDetailIncomplete(
  value: Record<string, unknown>,
): boolean {
  return value[OUTPUT_DETAIL_INCOMPLETE_FIELD] === true;
}

export function codexNotificationCoalesceKey(
  notification: JsonRpcNotification,
): string | undefined {
  return codexNotificationCoalescing(notification)?.key;
}

export function codexNotificationCoalescing(
  notification: JsonRpcNotification,
): CodexNotificationCoalescing | undefined {
  const params = record(notification.params);
  if (!params) {
    return undefined;
  }
  if (notification.method === "turn/diff/updated") {
    const turnId =
      typeof params.turnId === "string"
        ? params.turnId
        : typeof params.turn_id === "string"
          ? params.turn_id
          : undefined;
    return turnId
      ? { key: `turn-diff:${turnId}`, mode: "latest" }
      : undefined;
  }

  const method = notification.method.toLowerCase();
  if (!method.includes("delta")) {
    return undefined;
  }
  const turnId =
    typeof params?.turnId === "string"
      ? params.turnId
      : typeof params?.turn_id === "string"
        ? params.turn_id
        : "";
  const itemId =
    typeof params.itemId === "string"
      ? params.itemId
      : typeof params.item_id === "string"
        ? params.item_id
        : typeof params.processId === "string"
          ? params.processId
          : typeof params.process_id === "string"
            ? params.process_id
            : undefined;
  const stream = typeof params.stream === "string" ? params.stream : "";

  if (typeof params.delta === "string" && itemId) {
    return {
      key: `delta:${notification.method}:${turnId}:${itemId}:${stream}`,
      mode: "utf8-delta",
      chunk: params.delta,
    };
  }
  if (typeof params.deltaBase64 === "string" && itemId) {
    return {
      key: `delta:${notification.method}:${turnId}:${itemId}:${stream}`,
      mode: "base64-delta",
      chunk: params.deltaBase64,
    };
  }
  const msg = record(params.msg);
  const callId =
    typeof msg?.call_id === "string"
      ? msg.call_id
      : typeof msg?.callId === "string"
        ? msg.callId
        : undefined;
  if (typeof msg?.chunk === "string" && callId) {
    return {
      key: `delta:${notification.method}:${turnId}:${callId}:${stream}`,
      mode: "utf8-msg-chunk",
      chunk: msg.chunk,
    };
  }
  return undefined;
}

export function materializeCodexCoalescedNotification(
  notification: JsonRpcNotification,
  mode: Exclude<CodexNotificationCoalescing["mode"], "latest">,
  chunks: readonly string[],
): JsonRpcNotification {
  if (chunks.length <= 1) {
    return notification;
  }
  const params = record(notification.params);
  if (!params) {
    return notification;
  }
  if (mode === "utf8-msg-chunk") {
    const msg = record(params.msg);
    return msg
      ? {
          ...notification,
          params: {
            ...params,
            msg: {
              ...msg,
              chunk: chunks.join(""),
            },
          },
        }
      : notification;
  }
  if (mode === "base64-delta") {
    const decoded = chunks.map((chunk) => Buffer.from(chunk, "base64"));
    return {
      ...notification,
      params: {
        ...params,
        deltaBase64: Buffer.concat(decoded).toString("base64"),
      },
    };
  }
  return {
    ...notification,
    params: {
      ...params,
      delta: chunks.join(""),
    },
  };
}
