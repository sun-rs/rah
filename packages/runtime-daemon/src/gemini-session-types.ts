import type { StoredSessionRef } from "@rah/runtime-protocol";

export const REHYDRATED_CAPABILITIES = {
  livePermissions: false,
  steerInput: false,
  queuedInput: false,
  renameSession: false,
  modelSwitch: false,
  planMode: false,
  subagents: false,
} as const;

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
