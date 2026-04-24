import { statSync } from "node:fs";
import type { RahEvent } from "@rah/runtime-protocol";
import {
  appendCachedGeminiHistoryEvents,
  type GeminiHistoryCacheManifest,
  loadCachedGeminiHistoryEvents,
  loadCachedGeminiHistoryManifest,
  loadCachedGeminiHistoryWindow,
  readCachedGeminiHistoryManifest,
  writeCachedGeminiHistoryEvents,
} from "./gemini-history-cache";
import { readTextRange } from "./file-snippets";
import {
  hashGeminiMessages,
  isGeminiJsonlSessionFile,
  loadGeminiConversationRecord,
  materializeGeminiConversationEvents,
} from "./gemini-conversation-utils";
import type {
  GeminiConversationRecord,
  GeminiMessageRecord,
  GeminiStoredSessionRecord,
} from "./gemini-session-types";

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMessageRecord(value: unknown): value is GeminiMessageRecord {
  return (
    isObject(value) &&
    typeof value.id === "string" &&
    typeof value.timestamp === "string" &&
    typeof value.type === "string"
  );
}

function parseGeminiAppendOnlyDelta(args: {
  filePath: string;
  previousSize: number;
  size: number;
}): GeminiConversationRecord | null {
  if (!isGeminiJsonlSessionFile(args.filePath) || args.previousSize <= 0 || args.size < args.previousSize) {
    return null;
  }
  if (args.size === args.previousSize) {
    return {
      sessionId: "",
      projectHash: "",
      startTime: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      messages: [],
    };
  }
  const boundaryText = readTextRange(args.filePath, {
    startOffset: args.previousSize - 1,
    endOffset: args.previousSize,
  });
  if (boundaryText !== "\n") {
    return null;
  }
  const appendedText = readTextRange(args.filePath, {
    startOffset: args.previousSize,
    endOffset: args.size,
  });
  if (!appendedText.endsWith("\n")) {
    return null;
  }

  const lines = appendedText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const messages: GeminiMessageRecord[] = [];
  const seenMessageIds = new Set<string>();
  const metadata: Partial<GeminiConversationRecord> = {};

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return null;
    }
    if (!isObject(parsed)) {
      return null;
    }
    if (typeof parsed.sessionId === "string" && typeof parsed.projectHash === "string") {
      metadata.sessionId = parsed.sessionId;
      metadata.projectHash = parsed.projectHash;
      if (typeof parsed.startTime === "string") {
        metadata.startTime = parsed.startTime;
      }
      if (typeof parsed.lastUpdated === "string") {
        metadata.lastUpdated = parsed.lastUpdated;
      }
      if (typeof parsed.summary === "string") {
        metadata.summary = parsed.summary;
      }
      if (parsed.kind === "main" || parsed.kind === "subagent") {
        metadata.kind = parsed.kind;
      }
      continue;
    }
    if (isObject(parsed.$set)) {
      if (typeof parsed.$set.startTime === "string") {
        metadata.startTime = parsed.$set.startTime;
      }
      if (typeof parsed.$set.lastUpdated === "string") {
        metadata.lastUpdated = parsed.$set.lastUpdated;
      }
      if (typeof parsed.$set.summary === "string") {
        metadata.summary = parsed.$set.summary;
      }
      if (parsed.$set.kind === "main" || parsed.$set.kind === "subagent") {
        metadata.kind = parsed.$set.kind;
      }
      continue;
    }
    if (typeof parsed.$rewindTo === "string" || !isMessageRecord(parsed)) {
      return null;
    }
    if (seenMessageIds.has(parsed.id)) {
      return null;
    }
    seenMessageIds.add(parsed.id);
    messages.push(parsed);
  }

  return {
    sessionId: metadata.sessionId ?? "",
    projectHash: metadata.projectHash ?? "",
    startTime: metadata.startTime ?? new Date().toISOString(),
    lastUpdated: metadata.lastUpdated ?? new Date().toISOString(),
    messages,
    ...(metadata.summary ? { summary: metadata.summary } : {}),
    ...(metadata.kind ? { kind: metadata.kind } : {}),
  };
}

function resolveGeminiConversation(record: GeminiStoredSessionRecord): GeminiConversationRecord {
  if (record.conversation.messages.length > 0) {
    return record.conversation;
  }
  const loaded = loadGeminiConversationRecord(record.filePath);
  if (!loaded) {
    throw new Error(`Could not load Gemini session file ${record.filePath}.`);
  }
  return loaded;
}

function tryIncrementalGeminiHistoryCacheRefresh(args: {
  record: GeminiStoredSessionRecord;
  size: number;
  mtimeMs: number;
  sessionId: string;
}): GeminiHistoryCacheManifest | null {
  const previousManifest = readCachedGeminiHistoryManifest(args.record.filePath);
  if (!previousManifest || args.size < previousManifest.size) {
    return null;
  }
  if (previousManifest.sourceKind === "json") {
    if (!previousManifest.sourceState) {
      return null;
    }
    const conversation = resolveGeminiConversation(args.record);
    if (conversation.kind === "subagent") {
      return null;
    }
    if (conversation.messages.length < previousManifest.sourceState.messageCount) {
      return null;
    }
    const prefix = conversation.messages.slice(0, previousManifest.sourceState.messageCount);
    if (hashGeminiMessages(prefix) !== previousManifest.sourceState.prefixHash) {
      return null;
    }
    const appendedMessages = conversation.messages.slice(previousManifest.sourceState.messageCount);
    const events =
      appendedMessages.length > 0
        ? materializeGeminiConversationEvents({
            sessionId: args.sessionId,
            conversation: {
              sessionId: args.record.ref.providerSessionId,
              projectHash: conversation.projectHash,
              startTime: conversation.startTime,
              lastUpdated: conversation.lastUpdated,
              messages: appendedMessages,
              ...(conversation.summary ? { summary: conversation.summary } : {}),
            },
          })
        : [];
    return appendCachedGeminiHistoryEvents({
      filePath: args.record.filePath,
      previousManifest,
      size: args.size,
      mtimeMs: args.mtimeMs,
      events,
      sourceState: {
        messageCount: conversation.messages.length,
        prefixHash: hashGeminiMessages(conversation.messages),
      },
    });
  }
  if (previousManifest.sourceKind !== "jsonl") {
    return null;
  }
  const delta = parseGeminiAppendOnlyDelta({
    filePath: args.record.filePath,
    previousSize: previousManifest.size,
    size: args.size,
  });
  if (!delta || delta.kind === "subagent") {
    return null;
  }
  const events =
    delta.messages.length > 0
      ? materializeGeminiConversationEvents({
          sessionId: args.record.ref.providerSessionId,
          conversation: {
            sessionId: args.record.ref.providerSessionId,
            projectHash: delta.projectHash,
            startTime: delta.startTime,
            lastUpdated: delta.lastUpdated,
            messages: delta.messages,
            ...(delta.summary ? { summary: delta.summary } : {}),
          },
        })
      : [];
  return appendCachedGeminiHistoryEvents({
    filePath: args.record.filePath,
    previousManifest,
    size: args.size,
    mtimeMs: args.mtimeMs,
    events,
  });
}

export function ensureGeminiHistoryCacheRevision(args: {
  sessionId: string;
  record: GeminiStoredSessionRecord;
  size: number;
  mtimeMs: number;
}): GeminiHistoryCacheManifest {
  const exactManifest = loadCachedGeminiHistoryManifest({
    filePath: args.record.filePath,
    size: args.size,
    mtimeMs: args.mtimeMs,
  });
  if (exactManifest) {
    return exactManifest;
  }

  const incrementallyRefreshed = tryIncrementalGeminiHistoryCacheRefresh({
    sessionId: args.sessionId,
    record: args.record,
    size: args.size,
    mtimeMs: args.mtimeMs,
  });
  if (incrementallyRefreshed) {
    return incrementallyRefreshed;
  }

  const currentStats = statSync(args.record.filePath);
  if (currentStats.size !== args.size || currentStats.mtimeMs !== args.mtimeMs) {
    throw new Error("Gemini frozen history revision is unavailable.");
  }

  const sourceKind = isGeminiJsonlSessionFile(args.record.filePath) ? "jsonl" : "json";
  const conversation = resolveGeminiConversation(args.record);
  return writeCachedGeminiHistoryEvents({
    filePath: args.record.filePath,
    size: args.size,
    mtimeMs: args.mtimeMs,
    events: materializeGeminiConversationEvents({
      sessionId: args.sessionId,
      conversation,
    }),
    sourceKind,
    ...(sourceKind === "json"
      ? {
          sourceState: {
            messageCount: conversation.messages.length,
            prefixHash: hashGeminiMessages(conversation.messages),
          },
        }
      : {}),
  });
}

export function rebindGeminiHistoryEvents(
  sessionId: string,
  cachedEvents: readonly RahEvent[],
): RahEvent[] {
  return cachedEvents.map((event, index) => ({
    ...event,
    id: `history:gemini-cache:${index + 1}`,
    seq: 1_000_000_000 + index + 1,
    sessionId,
  }));
}

export function rebindGeminiHistoryWindowEvents(args: {
  sessionId: string;
  startOffset: number;
  events: readonly RahEvent[];
}): RahEvent[] {
  return args.events.map((event, index) => ({
    ...event,
    id: `history:gemini-cache:${args.startOffset + index + 1}`,
    seq: 1_000_000_000 + args.startOffset + index + 1,
    sessionId: args.sessionId,
  }));
}

export function materializeGeminiHistoryEventsFromRecord(args: {
  sessionId: string;
  record: GeminiStoredSessionRecord;
}): RahEvent[] {
  const stats = statSync(args.record.filePath);
  ensureGeminiHistoryCacheRevision({
    sessionId: args.sessionId,
    record: args.record,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
  });
  const cached = loadCachedGeminiHistoryEvents({
    filePath: args.record.filePath,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
  });
  if (!cached) {
    throw new Error("Gemini history cache became unavailable after refresh.");
  }
  return rebindGeminiHistoryEvents(args.sessionId, cached);
}
