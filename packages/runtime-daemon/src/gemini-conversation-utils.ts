import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { RahEvent, TimelineIdentity } from "@rah/runtime-protocol";
import { EventBus } from "./event-bus";
import { PtyHub } from "./pty-hub";
import { applyProviderActivity, type ProviderActivity } from "./provider-activity";
import { SessionStore } from "./session-store";
import { createGeminiTimelineIdentity } from "./gemini-timeline-identity";
import type {
  GeminiConversationRecord,
  GeminiMessageRecord,
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

export function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") {
    return trimGeminiContentBlankLines(content);
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const text = content
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
    .join("");
  return trimGeminiContentBlankLines(text);
}

export function extractGeminiUserDisplayText(message: Pick<GeminiMessageRecord, "content" | "displayContent">): string {
  return extractTextFromContent(message.displayContent) || extractTextFromContent(message.content);
}

function trimGeminiContentBlankLines(value: string): string {
  if (!value.trim()) {
    return "";
  }
  return value
    .replace(/^(?:[ \t]*\r?\n)+/, "")
    .replace(/(?:\r?\n[ \t]*)+$/, "");
}

export function hashGeminiMessages(messages: readonly GeminiMessageRecord[]): string {
  const hash = createHash("sha256");
  for (const message of messages) {
    hash.update(message.id);
    hash.update("\u0000");
    hash.update(message.timestamp);
    hash.update("\u0000");
    hash.update(message.type);
    hash.update("\u0000");
    hash.update(JSON.stringify(message.displayContent ?? null));
    hash.update("\u0000");
    hash.update(JSON.stringify(message.content ?? null));
    hash.update("\u0000");
    hash.update(JSON.stringify(message.toolCalls ?? null));
    hash.update("\u0000");
    hash.update(JSON.stringify(message.thoughts ?? null));
    hash.update("\u0000");
    hash.update(JSON.stringify(message.tokens ?? null));
    hash.update("\u0000");
    hash.update(JSON.stringify(message.model ?? null));
    hash.update("\u0000");
  }
  return hash.digest("hex");
}

export function loadGeminiConversationRecord(filePath: string): GeminiConversationRecord | null {
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
      if (!messages.has(parsed.id)) {
        messageOrder.push(parsed.id);
      }
      messages.set(parsed.id, parsed);
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

export function isGeminiJsonlSessionFile(filePath: string): boolean {
  return filePath.endsWith(".jsonl");
}

export function truncateText(text: string, maxLength = 120): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
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

function extractGeminiToolError(value: unknown): string {
  if (Array.isArray(value)) {
    for (const item of value) {
      const error = extractGeminiToolError(item);
      if (error) return error;
    }
    return "";
  }
  if (!isObject(value)) {
    return "";
  }
  if (typeof value.error === "string" && value.error.trim()) {
    return value.error.trim();
  }
  for (const child of Object.values(value)) {
    const error = extractGeminiToolError(child);
    if (error) return error;
  }
  return "";
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
    const resultError = extractGeminiToolError(toolCall.result);
    const failed =
      resultError !== "" ||
      (typeof toolCall.status === "string" &&
        ["error", "failed", "cancelled", "canceled"].includes(toolCall.status.toLowerCase()));
    return [
      { type: "tool_call_started", turnId, toolCall: tool },
      failed
        ? {
            type: "tool_call_failed" as const,
            turnId,
            toolCallId: toolCall.id,
            error:
              resultError || extractTextFromContent(toolCall.result) || toolCall.status || "Tool failed",
          }
        : {
            type: "tool_call_completed" as const,
            turnId,
            toolCall: tool,
          },
    ];
  });
}

function timelineIdentityProps(identity: TimelineIdentity | undefined): { identity?: TimelineIdentity } {
  return identity !== undefined ? { identity } : {};
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
            item: { kind: "user_message", text: extractGeminiUserDisplayText(message) },
            ...timelineIdentityProps(createGeminiTimelineIdentity({
              providerSessionId: params.conversation.sessionId,
              messageId: message.id,
              itemKind: "user_message",
              origin: "history",
            })),
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
              ...timelineIdentityProps(createGeminiTimelineIdentity({
                providerSessionId: params.conversation.sessionId,
                messageId: message.id,
                itemKind: "assistant_message",
                origin: "history",
              })),
            },
          );
        }
        for (const [thoughtIndex, thought] of (message.thoughts ?? []).entries()) {
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
              ...timelineIdentityProps(createGeminiTimelineIdentity({
                providerSessionId: params.conversation.sessionId,
                messageId: message.id,
                itemKind: "reasoning",
                origin: "history",
                partIndex: thoughtIndex + 1,
              })),
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
            ...timelineIdentityProps(createGeminiTimelineIdentity({
              providerSessionId: params.conversation.sessionId,
              messageId: message.id,
              itemKind: message.type === "error" ? "error" : "system",
              origin: "history",
            })),
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

export function materializeGeminiConversationEvents(params: {
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
