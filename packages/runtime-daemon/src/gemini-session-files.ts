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
import type { RuntimeServices } from "./provider-adapter";
import { EventBus } from "./event-bus";
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

function resolveGeminiHome(): string {
  return process.env.GEMINI_CLI_HOME ?? path.join(os.homedir(), ".gemini");
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

function truncateText(text: string, maxLength = 120): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
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
  for (const event of conversationToEvents({
    sessionId: state.session.id,
    conversation: params.record.conversation,
  })) {
    params.services.eventBus.publish(event);
  }
  return { sessionId: state.session.id };
}

export function getGeminiStoredSessionHistoryPage(params: {
  sessionId: string;
  record: GeminiStoredSessionRecord;
  beforeTs?: string;
  limit?: number;
}): SessionHistoryPageResponse {
  const all = conversationToEvents({
    sessionId: params.sessionId,
    conversation: params.record.conversation,
  })
    .filter((event) => (params.beforeTs ? event.ts < params.beforeTs : true))
    .map((event) => ({
      ...event,
      id: `history:${event.id}`,
      seq: event.seq + 1_000_000_000,
    }))
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
