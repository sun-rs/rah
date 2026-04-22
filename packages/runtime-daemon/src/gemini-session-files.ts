import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AttachSessionRequest,
  ManagedSession,
  RahEvent,
  SessionHistoryPageResponse,
  StoredSessionRef,
} from "@rah/runtime-protocol";
import type {
  FrozenHistoryBoundary,
  FrozenHistoryPage,
  FrozenHistoryPageLoader,
} from "./history-snapshots";
import type { RuntimeServices } from "./provider-adapter";
import { EventBus } from "./event-bus";
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
import { PtyHub } from "./pty-hub";
import { applyProviderActivity, type ProviderActivity } from "./provider-activity";
import { SessionStore } from "./session-store";
import {
  getCachedStoredSessionRef,
  loadStoredSessionMetadataCache,
  setCachedStoredSessionRef,
  writeStoredSessionMetadataCache,
} from "./stored-session-metadata-cache";

const REHYDRATED_CAPABILITIES = {
  livePermissions: false,
  steerInput: false,
  queuedInput: false,
  modelSwitch: false,
  planMode: false,
  subagents: false,
} as const;

const SYSTEM_SOURCE = {
  provider: "system" as const,
  channel: "system" as const,
  authority: "authoritative" as const,
};

const SESSION_FILE_PREFIX = "session-";

type GeminiToolCallRecord = {
  id: string;
  name: string;
  args?: Record<string, unknown>;
  result?: unknown;
  status?: string;
  timestamp?: string;
  displayName?: string;
  description?: string;
};

type GeminiMessageRecord = {
  id: string;
  timestamp: string;
  type: "user" | "gemini" | "info" | "error" | "warning";
  content: unknown;
  toolCalls?: GeminiToolCallRecord[];
  thoughts?: Array<{ timestamp?: string; subject?: string; text?: string }>;
  tokens?: {
    input?: number;
    output?: number;
    cached?: number;
    thoughts?: number;
    total?: number;
  } | null;
  model?: string;
};

type GeminiConversationRecord = {
  sessionId: string;
  projectHash: string;
  startTime: string;
  lastUpdated: string;
  messages: GeminiMessageRecord[];
  summary?: string;
  kind?: "main" | "subagent";
};

export interface GeminiStoredSessionRecord {
  ref: StoredSessionRef;
  filePath: string;
  conversation: GeminiConversationRecord;
}

type GeminiFrozenHistoryCursor = {
  offset: number;
};

function resolveGeminiHome(): string {
  return process.env.GEMINI_CLI_HOME ?? path.join(os.homedir(), ".gemini");
}

export function resolveGeminiStoredSessionWatchRoots(): string[] {
  return [path.join(resolveGeminiHome(), "tmp")];
}

function getProjectHash(projectRoot: string): string {
  return createHash("sha256").update(projectRoot).digest("hex");
}

function getChatsDirForCwd(cwd: string): string {
  return path.join(resolveGeminiHome(), "tmp", getProjectHash(cwd), "chats");
}

function listGeminiSessionFiles(chatsDir: string): string[] {
  try {
    return readdirSync(chatsDir)
      .filter((entry) => entry.startsWith(SESSION_FILE_PREFIX))
      .filter((entry) => entry.endsWith(".json") || entry.endsWith(".jsonl"))
      .map((entry) => path.join(chatsDir, entry))
      .sort();
  } catch {
    return [];
  }
}

function scanGeminiChatsDirs(): string[] {
  const tmpRoot = path.join(resolveGeminiHome(), "tmp");
  try {
    return readdirSync(tmpRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(tmpRoot, entry.name, "chats"))
      .filter((candidate) => {
        try {
          return statSync(candidate).isDirectory();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

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

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((part) => {
      if (!isObject(part)) {
        return [];
      }
      if (typeof part.text === "string") {
        return [part.text];
      }
      if (typeof part.thought === "string") {
        return [part.thought];
      }
      if (typeof part.description === "string") {
        return [part.description];
      }
      return [];
    })
    .join("")
    .trim();
}

function loadGeminiConversationRecord(filePath: string): GeminiConversationRecord | null {
  try {
    const content = readFileSync(filePath, "utf8");
    try {
      const parsed = JSON.parse(content) as unknown;
      if (
        isObject(parsed) &&
        typeof parsed.sessionId === "string" &&
        typeof parsed.projectHash === "string" &&
        Array.isArray(parsed.messages)
      ) {
        return {
          sessionId: parsed.sessionId,
          projectHash: parsed.projectHash,
          startTime:
            typeof parsed.startTime === "string" ? parsed.startTime : new Date().toISOString(),
          lastUpdated:
            typeof parsed.lastUpdated === "string" ? parsed.lastUpdated : new Date().toISOString(),
          messages: parsed.messages.filter(isMessageRecord),
          ...(typeof parsed.summary === "string" ? { summary: parsed.summary } : {}),
          ...(parsed.kind === "main" || parsed.kind === "subagent"
            ? { kind: parsed.kind }
            : {}),
        };
      }
    } catch {}

    const lines = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const messages = new Map<string, GeminiMessageRecord>();
    const messageOrder: string[] = [];
    let metadata: Partial<GeminiConversationRecord> = {};

    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isObject(parsed)) {
        continue;
      }
      if (typeof parsed.sessionId === "string" && typeof parsed.projectHash === "string") {
        metadata = {
          ...metadata,
          sessionId: parsed.sessionId,
          projectHash: parsed.projectHash,
          ...(typeof parsed.startTime === "string" ? { startTime: parsed.startTime } : {}),
          ...(typeof parsed.lastUpdated === "string" ? { lastUpdated: parsed.lastUpdated } : {}),
          ...(typeof parsed.summary === "string" ? { summary: parsed.summary } : {}),
          ...(parsed.kind === "main" || parsed.kind === "subagent" ? { kind: parsed.kind } : {}),
        };
        continue;
      }
      if (isObject(parsed.$set)) {
        metadata = {
          ...metadata,
          ...(typeof parsed.$set.startTime === "string"
            ? { startTime: parsed.$set.startTime }
            : {}),
          ...(typeof parsed.$set.lastUpdated === "string"
            ? { lastUpdated: parsed.$set.lastUpdated }
            : {}),
          ...(typeof parsed.$set.summary === "string" ? { summary: parsed.$set.summary } : {}),
          ...(parsed.$set.kind === "main" || parsed.$set.kind === "subagent"
            ? { kind: parsed.$set.kind }
            : {}),
        };
        continue;
      }
      if (typeof parsed.$rewindTo === "string") {
        const rewindIndex = messageOrder.indexOf(parsed.$rewindTo);
        if (rewindIndex >= 0) {
          for (const id of messageOrder.splice(rewindIndex)) {
            messages.delete(id);
          }
        } else {
          messageOrder.length = 0;
          messages.clear();
        }
        continue;
      }
      if (!isMessageRecord(parsed)) {
        continue;
      }
      messages.set(parsed.id, parsed);
      messageOrder.push(parsed.id);
    }

    if (typeof metadata.sessionId !== "string" || typeof metadata.projectHash !== "string") {
      return null;
    }

    return {
      sessionId: metadata.sessionId,
      projectHash: metadata.projectHash,
      startTime: metadata.startTime ?? new Date().toISOString(),
      lastUpdated: metadata.lastUpdated ?? new Date().toISOString(),
      messages: messageOrder
        .map((id) => messages.get(id))
        .filter((message): message is GeminiMessageRecord => message !== undefined),
      ...(metadata.summary ? { summary: metadata.summary } : {}),
      ...(metadata.kind ? { kind: metadata.kind } : {}),
    };
  } catch {
    return null;
  }
}

function isGeminiJsonlSessionFile(filePath: string): boolean {
  return filePath.endsWith(".jsonl");
}

function truncateText(text: string, maxLength = 120): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function encodeGeminiFrozenHistoryCursor(cursor: GeminiFrozenHistoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeGeminiFrozenHistoryCursor(cursor: string): GeminiFrozenHistoryCursor {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      offset?: unknown;
    };
    if (
      typeof parsed.offset !== "number" ||
      !Number.isInteger(parsed.offset) ||
      parsed.offset < 0
    ) {
      throw new Error("Invalid Gemini frozen history cursor.");
    }
    return { offset: parsed.offset };
  } catch {
    throw new Error("Invalid Gemini frozen history cursor.");
  }
}

function makeGeminiFrozenHistoryBoundary(
  filePath: string,
  fileSize: number,
  mtimeMs: number,
): FrozenHistoryBoundary {
  return {
    kind: "frozen",
    sourceRevision: JSON.stringify({
      provider: "gemini",
      filePath,
      fileSize,
      mtimeMs,
    }),
  };
}

function buildStoredSessionRef(
  conversation: GeminiConversationRecord,
  filePath: string,
): StoredSessionRef {
  const firstUserMessage =
    conversation.messages.find((message) => message.type === "user")?.content ?? "";
  const preview = truncateText(extractTextFromContent(firstUserMessage) || "Gemini conversation");
  const stat = statSync(filePath);
  return {
    provider: "gemini",
    providerSessionId: conversation.sessionId,
    title: truncateText(preview, 72),
    preview,
    updatedAt: conversation.lastUpdated || stat.mtime.toISOString(),
    source: "provider_history",
  };
}

export function discoverGeminiStoredSessions(): GeminiStoredSessionRecord[] {
  const cache = loadStoredSessionMetadataCache("gemini");
  const records = new Map<string, GeminiStoredSessionRecord>();
  for (const chatsDir of scanGeminiChatsDirs()) {
    for (const filePath of listGeminiSessionFiles(chatsDir)) {
      const stats = statSync(filePath);
      const cachedRef = getCachedStoredSessionRef({
        cache,
        filePath,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
      });
      if (cachedRef) {
        records.set(cachedRef.providerSessionId, {
          ref: cachedRef,
          filePath,
          conversation: {
            sessionId: cachedRef.providerSessionId,
            projectHash: "",
            startTime: cachedRef.updatedAt ?? new Date(stats.mtimeMs).toISOString(),
            lastUpdated: cachedRef.updatedAt ?? new Date(stats.mtimeMs).toISOString(),
            messages: [],
          },
        });
        continue;
      }
      const conversation = loadGeminiConversationRecord(filePath);
      if (!conversation || conversation.kind === "subagent") {
        continue;
      }
      const ref = buildStoredSessionRef(conversation, filePath);
      setCachedStoredSessionRef({
        cache,
        filePath,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        ref,
      });
      records.set(conversation.sessionId, {
        ref,
        filePath,
        conversation,
      });
    }
  }
  writeStoredSessionMetadataCache(
    "gemini",
    new Map(
      [...records.values()].map((record) => {
        const stats = statSync(record.filePath);
        return [
          record.filePath,
          {
            ref: record.ref,
            size: stats.size,
            mtimeMs: stats.mtimeMs,
          },
        ] as const;
      }),
    ),
  );
  return [...records.values()].sort((a, b) =>
    (b.ref.updatedAt ?? "").localeCompare(a.ref.updatedAt ?? ""),
  );
}

export function findGeminiStoredSessionRecord(
  providerSessionId: string,
  cwd?: string,
): GeminiStoredSessionRecord | null {
  if (cwd) {
    for (const filePath of listGeminiSessionFiles(getChatsDirForCwd(cwd))) {
      const conversation = loadGeminiConversationRecord(filePath);
      if (conversation?.sessionId === providerSessionId) {
        return {
          ref: buildStoredSessionRef(conversation, filePath),
          filePath,
          conversation,
        };
      }
    }
  }

  for (const record of discoverGeminiStoredSessions()) {
    if (record.ref.providerSessionId === providerSessionId) {
      return record;
    }
  }
  return null;
}

function classifyGeminiToolFamily(name: string) {
  const normalized = name.toLowerCase();
  if (normalized.includes("read") || normalized.includes("open")) return "file_read" as const;
  if (normalized.includes("write")) return "file_write" as const;
  if (normalized.includes("edit") || normalized.includes("replace")) return "file_edit" as const;
  if (normalized.includes("shell") || normalized.includes("bash") || normalized.includes("run"))
    return "shell" as const;
  if (normalized.includes("search") || normalized.includes("glob") || normalized.includes("grep"))
    return "search" as const;
  if (normalized.includes("fetch")) return "web_fetch" as const;
  if (normalized.includes("web")) return "web_search" as const;
  if (normalized.includes("memory")) return "memory" as const;
  if (normalized.includes("todo")) return "todo" as const;
  if (normalized.includes("mcp")) return "mcp" as const;
  return "other" as const;
}

function toolActivitiesForMessage(message: GeminiMessageRecord, turnId: string): ProviderActivity[] {
  if (!Array.isArray(message.toolCalls)) {
    return [];
  }
  return message.toolCalls.flatMap((toolCall) => {
    const providerToolName = typeof toolCall.name === "string" ? toolCall.name : "unknown";
    const title =
      typeof toolCall.displayName === "string" ? toolCall.displayName : providerToolName;
    const tool = {
      id: toolCall.id,
      family: classifyGeminiToolFamily(providerToolName),
      providerToolName,
      title,
      ...(isObject(toolCall.args) ? { input: toolCall.args } : {}),
      ...(toolCall.result !== undefined
        ? {
            detail: {
              artifacts: [
                {
                  kind: "text" as const,
                  label: "output",
                  text: extractTextFromContent(toolCall.result) || JSON.stringify(toolCall.result),
                },
              ],
            },
          }
        : {}),
    };
    const failed =
      typeof toolCall.status === "string" &&
      ["error", "failed", "cancelled", "canceled"].includes(toolCall.status.toLowerCase());
    return [
      { type: "tool_call_started", turnId, toolCall: tool },
      failed
        ? {
            type: "tool_call_failed" as const,
            turnId,
            toolCallId: toolCall.id,
            error: extractTextFromContent(toolCall.result) || toolCall.status || "Tool failed",
          }
        : {
            type: "tool_call_completed" as const,
            turnId,
            toolCall: tool,
          },
    ];
  });
}

function conversationToEvents(params: {
  sessionId: string;
  conversation: GeminiConversationRecord;
}): RahEvent[] {
  const services = {
    eventBus: new EventBus(),
    ptyHub: new PtyHub(),
    sessionStore: new SessionStore(),
  };
  const temp = services.sessionStore.createManagedSession({
    provider: "gemini",
    providerSessionId: params.conversation.sessionId,
    launchSource: "web",
    cwd: process.cwd(),
    rootDir: process.cwd(),
    title: truncateText(params.conversation.summary ?? "Gemini session", 72),
    preview: truncateText(params.conversation.summary ?? "Gemini session"),
  });

  for (const message of params.conversation.messages) {
    const turnId = `gemini-history:${message.id}`;
    switch (message.type) {
      case "user":
        applyProviderActivity(
          services,
          temp.session.id,
          { provider: "gemini", channel: "structured_persisted", authority: "authoritative" },
          {
            type: "timeline_item",
            turnId,
            item: { kind: "user_message", text: extractTextFromContent(message.content) },
          },
        );
        break;
      case "gemini": {
        const text = extractTextFromContent(message.content);
        if (text) {
          applyProviderActivity(
            services,
            temp.session.id,
            { provider: "gemini", channel: "structured_persisted", authority: "authoritative" },
            {
              type: "timeline_item",
              turnId,
              item: { kind: "assistant_message", text, messageId: message.id },
            },
          );
        }
        for (const thought of message.thoughts ?? []) {
          const thoughtText =
            (typeof thought.text === "string" ? thought.text : "") ||
            (typeof thought.subject === "string" ? thought.subject : "");
          if (!thoughtText) {
            continue;
          }
          applyProviderActivity(
            services,
            temp.session.id,
            { provider: "gemini", channel: "structured_persisted", authority: "authoritative" },
            {
              type: "timeline_item",
              turnId,
              item: { kind: "reasoning", text: thoughtText },
            },
          );
        }
        for (const activity of toolActivitiesForMessage(message, turnId)) {
          applyProviderActivity(
            services,
            temp.session.id,
            { provider: "gemini", channel: "structured_persisted", authority: "authoritative" },
            activity,
          );
        }
        break;
      }
      case "error":
      case "warning":
      case "info": {
        const text = extractTextFromContent(message.content);
        if (!text) {
          break;
        }
        applyProviderActivity(
          services,
          temp.session.id,
          { provider: "gemini", channel: "structured_persisted", authority: "authoritative" },
          {
            type: "timeline_item",
            turnId,
            item: {
              kind: message.type === "error" ? "error" : "system",
              text,
            },
          },
        );
        break;
      }
    }
  }

  return services.eventBus
    .list({ sessionIds: [temp.session.id] })
    .map((event) => ({ ...event, sessionId: params.sessionId }));
}

function materializeGeminiConversationEvents(params: {
  sessionId: string;
  conversation: GeminiConversationRecord;
}): RahEvent[] {
  return conversationToEvents(params)
    .map((event) => ({
      ...event,
      id: `history:${event.id}`,
      seq: event.seq + 1_000_000_000,
    }))
    .sort((a, b) => a.ts.localeCompare(b.ts) || a.seq - b.seq);
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
}): GeminiHistoryCacheManifest | null {
  const previousManifest = readCachedGeminiHistoryManifest(args.record.filePath);
  if (
    !previousManifest ||
    previousManifest.sourceKind !== "jsonl" ||
    args.size < previousManifest.size
  ) {
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

function ensureGeminiHistoryCacheRevision(args: {
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

  return writeCachedGeminiHistoryEvents({
    filePath: args.record.filePath,
    size: args.size,
    mtimeMs: args.mtimeMs,
    events: materializeGeminiConversationEvents({
      sessionId: args.sessionId,
      conversation: resolveGeminiConversation(args.record),
    }),
    sourceKind: isGeminiJsonlSessionFile(args.record.filePath) ? "jsonl" : "json",
  });
}

function rebindGeminiHistoryEvents(sessionId: string, cachedEvents: readonly RahEvent[]): RahEvent[] {
  return cachedEvents.map((event, index) => ({
    ...event,
    id: `history:gemini-cache:${index + 1}`,
    seq: 1_000_000_000 + index + 1,
    sessionId,
  }));
}

function rebindGeminiHistoryWindowEvents(args: {
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

function materializeGeminiHistoryEventsFromRecord(args: {
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

function publishSessionBootstrap(
  services: RuntimeServices,
  sessionId: string,
  session: ManagedSession,
) {
  services.eventBus.publish({
    sessionId,
    type: "session.created",
    source: SYSTEM_SOURCE,
    payload: { session },
  });
  services.eventBus.publish({
    sessionId,
    type: "session.started",
    source: SYSTEM_SOURCE,
    payload: { session },
  });
}

export function resumeGeminiStoredSession(params: {
  services: RuntimeServices;
  record: GeminiStoredSessionRecord;
  cwd?: string;
  attach?: AttachSessionRequest;
}): { sessionId: string } {
  const cwd = params.cwd ?? process.cwd();
  const state = params.services.sessionStore.createManagedSession({
    provider: "gemini",
    providerSessionId: params.record.ref.providerSessionId,
    launchSource: "web",
    cwd,
    rootDir: cwd,
    ...(params.record.ref.title ? { title: params.record.ref.title } : {}),
    ...(params.record.ref.preview ? { preview: params.record.ref.preview } : {}),
    capabilities: REHYDRATED_CAPABILITIES,
  });
  params.services.sessionStore.setRuntimeState(state.session.id, "idle");
  const session = params.services.sessionStore.getSession(state.session.id)!;
  publishSessionBootstrap(params.services, state.session.id, session.session);
  if (params.attach) {
    params.services.sessionStore.attachClient({
      sessionId: state.session.id,
      clientId: params.attach.client.id,
      kind: params.attach.client.kind,
      connectionId: params.attach.client.connectionId,
      attachMode: params.attach.mode,
      focus: true,
    });
    params.services.eventBus.publish({
      sessionId: state.session.id,
      type: "session.attached",
      source: SYSTEM_SOURCE,
      payload: {
        clientId: params.attach.client.id,
        clientKind: params.attach.client.kind,
      },
    });
    if (params.attach.claimControl) {
      params.services.sessionStore.claimControl(state.session.id, params.attach.client.id);
      params.services.eventBus.publish({
        sessionId: state.session.id,
        type: "control.claimed",
        source: SYSTEM_SOURCE,
        payload: {
          clientId: params.attach.client.id,
          clientKind: params.attach.client.kind,
        },
      });
    }
  }
  return { sessionId: state.session.id };
}

export function getGeminiStoredSessionHistoryPage(params: {
  sessionId: string;
  record: GeminiStoredSessionRecord;
  beforeTs?: string;
  limit?: number;
}): SessionHistoryPageResponse {
  const all = materializeGeminiHistoryEventsFromRecord({
    sessionId: params.sessionId,
    record: params.record,
  })
    .filter((event) => (params.beforeTs ? event.ts < params.beforeTs : true))
    .sort((a, b) => a.ts.localeCompare(b.ts) || a.seq - b.seq);
  const limit = Math.max(1, params.limit ?? 1000);
  const start = Math.max(0, all.length - limit);
  const events = all.slice(start);
  return {
    sessionId: params.sessionId,
    events,
    ...(start > 0 && events[0] ? { nextBeforeTs: events[0].ts } : {}),
  };
}

export function createGeminiStoredSessionFrozenHistoryPageLoader(args: {
  sessionId: string;
  record: GeminiStoredSessionRecord;
}): FrozenHistoryPageLoader {
  const stats = statSync(args.record.filePath);
  const boundary = makeGeminiFrozenHistoryBoundary(
    args.record.filePath,
    stats.size,
    stats.mtimeMs,
  );
  let cachedTotalEvents: number | undefined;

  const pageAt = (offset: number, limit: number): FrozenHistoryPage => {
    const safeLimit = Math.max(1, limit);
    const manifest =
      loadCachedGeminiHistoryManifest({
        filePath: args.record.filePath,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
      }) ??
      ensureGeminiHistoryCacheRevision({
        sessionId: args.sessionId,
        record: args.record,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
      });
    cachedTotalEvents = manifest.totalEvents;
    const boundedOffset = Math.max(0, Math.min(offset, cachedTotalEvents));
    const start = Math.max(0, boundedOffset - safeLimit);
    const window = loadCachedGeminiHistoryWindow({
      filePath: args.record.filePath,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      startOffset: start,
      endOffset: boundedOffset,
    });
    if (!window) {
      throw new Error("Gemini history cache became unavailable while paging.");
    }
    const pageEvents = rebindGeminiHistoryWindowEvents({
      sessionId: args.sessionId,
      startOffset: start,
      events: window.events,
    });
    const nextCursor = start > 0 ? encodeGeminiFrozenHistoryCursor({ offset: start }) : undefined;
    return {
      boundary,
      events: pageEvents,
      ...(nextCursor ? { nextCursor } : {}),
      ...(pageEvents[0] ? { nextBeforeTs: pageEvents[0].ts } : {}),
    };
  };

  return {
    loadInitialPage: (limit) => pageAt(Number.MAX_SAFE_INTEGER, limit),
    loadOlderPage: (cursor, limit, frozenBoundary) => {
      if (frozenBoundary.sourceRevision !== boundary.sourceRevision) {
        throw new Error("Gemini frozen history boundary changed while paging.");
      }
      const decoded = decodeGeminiFrozenHistoryCursor(cursor);
      return pageAt(decoded.offset, limit);
    },
  };
}
