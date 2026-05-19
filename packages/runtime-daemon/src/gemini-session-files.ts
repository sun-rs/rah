import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AttachSessionRequest,
  RahEvent,
  SessionHistoryPageResponse,
  StoredSessionRef,
  TimelineIdentity,
  TimelineItem,
  TimelineRuntimeModel,
  ToolFamily,
} from "@rah/runtime-protocol";
import { EventBus } from "./event-bus";
import type {
  FrozenHistoryBoundary,
  FrozenHistoryPageLoader,
} from "./history-snapshots";
import {
  applyProviderActivity,
  type ProviderActivity,
  type ProviderActivityMeta,
} from "./provider-activity";
import type { RuntimeServices } from "./provider-adapter";
import { PtyHub } from "./pty-hub";
import { SessionStore } from "./session-store";
import {
  normalizeCouncilMcpToolCall,
  projectCouncilMcpToolCall,
} from "./council/council-mcp-projection";
import { runtimeDescriptorForStoredHistory } from "./session-runtime-descriptor";
import { withHistoryFileMeta } from "./stored-session-history-meta";
import { createTimelineIdentity } from "./timeline-identity";

export type GeminiToolCallRecord = {
  id: string;
  name: string;
  args?: Record<string, unknown>;
  result?: unknown;
  status?: string;
  timestamp?: string;
  displayName?: string;
  description?: string;
};

export type GeminiMessageRecord = {
  id: string;
  timestamp: string;
  type: "user" | "gemini" | "info" | "error" | "warning";
  content: unknown;
  displayContent?: unknown;
  toolCalls?: GeminiToolCallRecord[];
  thoughts?: Array<{ timestamp?: string; subject?: string; text?: string; description?: string }>;
  tokens?: {
    input?: number;
    output?: number;
    cached?: number;
    thoughts?: number;
    tool?: number;
    total?: number;
  } | null;
  model?: string;
};

export type GeminiConversationRecord = {
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

export type GeminiStoredActivityState = {
  processedMessageRevisions: Map<string, string>;
  processedToolCallRevisions: Map<string, string>;
  startedToolCallIds: Set<string>;
  terminalToolCallRevisions: Map<string, string>;
};

const SESSION_FILE_PREFIX = "session-";
const SYSTEM_SOURCE = {
  provider: "system" as const,
  channel: "system" as const,
  authority: "authoritative" as const,
};

const REHYDRATED_CAPABILITIES = {
  liveAttach: false,
  structuredTimeline: true,
  nativeTui: false,
  rawPtyInput: false,
  chatMirror: false,
  structuredControl: false,
  livePermissions: false,
  contextUsage: true,
  resumeByProvider: true,
  listProviderSessions: true,
  steerInput: false,
  queuedInput: false,
  renameSession: true,
  actions: {
    info: true,
    stop: false,
    delete: true,
    rename: "local",
  },
  modelSwitch: false,
  planMode: false,
  subagents: false,
} as const;

function resolveGeminiHome(): string {
  return process.env.GEMINI_CLI_HOME ?? path.join(os.homedir(), ".gemini");
}

export function resolveGeminiStoredSessionWatchRoots(): string[] {
  return [path.join(resolveGeminiHome(), "tmp")];
}

function normalizeDirectory(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  const withoutTrailing = trimmed.replace(/[\\/]+$/, "");
  if (withoutTrailing === "") {
    return path.parse(trimmed).root || trimmed;
  }
  if (withoutTrailing.startsWith("/private/var/")) {
    return withoutTrailing.slice("/private".length);
  }
  return withoutTrailing;
}

function projectHash(projectRoot: string): string {
  return createHash("sha256").update(projectRoot).digest("hex");
}

type GeminiProjectIndex = {
  hashToRoot: Map<string, string>;
  rootToSlugs: Map<string, Set<string>>;
};

function safeProjectSlug(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("/") || trimmed.includes("\\")) {
    return null;
  }
  return trimmed;
}

function directoryVariants(rawRoot: string | undefined): Set<string> {
  const variants = new Set<string>();
  const normalized = normalizeDirectory(rawRoot);
  if (!normalized) {
    return variants;
  }
  variants.add(normalized);
  try {
    variants.add(normalizeDirectory(realpathSync(normalized)) ?? normalized);
  } catch {}
  if (normalized.startsWith("/var/")) {
    variants.add(`/private${normalized}`);
  } else if (normalized.startsWith("/private/var/")) {
    variants.add(normalized.slice("/private".length));
  }
  return variants;
}

function addRootSlug(index: GeminiProjectIndex, root: string, slug: string): void {
  const existing = index.rootToSlugs.get(root) ?? new Set<string>();
  existing.add(slug);
  index.rootToSlugs.set(root, existing);
}

function loadGeminiProjectIndex(): GeminiProjectIndex {
  const index: GeminiProjectIndex = {
    hashToRoot: new Map(),
    rootToSlugs: new Map(),
  };
  const addRoot = (rawRoot: string | undefined, rawSlug: unknown) => {
    const slug = safeProjectSlug(rawSlug);
    const normalized = normalizeDirectory(rawRoot);
    if (!normalized) {
      return;
    }
    for (const variant of directoryVariants(normalized)) {
      index.hashToRoot.set(projectHash(variant), variant);
      if (slug) {
        addRootSlug(index, variant, slug);
      }
    }
  };
  try {
    const parsed = JSON.parse(
      readFileSync(path.join(resolveGeminiHome(), "projects.json"), "utf8"),
    ) as { projects?: Record<string, string> };
    for (const [root, slug] of Object.entries(parsed.projects ?? {})) {
      addRoot(root, slug);
    }
  } catch {}
  return index;
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

function trimBlankLines(value: string): string {
  return value
    .replace(/^(?:[ \t]*\r?\n)+/, "")
    .replace(/(?:\r?\n[ \t]*)+$/, "");
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") {
    return trimBlankLines(content);
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return trimBlankLines(
    content
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
      .join(""),
  );
}

function userDisplayText(message: GeminiMessageRecord): string {
  return textFromContent(message.displayContent) || textFromContent(message.content);
}

function conversationFromObject(parsed: unknown): GeminiConversationRecord | null {
  if (
    !isObject(parsed) ||
    typeof parsed.sessionId !== "string" ||
    typeof parsed.projectHash !== "string" ||
    !Array.isArray(parsed.messages)
  ) {
    return null;
  }
  return {
    sessionId: parsed.sessionId,
    projectHash: parsed.projectHash,
    startTime: typeof parsed.startTime === "string" ? parsed.startTime : new Date().toISOString(),
    lastUpdated: typeof parsed.lastUpdated === "string" ? parsed.lastUpdated : new Date().toISOString(),
    messages: parsed.messages.filter(isMessageRecord),
    ...(typeof parsed.summary === "string" ? { summary: parsed.summary } : {}),
    ...(parsed.kind === "main" || parsed.kind === "subagent" ? { kind: parsed.kind } : {}),
  };
}

function conversationFromJsonl(raw: string): GeminiConversationRecord | null {
  let sessionId: string | undefined;
  let projectHashValue: string | undefined;
  let startTime: string | undefined;
  let lastUpdated: string | undefined;
  let summary: string | undefined;
  let kind: GeminiConversationRecord["kind"] | undefined;
  const messages: GeminiMessageRecord[] = [];
  const messageIndexes = new Map<string, number>();

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (!isObject(parsed)) {
      continue;
    }
    if (typeof parsed.sessionId === "string") {
      sessionId = parsed.sessionId;
    }
    if (typeof parsed.projectHash === "string") {
      projectHashValue = parsed.projectHash;
    }
    if (typeof parsed.startTime === "string") {
      startTime = parsed.startTime;
    }
    if (typeof parsed.lastUpdated === "string") {
      lastUpdated = parsed.lastUpdated;
    }
    if (typeof parsed.summary === "string") {
      summary = parsed.summary;
    }
    if (parsed.kind === "main" || parsed.kind === "subagent") {
      kind = parsed.kind;
    }
    if (isObject(parsed.$set)) {
      const patch = parsed.$set;
      if (typeof patch.lastUpdated === "string") {
        lastUpdated = patch.lastUpdated;
      }
      if (typeof patch.summary === "string") {
        summary = patch.summary;
      }
      if (patch.kind === "main" || patch.kind === "subagent") {
        kind = patch.kind;
      }
    }
    if (!isMessageRecord(parsed)) {
      continue;
    }
    const existingIndex = messageIndexes.get(parsed.id);
    if (existingIndex !== undefined) {
      messages[existingIndex] = parsed;
    } else {
      messageIndexes.set(parsed.id, messages.length);
      messages.push(parsed);
    }
  }

  if (!sessionId || !projectHashValue) {
    return null;
  }
  const now = new Date().toISOString();
  return {
    sessionId,
    projectHash: projectHashValue,
    startTime: startTime ?? now,
    lastUpdated: lastUpdated ?? startTime ?? now,
    messages,
    ...(summary ? { summary } : {}),
    ...(kind ? { kind } : {}),
  };
}

function loadGeminiConversationRecord(filePath: string): GeminiConversationRecord | null {
  try {
    const raw = readFileSync(filePath, "utf8");
    if (filePath.endsWith(".jsonl")) {
      return conversationFromJsonl(raw);
    }
    return conversationFromObject(JSON.parse(raw) as unknown);
  } catch {}
  return null;
}

function listGeminiSessionFiles(chatsDir: string): string[] {
  try {
    return readdirSync(chatsDir)
      .filter((entry) => entry.startsWith(SESSION_FILE_PREFIX))
      .filter((entry) => entry.endsWith(".json") || entry.endsWith(".jsonl"))
      .map((entry) => path.join(chatsDir, entry));
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

function readGeminiProjectRootFromProjectDir(projectDir: string): string | null {
  try {
    return normalizeDirectory(
      readFileSync(path.join(projectDir, ".project_root"), "utf8").trim(),
    );
  } catch {
    return null;
  }
}

function readGeminiProjectRootForSessionFile(filePath: string): string | null {
  return readGeminiProjectRootFromProjectDir(path.dirname(path.dirname(filePath)));
}

function geminiChatsDirsForCwd(cwd: string, projectIndex: GeminiProjectIndex): string[] {
  const tmpRoot = path.join(resolveGeminiHome(), "tmp");
  const dirs = new Set<string>();
  for (const variant of directoryVariants(cwd)) {
    dirs.add(path.join(tmpRoot, projectHash(variant), "chats"));
    for (const slug of projectIndex.rootToSlugs.get(variant) ?? []) {
      dirs.add(path.join(tmpRoot, slug, "chats"));
    }
  }
  return [...dirs];
}

function geminiChatsDirMatchesCwd(chatsDir: string, cwd: string): boolean {
  const root = readGeminiProjectRootFromProjectDir(path.dirname(chatsDir));
  if (!root) {
    return false;
  }
  return directoryVariants(cwd).has(root);
}

function runtimeModelForMessage(message: GeminiMessageRecord): TimelineRuntimeModel | undefined {
  return typeof message.model === "string" && message.model.trim()
    ? { modelId: message.model.trim(), source: "native" }
    : undefined;
}

function timelineIdentity(args: {
  providerSessionId: string;
  messageId: string;
  itemKind: TimelineItem["kind"];
  itemKey?: string;
  partIndex?: number;
  origin: "live" | "history";
}): TimelineIdentity {
  return createTimelineIdentity({
    provider: "gemini",
    providerSessionId: args.providerSessionId,
    turnKey: `message:${args.messageId}`,
    itemKind: args.itemKind,
    itemKey: args.itemKey ?? args.messageId,
    origin: args.origin,
    confidence: "native",
    sourceCursor: {
      providerMessageId: args.messageId,
      ...(args.partIndex !== undefined ? { partIndex: args.partIndex } : {}),
    },
  });
}

function classifyTool(name: string): ToolFamily {
  const lower = name.toLowerCase();
  if (lower.includes("shell") || lower.includes("bash") || lower.includes("run")) {
    return "shell";
  }
  if (lower.includes("write")) {
    return "file_write";
  }
  if (lower.includes("edit") || lower.includes("replace")) {
    return "file_edit";
  }
  if (lower.includes("read") || lower.includes("open")) {
    return "file_read";
  }
  if (lower.includes("search") || lower.includes("grep") || lower.includes("glob")) {
    return "search";
  }
  if (lower.includes("mcp")) {
    return "mcp";
  }
  return "other";
}

function toolOutputText(value: unknown): string {
  const text = textFromContent(value);
  if (text) {
    return text;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toolError(value: unknown): string {
  if (Array.isArray(value)) {
    for (const item of value) {
      const error = toolError(item);
      if (error) {
        return error;
      }
    }
  }
  if (!isObject(value)) {
    return "";
  }
  if (typeof value.error === "string" && value.error.trim()) {
    return value.error.trim();
  }
  for (const child of Object.values(value)) {
    const error = toolError(child);
    if (error) {
      return error;
    }
  }
  return "";
}

function geminiToolStatus(toolCall: GeminiToolCallRecord): "started" | "completed" | "failed" {
  const status = (toolCall.status ?? "").toLowerCase();
  if (["error", "failed", "cancelled", "canceled"].includes(status) || toolError(toolCall.result) !== "") {
    return "failed";
  }
  if (["pending", "running", "started"].includes(status) && toolCall.result === undefined) {
    return "started";
  }
  return "completed";
}

function toolCallStateKey(message: GeminiMessageRecord, toolCall: GeminiToolCallRecord): string {
  return `${message.id}:${toolCall.id}`;
}

function toolCallRevision(toolCall: GeminiToolCallRecord): string {
  return JSON.stringify({
    id: toolCall.id,
    name: toolCall.name,
    args: toolCall.args,
    result: toolCall.result,
    status: toolCall.status,
    timestamp: toolCall.timestamp,
    displayName: toolCall.displayName,
    description: toolCall.description,
  });
}

function toolActivities(
  message: GeminiMessageRecord,
  turnId: string,
  providerSessionId: string,
  origin: "live" | "history",
  state?: GeminiStoredActivityState,
): ProviderActivity[] {
  return (message.toolCalls ?? []).flatMap((toolCall): ProviderActivity[] => {
    const stateKey = toolCallStateKey(message, toolCall);
    const revision = toolCallRevision(toolCall);
    if (state) {
      const previousRevision = state.processedToolCallRevisions.get(stateKey);
      if (previousRevision === revision) {
        return [];
      }
      state.processedToolCallRevisions.set(stateKey, revision);
    }
    const providerToolName = toolCall.name || "unknown";
    const lifecycleStatus = geminiToolStatus(toolCall);
    const councilMcpToolCall = normalizeCouncilMcpToolCall({
      provider: "gemini",
      callId: toolCall.id,
      toolName: providerToolName,
      status: lifecycleStatus,
      providerSessionId,
      ...(toolCall.args ? { callArgs: toolCall.args } : {}),
      ...(toolCall.result !== undefined ? { output: toolCall.result } : {}),
    });
    if (councilMcpToolCall) {
      const projection = projectCouncilMcpToolCall(councilMcpToolCall);
      if (projection.visibility === "hidden") {
        return [];
      }
      if (projection.activity.type !== "timeline_item") {
        return [projection.activity];
      }
      const runtimeModel = runtimeModelForMessage(message);
      const activity: ProviderActivity = {
        type: "timeline_item",
        turnId,
        item: {
          ...projection.activity.item,
          ...(projection.activity.item.kind === "assistant_message" && runtimeModel ? { runtimeModel } : {}),
        },
        identity: timelineIdentity({
          providerSessionId,
          messageId: message.id,
          itemKind: projection.activity.item.kind,
          itemKey: `${message.id}:tool:${toolCall.id}:projection`,
          origin,
        }),
      };
      return [activity];
    }
    const tool = {
      id: toolCall.id,
      family: classifyTool(providerToolName),
      providerToolName,
      title: toolCall.displayName || providerToolName,
      ...(toolCall.args ? { input: toolCall.args } : {}),
      ...(toolCall.result !== undefined
        ? {
            detail: {
              artifacts: [{ kind: "text" as const, label: "output", text: toolOutputText(toolCall.result) }],
            },
          }
        : {}),
    };
    const error = toolError(toolCall.result);
    const failed =
      error !== "" ||
      ["error", "failed", "cancelled", "canceled"].includes((toolCall.status ?? "").toLowerCase());
    const started: ProviderActivity = { type: "tool_call_started", turnId, toolCall: tool };
    if (lifecycleStatus === "started") {
      if (state?.startedToolCallIds.has(stateKey)) {
        return [];
      }
      state?.startedToolCallIds.add(stateKey);
      return [started];
    }
    const terminal: ProviderActivity = failed
      ? { type: "tool_call_failed", turnId, toolCallId: toolCall.id, error: error || "Tool failed" }
      : { type: "tool_call_completed", turnId, toolCall: tool };
    if (!state) {
      return [started, terminal];
    }
    const activities: ProviderActivity[] = [];
    if (!state.startedToolCallIds.has(stateKey)) {
      state.startedToolCallIds.add(stateKey);
      activities.push(started);
    }
    const terminalRevision = `${lifecycleStatus}:${revision}`;
    if (state.terminalToolCallRevisions.get(stateKey) !== terminalRevision) {
      state.terminalToolCallRevisions.set(stateKey, terminalRevision);
      activities.push(terminal);
    }
    return activities;
  });
}

function messageRevision(message: GeminiMessageRecord): string {
  return JSON.stringify({
    id: message.id,
    timestamp: message.timestamp,
    type: message.type,
    content: message.content,
    displayContent: message.displayContent,
    toolCalls: message.toolCalls,
    thoughts: message.thoughts,
    tokens: message.tokens,
    model: message.model,
  });
}

function activityItems(
  conversation: GeminiConversationRecord,
  origin: "live" | "history",
  options: {
    messageIds?: ReadonlySet<string>;
    state?: GeminiStoredActivityState;
  } = {},
) {
  const items: Array<{ messageId: string; revision: string; meta: ProviderActivityMeta; activity: ProviderActivity }> = [];
  const push = (message: GeminiMessageRecord, activity: ProviderActivity) => {
    items.push({
      messageId: message.id,
      revision: messageRevision(message),
      meta: {
        provider: "gemini",
        channel: "structured_persisted",
        authority: "authoritative",
        ts: message.timestamp,
      },
      activity,
    });
  };
  for (const message of conversation.messages) {
    if (options.messageIds && !options.messageIds.has(message.id)) {
      continue;
    }
    const turnId = `gemini:${message.id}`;
    if (message.type === "user") {
      push(message, {
        type: "timeline_item",
        turnId,
        item: { kind: "user_message", text: userDisplayText(message), messageId: message.id },
        identity: timelineIdentity({
          providerSessionId: conversation.sessionId,
          messageId: message.id,
          itemKind: "user_message",
          origin,
        }),
      });
      continue;
    }
    if (message.type === "gemini") {
      const runtimeModel = runtimeModelForMessage(message);
      for (const [index, thought] of (message.thoughts ?? []).entries()) {
        const thoughtText = thought.text || thought.description || thought.subject || "";
        if (!thoughtText.trim()) {
          continue;
        }
        push(message, {
          type: "timeline_item",
          turnId,
          item: {
            kind: "reasoning",
            text: thoughtText,
            ...(runtimeModel ? { runtimeModel } : {}),
          },
          identity: timelineIdentity({
            providerSessionId: conversation.sessionId,
            messageId: message.id,
            itemKind: "reasoning",
            itemKey: `${message.id}:thought:${index}`,
            partIndex: index,
            origin,
          }),
        });
      }
      const text = textFromContent(message.content);
      if (text) {
        push(message, {
          type: "timeline_item",
          turnId,
          item: {
            kind: "assistant_message",
            text,
            messageId: message.id,
            ...(runtimeModel ? { runtimeModel } : {}),
          },
          identity: timelineIdentity({
            providerSessionId: conversation.sessionId,
            messageId: message.id,
            itemKind: "assistant_message",
            origin,
          }),
        });
      }
      for (const activity of toolActivities(message, turnId, conversation.sessionId, origin, options.state)) {
        push(message, activity);
      }
      continue;
    }
    const text = textFromContent(message.content);
    if (!text) {
      continue;
    }
    push(message, {
      type: "timeline_item",
      turnId,
      item: { kind: message.type === "error" ? "error" : "system", text },
      identity: timelineIdentity({
        providerSessionId: conversation.sessionId,
        messageId: message.id,
        itemKind: message.type === "error" ? "error" : "system",
        origin,
      }),
    });
  }
  return items;
}

function materializeEvents(params: {
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
    title: params.conversation.summary ?? "Gemini session",
    preview: params.conversation.summary ?? "Gemini session",
    runtime: runtimeDescriptorForStoredHistory(),
  });
  for (const item of activityItems(params.conversation, "history")) {
    applyProviderActivity(services, temp.session.id, item.meta, item.activity);
  }
  return services.eventBus
    .list({ sessionIds: [temp.session.id] })
    .map((event) => ({ ...event, id: `history:${event.id}`, sessionId: params.sessionId, seq: event.seq + 1_000_000_000 }))
    .sort((a, b) => a.ts.localeCompare(b.ts) || a.seq - b.seq);
}

function recordFromFile(filePath: string, projectIndex: GeminiProjectIndex): GeminiStoredSessionRecord | null {
  const conversation = loadGeminiConversationRecord(filePath);
  if (!conversation) {
    return null;
  }
  const rootDir =
    projectIndex.hashToRoot.get(conversation.projectHash) ??
    readGeminiProjectRootForSessionFile(filePath) ??
    undefined;
  const firstUser = conversation.messages.find((message) => message.type === "user");
  const firstAssistant = conversation.messages.find((message) => message.type === "gemini");
  const preview = firstAssistant
    ? textFromContent(firstAssistant.content)
    : firstUser
      ? userDisplayText(firstUser)
      : conversation.summary;
  const ref: StoredSessionRef = {
    provider: "gemini",
    providerSessionId: conversation.sessionId,
    ...(rootDir ? { cwd: rootDir, rootDir } : {}),
    title: conversation.summary || (firstUser ? userDisplayText(firstUser).slice(0, 80) : "Gemini session"),
    ...(preview ? { preview: preview.slice(0, 180) } : {}),
    createdAt: conversation.startTime,
    updatedAt: conversation.lastUpdated,
    lastUsedAt: conversation.lastUpdated,
    source: "provider_history",
  };
  const stats = statSync(filePath);
  return {
    ref: withHistoryFileMeta(ref, filePath, stats, { messages: conversation.messages.length }),
    filePath,
    conversation,
  };
}

function geminiRecordRecentTimestamp(record: GeminiStoredSessionRecord): string {
  return record.ref.lastUsedAt ?? record.ref.updatedAt ?? record.ref.createdAt ?? "";
}

function compareGeminiStoredSessionRecords(
  left: GeminiStoredSessionRecord,
  right: GeminiStoredSessionRecord,
): number {
  const timestampDelta = geminiRecordRecentTimestamp(right).localeCompare(geminiRecordRecentTimestamp(left));
  if (timestampDelta !== 0) {
    return timestampDelta;
  }
  const messageDelta =
    (right.ref.historyMeta?.messages ?? right.conversation.messages.length) -
    (left.ref.historyMeta?.messages ?? left.conversation.messages.length);
  if (messageDelta !== 0) {
    return messageDelta;
  }
  const byteDelta = (right.ref.historyMeta?.bytes ?? 0) - (left.ref.historyMeta?.bytes ?? 0);
  if (byteDelta !== 0) {
    return byteDelta;
  }
  return left.filePath.localeCompare(right.filePath);
}

function dedupeGeminiStoredSessionRecords(records: GeminiStoredSessionRecord[]): GeminiStoredSessionRecord[] {
  const byProviderSessionId = new Map<string, GeminiStoredSessionRecord>();
  for (const record of records) {
    const existing = byProviderSessionId.get(record.ref.providerSessionId);
    if (!existing || compareGeminiStoredSessionRecords(record, existing) < 0) {
      byProviderSessionId.set(record.ref.providerSessionId, record);
    }
  }
  return [...byProviderSessionId.values()].sort(compareGeminiStoredSessionRecords);
}

export function discoverGeminiStoredSessions(cwd?: string): GeminiStoredSessionRecord[] {
  const projectIndex = loadGeminiProjectIndex();
  const dirs = cwd ? geminiChatsDirsForCwd(cwd, projectIndex) : scanGeminiChatsDirs();
  let records = dirs
    .flatMap(listGeminiSessionFiles)
    .flatMap((filePath) => {
      const record = recordFromFile(filePath, projectIndex);
      return record ? [record] : [];
    });
  if (cwd && records.length === 0) {
    records = scanGeminiChatsDirs()
      .filter((chatsDir) => geminiChatsDirMatchesCwd(chatsDir, cwd))
      .flatMap(listGeminiSessionFiles)
      .flatMap((filePath) => {
        const record = recordFromFile(filePath, projectIndex);
        return record ? [record] : [];
      });
  }
  return dedupeGeminiStoredSessionRecords(records);
}

export function findGeminiStoredSessionRecord(providerSessionId: string, cwd?: string): GeminiStoredSessionRecord | undefined {
  return discoverGeminiStoredSessions(cwd).find((record) => record.ref.providerSessionId === providerSessionId)
    ?? discoverGeminiStoredSessions().find((record) => record.ref.providerSessionId === providerSessionId);
}

export function isGeminiStoredSessionRecordResumable(record: GeminiStoredSessionRecord): boolean {
  return record.conversation.kind !== "subagent";
}

export function createGeminiStoredActivityState(): GeminiStoredActivityState {
  return {
    processedMessageRevisions: new Map(),
    processedToolCallRevisions: new Map(),
    startedToolCallIds: new Set(),
    terminalToolCallRevisions: new Map(),
  };
}

function loadCurrentGeminiConversation(record: GeminiStoredSessionRecord): GeminiConversationRecord {
  const conversation = loadGeminiConversationRecord(record.filePath);
  if (!conversation || conversation.sessionId !== record.ref.providerSessionId) {
    throw new Error("Gemini conversation file could not be loaded for the bound provider session.");
  }
  return conversation;
}

export function readGeminiStoredSessionActivityBatch(params: {
  record: GeminiStoredSessionRecord;
  state: GeminiStoredActivityState;
}) {
  const conversation = loadCurrentGeminiConversation(params.record);
  const changedMessageIds = new Set<string>();
  for (const message of conversation.messages) {
    const revision = messageRevision(message);
    if (params.state.processedMessageRevisions.get(message.id) !== revision) {
      changedMessageIds.add(message.id);
      params.state.processedMessageRevisions.set(message.id, revision);
    }
  }
  return activityItems(conversation, "live", {
    messageIds: changedMessageIds,
    state: params.state,
  })
    .map((item) => ({ meta: item.meta, activity: item.activity }));
}

export function resumeGeminiStoredSession(params: {
  services: RuntimeServices;
  record: GeminiStoredSessionRecord;
  cwd?: string;
  attach?: AttachSessionRequest;
}): { sessionId: string } {
  const cwd = params.cwd ?? params.record.ref.cwd ?? process.cwd();
  const state = params.services.sessionStore.createManagedSession({
    provider: "gemini",
    providerSessionId: params.record.ref.providerSessionId,
    launchSource: "web",
    cwd,
    rootDir: params.record.ref.rootDir ?? cwd,
    ...(params.record.ref.title !== undefined ? { title: params.record.ref.title } : {}),
    ...(params.record.ref.preview !== undefined ? { preview: params.record.ref.preview } : {}),
    capabilities: REHYDRATED_CAPABILITIES,
    runtime: runtimeDescriptorForStoredHistory(),
  });
  params.services.sessionStore.setRuntimeState(state.session.id, "idle");
  const session = params.services.sessionStore.getSession(state.session.id)!;
  params.services.eventBus.publish({
    sessionId: state.session.id,
    type: "session.created",
    source: SYSTEM_SOURCE,
    payload: { session: session.session },
  });
  params.services.eventBus.publish({
    sessionId: state.session.id,
    type: "session.started",
    source: SYSTEM_SOURCE,
    payload: { session: session.session },
  });
  if (params.attach) {
    params.services.sessionStore.attachClient({
      sessionId: state.session.id,
      clientId: params.attach.client.id,
      kind: params.attach.client.kind,
      connectionId: params.attach.client.connectionId,
      attachMode: params.attach.mode,
      focus: true,
    });
  }
  return { sessionId: state.session.id };
}

export function getGeminiStoredSessionHistoryPage(params: {
  sessionId: string;
  record: GeminiStoredSessionRecord;
  beforeTs?: string;
  limit?: number;
}): SessionHistoryPageResponse {
  const all = materializeEvents({
    sessionId: params.sessionId,
    conversation: loadCurrentGeminiConversation(params.record),
  }).filter((event) => (params.beforeTs ? event.ts < params.beforeTs : true));
  const limit = Math.max(1, params.limit ?? 1000);
  const start = Math.max(0, all.length - limit);
  const events = all.slice(start);
  return {
    sessionId: params.sessionId,
    events,
    ...(start > 0 && events[0] ? { nextBeforeTs: events[0].ts } : {}),
  };
}

function boundary(record: GeminiStoredSessionRecord): FrozenHistoryBoundary {
  const stats = statSync(record.filePath);
  return {
    kind: "frozen",
    sourceRevision: JSON.stringify({
      provider: "gemini",
      filePath: record.filePath,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
    }),
  };
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): number {
  const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { offset?: unknown };
  if (typeof parsed.offset !== "number" || !Number.isInteger(parsed.offset) || parsed.offset < 0) {
    throw new Error("Invalid Gemini history cursor.");
  }
  return parsed.offset;
}

export function createGeminiStoredSessionFrozenHistoryPageLoader(args: {
  sessionId: string;
  record: GeminiStoredSessionRecord;
}): FrozenHistoryPageLoader {
  const frozenBoundary = boundary(args.record);
  const conversation = loadCurrentGeminiConversation(args.record);
  const allEvents = materializeEvents({
    sessionId: args.sessionId,
    conversation,
  });
  const pageAt = (offset: number, limit: number) => {
    const boundedOffset = Math.max(0, Math.min(offset, allEvents.length));
    const start = Math.max(0, boundedOffset - Math.max(1, limit));
    const events = allEvents.slice(start, boundedOffset);
    return {
      boundary: frozenBoundary,
      events,
      ...(start > 0 ? { nextCursor: encodeCursor(start) } : {}),
      ...(events[0] ? { nextBeforeTs: events[0].ts } : {}),
    };
  };
  return {
    loadInitialPage: (limit) => pageAt(allEvents.length, limit),
    loadOlderPage: (cursor, limit, incomingBoundary) => {
      if (incomingBoundary.sourceRevision !== frozenBoundary.sourceRevision) {
        throw new Error("Gemini frozen history boundary changed while paging.");
      }
      return pageAt(decodeCursor(cursor), limit);
    },
  };
}
