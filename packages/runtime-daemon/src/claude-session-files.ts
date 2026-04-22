import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
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
import { selectSemanticRecentWindow } from "./semantic-history-window";
import { readLeadingLines, readTrailingLinesWindow } from "./file-snippets";
import type {
  FrozenHistoryBoundary,
  FrozenHistoryPageLoader,
} from "./history-snapshots";
import { createLineHistoryWindowTranslator } from "./line-history-checkpoint";
import { createLineFrozenHistoryPageLoader } from "./line-history-pager";
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

const INTERNAL_CLAUDE_EVENT_TYPES = new Set([
  "file-history-snapshot",
  "change",
  "queue-operation",
]);

type ClaudeUsage = {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
};

type ClaudeRawRecord =
  | {
      type: "user";
      uuid: string;
      parentUuid?: string | null;
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
      parentUuid?: string | null;
      timestamp?: string;
      cwd?: string;
      sessionId?: string;
      requestId?: string;
      message?: {
        role?: string;
        content: unknown;
        usage?: ClaudeUsage;
      };
    }
  | {
      type: "summary";
      leafUuid: string;
      summary: string;
      timestamp?: string;
      cwd?: string;
      sessionId?: string;
    }
  | {
      type: "system";
      uuid: string;
      subtype?: string;
      timestamp?: string;
      cwd?: string;
      sessionId?: string;
      model?: string;
      tools?: string[];
      error?: unknown;
      durationMs?: number;
    };

export type ClaudeStoredSessionRecord = {
  ref: StoredSessionRef;
  filePath: string;
};

function resolveClaudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
}

export function resolveClaudeStoredSessionWatchRoots(): string[] {
  return [path.join(resolveClaudeConfigDir(), "projects")];
}

function getClaudeProjectDir(cwd: string): string {
  const projectId = path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");
  return path.join(resolveClaudeConfigDir(), "projects", projectId);
}

function expandClaudeProjectDirs(cwd: string): string[] {
  const candidates = new Set<string>();
  const resolved = path.resolve(cwd);
  candidates.add(getClaudeProjectDir(resolved));
  try {
    candidates.add(getClaudeProjectDir(realpathSync(resolved)));
  } catch {
    // Ignore realpath failures for removed or synthetic working directories.
  }
  if (resolved.startsWith("/var/")) {
    candidates.add(getClaudeProjectDir(`/private${resolved}`));
  } else if (resolved.startsWith("/private/var/")) {
    candidates.add(getClaudeProjectDir(resolved.slice("/private".length)));
  }
  return [...candidates];
}

function normalizeDirectory(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/[\\/]+$/, "");
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

function isClaudeLocalCommandStdout(value: unknown): boolean {
  const normalized = normalizeClaudeTranscriptText(value);
  return (
    normalized !== null &&
    /^\s*<local-command-stdout>[\s\S]*<\/local-command-stdout>\s*$/.test(normalized)
  );
}

function isClaudeTranscriptNoiseText(value: unknown): boolean {
  return (
    isClaudeInterruptPlaceholderText(value) ||
    isClaudeNoResponsePlaceholderText(value) ||
    isClaudeLocalCommandStdout(value)
  );
}

function collectClaudeTextContentParts(content: unknown): string[] {
  if (typeof content === "string") {
    const normalized = normalizeClaudeTranscriptText(content);
    return normalized ? [normalized] : [];
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
    const text = normalizeClaudeTranscriptText(record.text);
    if (text) {
      parts.push(text);
      continue;
    }
    const input = normalizeClaudeTranscriptText(record.input);
    if (input) {
      parts.push(input);
    }
  }
  return parts;
}

function isClaudeTranscriptNoiseContent(content: unknown): boolean {
  const parts = collectClaudeTextContentParts(content);
  return parts.length > 0 && parts.every((part) => isClaudeTranscriptNoiseText(part));
}

function extractUserMessageText(content: unknown): string | null {
  if (typeof content === "string") {
    const normalized = content.trim();
    if (!normalized || isClaudeTranscriptNoiseText(normalized)) {
      return null;
    }
    return normalized;
  }
  const parts = collectClaudeTextContentParts(content).filter(
    (part) => !isClaudeTranscriptNoiseText(part),
  );
  if (parts.length === 0) {
    return null;
  }
  return parts.join("\n").trim() || null;
}

function extractAssistantMessageText(content: unknown): string | null {
  const parts = collectClaudeTextContentParts(content).filter(
    (part) => !isClaudeTranscriptNoiseText(part),
  );
  if (parts.length === 0) {
    return null;
  }
  return parts.join("\n").trim() || null;
}

function truncateText(text: string, maxLength = 120): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function makeClaudeFrozenHistoryBoundary(filePath: string, endOffset: number): FrozenHistoryBoundary {
  return {
    kind: "frozen",
    sourceRevision: JSON.stringify({
      provider: "claude",
      filePath,
      endOffset,
    }),
  };
}

function readClaudeFrozenHistoryWindow(args: {
  sessionId: string;
  record: ClaudeStoredSessionRecord;
  endOffset: number;
  limit: number;
}): { startOffset: number; events: RahEvent[] } {
  let lineBudget = Math.max(args.limit * 4, 200);
  let lastStartOffset = args.endOffset;
  let events: RahEvent[] = [];

  for (;;) {
    const window = readTrailingLinesWindow(args.record.filePath, {
      endOffset: args.endOffset,
      maxLines: lineBudget,
    });
    const previousStartOffset = lastStartOffset;
    const parsed = window.lines
      .map(safeParseClaudeRecord)
      .filter((record): record is ClaudeRawRecord => Boolean(record));
    events = translateClaudeRecords(args.sessionId, parsed)
      .sort((left, right) => left.ts.localeCompare(right.ts) || left.seq - right.seq);
    lastStartOffset = window.startOffset;
    if (
      events.length >= args.limit ||
      window.startOffset === 0 ||
      window.startOffset === previousStartOffset
    ) {
      break;
    }
    lineBudget *= 2;
    if (lineBudget >= 8192) {
      break;
    }
  }

  return {
    startOffset: lastStartOffset,
    events,
  };
}

export function createClaudeStoredSessionFrozenHistoryPageLoader(args: {
  sessionId: string;
  record: ClaudeStoredSessionRecord;
}): FrozenHistoryPageLoader {
  const snapshotEndOffset = statSync(args.record.filePath).size;
  const boundary = makeClaudeFrozenHistoryBoundary(args.record.filePath, snapshotEndOffset);
  const translateWindow = createLineHistoryWindowTranslator({
    sessionId: args.sessionId,
    findSafeBoundaryIndex: (lines) =>
      lines.findIndex((line) => safeParseClaudeRecord(line)?.type === "user"),
    translateLines: (lines) =>
      translateClaudeRecords(
        args.sessionId,
        lines.map(safeParseClaudeRecord).filter((record): record is ClaudeRawRecord => Boolean(record)),
      ),
  });
  return createLineFrozenHistoryPageLoader({
    boundary,
    snapshotEndOffset,
    readWindow: ({ endOffset, lineBudget }) => {
      const window = readTrailingLinesWindow(args.record.filePath, {
        endOffset,
        maxLines: Math.max(lineBudget, 1),
      });
      return {
        startOffset: window.startOffset,
        events: translateWindow(window.endOffset, window.lines),
      };
    },
    selectPage: selectSemanticRecentWindow,
  });
}

function safeParseClaudeRecord(line: string): ClaudeRawRecord | null {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (!parsed.type || typeof parsed.type !== "string") {
      return null;
    }
    if (INTERNAL_CLAUDE_EVENT_TYPES.has(parsed.type)) {
      return null;
    }
    if (parsed.type === "user" && typeof parsed.uuid === "string" && parsed.message) {
      return parsed as ClaudeRawRecord;
    }
    if (parsed.type === "assistant" && typeof parsed.uuid === "string") {
      return parsed as ClaudeRawRecord;
    }
    if (
      parsed.type === "summary" &&
      typeof parsed.leafUuid === "string" &&
      typeof parsed.summary === "string"
    ) {
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

function recordKey(record: ClaudeRawRecord): string {
  switch (record.type) {
    case "summary":
      return `summary:${record.leafUuid}:${record.summary}`;
    case "user":
    case "assistant":
    case "system":
      return record.uuid;
  }
}

function deriveStoredSessionRef(filePath: string, records: ClaudeRawRecord[]): StoredSessionRef | null {
  const firstWithCwd = records.find((record) => typeof record.cwd === "string");
  const cwd = normalizeDirectory(firstWithCwd?.cwd);
  const sessionId =
    records.find((record) => typeof record.sessionId === "string")?.sessionId ??
    path.basename(filePath, ".jsonl");
  if (!cwd) {
    return null;
  }
  const previewSource =
    records
      .flatMap((record) => {
        if (record.type === "user") {
          const text = extractUserMessageText(record.message.content);
          return text ? [text] : [];
        }
        if (record.type === "assistant" && record.message) {
          const text = extractAssistantMessageText(record.message.content);
          return text ? [text] : [];
        }
        if (record.type === "summary") {
          return [record.summary];
        }
        return [];
      })[0] ?? "Untitled";
  const updatedAt = statSync(filePath).mtime.toISOString();
  return {
    provider: "claude",
    providerSessionId: sessionId,
    cwd,
    rootDir: cwd,
    title: truncateText(previewSource, 72),
    preview: truncateText(previewSource, 120),
    updatedAt,
    source: "provider_history",
  };
}

function translateClaudeRecords(sessionId: string, records: ClaudeRawRecord[]): RahEvent[] {
  const services = {
    eventBus: new EventBus(),
    ptyHub: new PtyHub(),
    sessionStore: new SessionStore(),
  };
  const temp = services.sessionStore.createManagedSession({
    provider: "claude",
    launchSource: "web",
    cwd: process.cwd(),
    rootDir: process.cwd(),
  });

  const processedKeys = new Set<string>();
  let turnCounter = 0;
  for (const record of records) {
    const key = recordKey(record);
    if (processedKeys.has(key)) {
      continue;
    }
    processedKeys.add(key);
    const timestamp = record.timestamp ?? new Date().toISOString();

    if (record.type === "summary") {
      applyProviderActivity(
        services,
        temp.session.id,
        {
          provider: "claude",
          channel: "structured_persisted",
          authority: "derived",
          raw: record,
        },
        {
          type: "timeline_item",
          item: {
            kind: "assistant_message",
            text: record.summary,
          },
        },
      );
      continue;
    }

    if (record.type === "user") {
      const text = extractUserMessageText(record.message.content);
      if (!text) {
        continue;
      }
      const turnId = `turn-${++turnCounter}`;
      applyProviderActivity(
        services,
        temp.session.id,
        {
          provider: "claude",
          channel: "structured_persisted",
          authority: "derived",
          raw: record,
          ts: timestamp,
        },
        {
          type: "turn_started",
          turnId,
        },
      );
      applyProviderActivity(
        services,
        temp.session.id,
        {
          provider: "claude",
          channel: "structured_persisted",
          authority: "derived",
          raw: record,
          ts: timestamp,
        },
        {
          type: "timeline_item",
          turnId,
          item: {
            kind: "user_message",
            text,
            messageId: record.uuid,
          },
        },
      );
      continue;
    }

    if (record.type === "assistant" && record.message) {
      const toolBlocks = Array.isArray(record.message.content)
        ? record.message.content.filter(
            (block) =>
              block &&
              typeof block === "object" &&
              !Array.isArray(block) &&
              (block as Record<string, unknown>).type === "tool_use",
          )
        : [];
      for (const block of toolBlocks) {
        const tool = block as Record<string, unknown>;
        const toolId =
          typeof tool.id === "string" ? tool.id : `claude-tool-${crypto.randomUUID()}`;
        const toolName = typeof tool.name === "string" ? tool.name : "unknown";
        const input =
          tool.input && typeof tool.input === "object" && !Array.isArray(tool.input)
            ? (tool.input as Record<string, unknown>)
            : undefined;
        const activity: ProviderActivity = {
          type: "tool_call_completed",
          toolCall: {
            id: toolId,
            family: "other",
            providerToolName: toolName,
            title: toolName,
            ...(input ? { input } : {}),
          },
        };
        applyProviderActivity(
          services,
          temp.session.id,
          {
            provider: "claude",
            channel: "structured_persisted",
            authority: "derived",
            raw: record,
            ts: timestamp,
          },
          activity,
        );
      }

      if (isClaudeTranscriptNoiseContent(record.message.content)) {
        continue;
      }
      const text = extractAssistantMessageText(record.message.content);
      if (!text) {
        continue;
      }
      applyProviderActivity(
        services,
        temp.session.id,
        {
          provider: "claude",
          channel: "structured_persisted",
          authority: "derived",
          raw: record,
          ts: timestamp,
        },
        {
          type: "timeline_item",
          item: {
            kind: "assistant_message",
            text,
            messageId: record.uuid,
          },
        },
      );
      continue;
    }

    if (record.type === "system") {
      if (record.subtype === "api_error") {
        applyProviderActivity(
          services,
          temp.session.id,
          {
            provider: "claude",
            channel: "structured_persisted",
            authority: "derived",
            raw: record,
            ts: timestamp,
          },
          {
            type: "notification",
            level: "critical",
            title: "Claude API error",
            body:
              typeof record.error === "string"
                ? record.error
                : typeof record.error === "object" && record.error !== null
                  ? JSON.stringify(record.error)
                  : "Unknown Claude error",
          },
        );
      }
    }
  }

  return services.eventBus.list({ sessionIds: [temp.session.id] });
}

export function discoverClaudeStoredSessions(cwd?: string): ClaudeStoredSessionRecord[] {
  const cache = loadStoredSessionMetadataCache("claude");
  const roots = cwd
    ? expandClaudeProjectDirs(cwd)
    : [path.join(resolveClaudeConfigDir(), "projects")];
  const files: string[] = [];

  for (const root of roots) {
    try {
      const stats = statSync(root);
      if (!stats.isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }

    const candidates = root.endsWith(".jsonl")
      ? [root]
      : cwd
        ? readdirSync(root)
            .filter((entry) => entry.endsWith(".jsonl"))
            .map((entry) => path.join(root, entry))
        : readdirSync(root, { withFileTypes: true })
            .flatMap((entry) => {
              if (!entry.isDirectory()) {
                return [];
              }
              const projectDir = path.join(root, entry.name);
              try {
                return readdirSync(projectDir)
                  .filter((file) => file.endsWith(".jsonl"))
                  .map((file) => path.join(projectDir, file));
              } catch {
                return [];
              }
            });
    files.push(...candidates);
  }

  const records: ClaudeStoredSessionRecord[] = [];
  for (const filePath of files) {
    const stats = statSync(filePath);
    const cachedRef = getCachedStoredSessionRef({
      cache,
      filePath,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
    });
    if (cachedRef) {
      records.push({ ref: cachedRef, filePath });
      continue;
    }
    const lines = readLeadingLines(filePath, {
      maxBytes: 256 * 1024,
    });
    const parsed = lines
      .map(safeParseClaudeRecord)
      .filter((record): record is ClaudeRawRecord => Boolean(record));
    const ref = deriveStoredSessionRef(filePath, parsed);
    if (!ref) {
      continue;
    }
    setCachedStoredSessionRef({
      cache,
      filePath,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      ref,
    });
    records.push({ ref, filePath });
  }

  writeStoredSessionMetadataCache(
    "claude",
    new Map(
      records.map((record) => {
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

  return records.sort((a, b) => (b.ref.updatedAt ?? "").localeCompare(a.ref.updatedAt ?? ""));
}

export function findClaudeStoredSessionRecord(
  providerSessionId: string,
  cwd?: string,
): ClaudeStoredSessionRecord | undefined {
  const scopedRecord = discoverClaudeStoredSessions(cwd).find(
    (record) => record.ref.providerSessionId === providerSessionId,
  );
  if (scopedRecord || !cwd) {
    return scopedRecord;
  }
  return discoverClaudeStoredSessions().find(
    (record) => record.ref.providerSessionId === providerSessionId,
  );
}

export async function waitForClaudeStoredSessionRecord(args: {
  providerSessionId: string;
  cwd?: string;
  timeoutMs?: number;
}): Promise<ClaudeStoredSessionRecord | undefined> {
  const timeoutMs = args.timeoutMs ?? 10_000;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const record = findClaudeStoredSessionRecord(args.providerSessionId, args.cwd);
    if (record) {
      return record;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return undefined;
}

export function resumeClaudeStoredSession(args: {
  services: RuntimeServices;
  record: ClaudeStoredSessionRecord;
  attach?: AttachSessionRequest;
}) {
  const ref = args.record.ref;
  const state = args.services.sessionStore.createManagedSession({
    provider: "claude",
    providerSessionId: ref.providerSessionId,
    launchSource: "web",
    cwd: ref.cwd ?? process.cwd(),
    rootDir: ref.rootDir ?? ref.cwd ?? process.cwd(),
    ...(ref.title ? { title: ref.title } : {}),
    ...(ref.preview ? { preview: ref.preview } : {}),
    capabilities: REHYDRATED_CAPABILITIES,
  });

  args.services.sessionStore.setRuntimeState(state.session.id, "stopped");
  args.services.eventBus.publish({
    sessionId: state.session.id,
    type: "session.created",
    source: SYSTEM_SOURCE,
    payload: { session: state.session },
  });
  args.services.eventBus.publish({
    sessionId: state.session.id,
    type: "session.started",
    source: SYSTEM_SOURCE,
    payload: { session: state.session },
  });

  if (args.attach) {
    args.services.sessionStore.attachClient({
      sessionId: state.session.id,
      clientId: args.attach.client.id,
      kind: args.attach.client.kind,
      connectionId: args.attach.client.connectionId,
      attachMode: args.attach.mode,
      focus: true,
    });
    args.services.eventBus.publish({
      sessionId: state.session.id,
      type: "session.attached",
      source: SYSTEM_SOURCE,
      payload: {
        clientId: args.attach.client.id,
        clientKind: args.attach.client.kind,
      },
    });
    if (args.attach.claimControl) {
      args.services.sessionStore.claimControl(state.session.id, args.attach.client.id);
      args.services.eventBus.publish({
        sessionId: state.session.id,
        type: "control.claimed",
        source: SYSTEM_SOURCE,
        payload: {
          clientId: args.attach.client.id,
          clientKind: args.attach.client.kind,
        },
      });
    }
  }

  return { sessionId: state.session.id };
}

export function getClaudeStoredSessionHistoryPage(args: {
  sessionId: string;
  record: ClaudeStoredSessionRecord;
  beforeTs?: string;
  limit?: number;
}): SessionHistoryPageResponse {
  const limit = args.limit ?? 1000;
  const lines = readFileSync(args.record.filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const parsed = lines.map(safeParseClaudeRecord).filter((record): record is ClaudeRawRecord => Boolean(record));
  const events = translateClaudeRecords(args.sessionId, parsed);
  const ordered = [...events].sort((left, right) => left.ts.localeCompare(right.ts));
  const filtered = args.beforeTs
    ? ordered.filter((event) => event.ts < args.beforeTs!)
    : ordered;
  const page = filtered.slice(Math.max(0, filtered.length - limit));
  const nextBeforeTs =
    filtered.length > page.length && page[0] ? page[0].ts : undefined;
  return {
    sessionId: args.sessionId,
    events: page,
    ...(nextBeforeTs ? { nextBeforeTs } : {}),
  };
}
