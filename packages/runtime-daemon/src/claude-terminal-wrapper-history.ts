import { randomUUID } from "node:crypto";
import type { ContextUsage } from "@rah/runtime-protocol";
import type { ProviderActivity } from "./provider-activity";

export type ClaudeRawRecord =
  | {
      type: "user";
      uuid: string;
      timestamp?: string;
      cwd?: string;
      sessionId?: string;
      message: {
        role?: string;
        content: unknown;
      };
    }
  | {
      type: "assistant";
      uuid: string;
      timestamp?: string;
      cwd?: string;
      sessionId?: string;
      message?: {
        id?: string;
        role?: string;
        content: unknown;
        stop_reason?: string | null;
        usage?: {
          input_tokens?: number;
          cache_creation_input_tokens?: number;
          cache_read_input_tokens?: number;
          output_tokens?: number;
        };
      };
    }
  | {
      type: "system";
      uuid: string;
      subtype?: string;
      timestamp?: string;
      cwd?: string;
      sessionId?: string;
      error?: unknown;
    };

function extractTextParts(content: unknown): string[] {
  if (typeof content === "string") {
    const text = trimClaudeTranscriptBlankLines(content);
    return text.trim() ? [text] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object" || Array.isArray(block)) {
      continue;
    }
    const record = block as Record<string, unknown>;
    if (typeof record.text === "string" && record.text.trim()) {
      parts.push(trimClaudeTranscriptBlankLines(record.text));
    }
  }
  return parts;
}

function trimClaudeTranscriptBlankLines(value: string): string {
  return value
    .replace(/^(?:[ \t]*\r?\n)+/, "")
    .replace(/(?:\r?\n[ \t]*)+$/, "");
}

function normalizeClaudeTranscriptText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function isClaudeInterruptPlaceholderText(value: unknown): boolean {
  const normalized = normalizeClaudeTranscriptText(value);
  return normalized !== null && /^\[Request interrupted by user(?:[^\]]*)\]$/.test(normalized);
}

function isClaudeNoResponsePlaceholderText(value: unknown): boolean {
  return normalizeClaudeTranscriptText(value) === "No response requested.";
}

function isClaudeLocalCommandTranscriptText(value: unknown): boolean {
  const normalized = normalizeClaudeTranscriptText(value);
  return (
    normalized !== null &&
    /^<(?:local-command-caveat|local-command-stdout|command-name|command-message|command-args)>[\s\S]*<\/(?:local-command-caveat|local-command-stdout|command-name|command-message|command-args)>$/.test(
      normalized,
    )
  );
}

function isClaudeTranscriptNoiseText(value: unknown): boolean {
  return (
    isClaudeInterruptPlaceholderText(value) ||
    isClaudeNoResponsePlaceholderText(value) ||
    isClaudeLocalCommandTranscriptText(value)
  );
}

function isToolResultOnlyContent(content: unknown): boolean {
  if (!Array.isArray(content) || content.length === 0) {
    return false;
  }
  return content.every(
    (block) =>
      block &&
      typeof block === "object" &&
      !Array.isArray(block) &&
      (block as Record<string, unknown>).type === "tool_result",
  );
}

export function extractUserMessageText(content: unknown): string | null {
  if (isToolResultOnlyContent(content)) {
    return null;
  }
  const text = trimClaudeTranscriptBlankLines(extractTextParts(content)
    .filter((part) => !isClaudeTranscriptNoiseText(part))
    .join("\n"));
  return text || null;
}

export function extractAssistantMessageText(content: unknown): string | null {
  const text = trimClaudeTranscriptBlankLines(extractTextParts(content)
    .filter((part) => !isClaudeTranscriptNoiseText(part))
    .join("\n"));
  return text || null;
}

export function safeParseClaudeRecord(line: string): ClaudeRawRecord | null {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (parsed.type === "user" && typeof parsed.uuid === "string" && parsed.message) {
      return parsed as ClaudeRawRecord;
    }
    if (parsed.type === "assistant" && typeof parsed.uuid === "string") {
      return parsed as ClaudeRawRecord;
    }
    if (parsed.type === "system" && typeof parsed.uuid === "string") {
      return parsed as ClaudeRawRecord;
    }
    return null;
  } catch {
    return null;
  }
}

export function usageFromAssistant(
  record: Extract<ClaudeRawRecord, { type: "assistant" }>,
): ContextUsage | undefined {
  const usage = record.message?.usage;
  if (!usage) {
    return undefined;
  }
  return {
    ...(typeof usage.input_tokens === "number" ? { inputTokens: usage.input_tokens } : {}),
    ...(typeof usage.cache_creation_input_tokens === "number"
      ? { cachedInputTokens: usage.cache_creation_input_tokens }
      : typeof usage.cache_read_input_tokens === "number"
        ? { cachedInputTokens: usage.cache_read_input_tokens }
        : {}),
    ...(typeof usage.output_tokens === "number" ? { outputTokens: usage.output_tokens } : {}),
  };
}

export function toolActivitiesFromAssistantRecord(
  record: Extract<ClaudeRawRecord, { type: "assistant" }>,
  turnId?: string,
): ProviderActivity[] {
  const content = Array.isArray(record.message?.content) ? record.message.content : [];
  const activities: ProviderActivity[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object" || Array.isArray(block)) {
      continue;
    }
    const typedBlock = block as Record<string, unknown>;
    if (typedBlock.type !== "tool_use") {
      continue;
    }
    activities.push({
      type: "tool_call_completed",
      ...(turnId ? { turnId } : {}),
      toolCall: {
        id: typeof typedBlock.id === "string" ? typedBlock.id : `claude-tool-${randomUUID()}`,
        family: "other",
        providerToolName:
          typeof typedBlock.name === "string" ? typedBlock.name : "unknown",
        title: typeof typedBlock.name === "string" ? typedBlock.name : "unknown",
        ...(typedBlock.input &&
        typeof typedBlock.input === "object" &&
        !Array.isArray(typedBlock.input)
          ? { input: typedBlock.input as Record<string, unknown> }
          : {}),
      },
    });
  }
  return activities;
}

export function sliceUnprocessedLines(
  content: string,
  processedLineCount: number,
): { lines: string[]; nextProcessedLineCount: number } {
  const allLines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return {
    lines: allLines.slice(processedLineCount),
    nextProcessedLineCount: allLines.length,
  };
}
