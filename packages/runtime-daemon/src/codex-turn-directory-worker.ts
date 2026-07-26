import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ConversationTurnFileChangesProjection,
  ConversationTurnDirectoryItem,
  ConversationTurnDirectoryStatus,
} from "@rah/runtime-protocol";
import { scanSelectedJsonlLines } from "./bounded-jsonl-reader.ts";
import { serveBackgroundIpcTask } from "./background-ipc-task";
import { parsePersistedUserMessageContent } from "./session-input-attachments.ts";

const CACHE_VERSION = 9;
const USER_PREVIEW_TEXT_LIMIT = 96;
const ASSISTANT_PREVIEW_TEXT_LIMIT = 144;
const SUMMARY_TEXT_LIMIT = 256 * 1024;
const DEFAULT_SUMMARY_PAGE_TEXT_BUDGET = 4 * 1024 * 1024;
const DIRECTORY_TRANSPORT_ITEM_LIMIT = 4_096;

export type CodexIndexedTurn = ConversationTurnDirectoryItem & {
  startOffset: number;
  endOffset: number;
  hasFinalAnswer: boolean;
  processDetailsAvailable: boolean;
  userText?: string;
  userItemId?: string;
  userImageCount?: number;
  assistantText?: string;
  assistantItemId?: string;
  assistantPhase?: "commentary" | "final_answer";
  fileChanges?: ConversationTurnFileChangesProjection;
};

export type CodexTurnDirectorySnapshot = {
  version: number;
  providerSessionId: string;
  rolloutPath: string;
  workspaceRoot: string;
  source: {
    dev: number;
    ino: number;
    size: number;
    mtimeMs: number;
  };
  scannedBytes: number;
  generatedAt: string;
  items: CodexIndexedTurn[];
  /**
   * The on-disk index always starts at ordinal zero. Worker responses may
   * retain only the newest compact directory entries so the daemon never
   * parses an unbounded IPC payload.
   */
  retainedFromOrdinal?: number;
};

export type CodexTurnSummaryRange = {
  id: string;
  startOffset: number;
  endOffset: number;
};

type DirectoryWorkerRequest = {
  kind: "codex-turn-directory";
  providerSessionId: string;
  rolloutPath: string;
  cachePath: string;
  workspaceRoot: string;
};

type SummaryWorkerRequest = {
  kind: "codex-turn-summary-page";
  rolloutPath: string;
  cachePath: string;
  workspaceRoot: string;
  cursor?: {
    turnId: string;
    includeAnchor: boolean;
  };
  limit: number;
  textBudgetBytes?: number;
};

type LookupWorkerRequest = {
  kind: "codex-turn-lookup";
  cachePath: string;
  turnIds: string[];
  includeFileChanges: boolean;
};

type WorkerRequest =
  | DirectoryWorkerRequest
  | SummaryWorkerRequest
  | LookupWorkerRequest;

export type CodexTurnSummaryPageWorkerResult = {
  items: CodexIndexedTurn[];
  hasOlder: boolean;
};

export type CodexTurnDirectoryWorkerResponse =
  | { ok: true; snapshot: CodexTurnDirectorySnapshot }
  | { ok: true; summaryPage: CodexTurnSummaryPageWorkerResult }
  | { ok: true; lookups: CodexIndexedTurn[] }
  | { ok: false; error: string };

type ParsedLineContext = {
  startOffset: number;
  endOffset: number;
};

function compactPreviewText(text: string, limit: number): string {
  const compact = text
    .replace(/data:image\/[^\s)]+/gi, "[image]")
    .replace(/\s+/g, " ")
    .trim();
  if (compact.length <= limit) {
    return compact;
  }
  return `${compact.slice(0, limit - 1).trimEnd()}…`;
}

function summaryText(text: string): string {
  const sanitized = text.replace(/data:image\/[^\s)]+/gi, "[Image]").trim();
  if (sanitized.length <= SUMMARY_TEXT_LIMIT) {
    return sanitized;
  }
  return `${sanitized.slice(0, SUMMARY_TEXT_LIMIT).trimEnd()}\n\n[Content truncated in history summary]`;
}

function isBootstrapUserMessage(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.startsWith("<environment_context>") ||
    trimmed.startsWith("# AGENTS.md instructions") ||
    trimmed.startsWith("<INSTRUCTIONS>") ||
    trimmed.startsWith("<permissions instructions>") ||
    trimmed.startsWith("<skills_instructions>")
  );
}

function recordPayload(record: Record<string, unknown>): Record<string, unknown> | null {
  const payload = record.payload;
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null;
}

function messageContentText(payload: Record<string, unknown>): string {
  if (!Array.isArray(payload.content)) {
    return "";
  }
  return payload.content
    .filter((part) => part && typeof part === "object" && !Array.isArray(part))
    .map((part) => part as Record<string, unknown>)
    .filter(
      (part) =>
        (part.type === "input_text" || part.type === "output_text") &&
        typeof part.text === "string",
    )
    .map((part) => part.text as string)
    .join("\n");
}

function messageContentImageCount(payload: Record<string, unknown>): number {
  if (!Array.isArray(payload.content)) {
    return 0;
  }
  return payload.content.filter((part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) {
      return false;
    }
    const record = part as Record<string, unknown>;
    return (
      record.type === "image" ||
      record.type === "input_image" ||
      record.type === "inputImage" ||
      record.type === "localImage" ||
      (typeof record.url === "string" && record.url.startsWith("data:image/")) ||
      (typeof record.image_url === "string" &&
        record.image_url.startsWith("data:image/")) ||
      (typeof record.imageUrl === "string" &&
        record.imageUrl.startsWith("data:image/"))
    );
  }).length;
}

function completionStatus(reason: unknown): ConversationTurnDirectoryStatus {
  return reason === "interrupted" || reason === "user" ? "interrupted" : "failed";
}

function epochSecondsToIso(value: unknown, fallback: string): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return new Date(value * 1_000).toISOString();
}

function normalizeDuration(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

function findTurn(items: CodexIndexedTurn[], turnId: unknown): CodexIndexedTurn | undefined {
  if (typeof turnId !== "string") {
    return undefined;
  }
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.id === turnId) {
      return items[index];
    }
  }
  return undefined;
}

function removeRolledBackTurns(items: CodexIndexedTurn[], countValue: unknown): void {
  const count =
    typeof countValue === "number" && Number.isInteger(countValue) && countValue > 0
      ? countValue
      : 0;
  if (count === 0) {
    return;
  }
  let remaining = count;
  let cutIndex = items.length;
  while (cutIndex > 0 && remaining > 0) {
    cutIndex -= 1;
    if (items[cutIndex]?.userPreview) {
      remaining -= 1;
    }
  }
  items.splice(cutIndex);
}

function countPatchLines(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      additions += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      deletions += 1;
    }
  }
  return { additions, deletions };
}

function contentLineCount(content: string): number {
  if (content.length === 0) {
    return 0;
  }
  const lineCount = content.split("\n").length;
  return content.endsWith("\n") ? lineCount - 1 : lineCount;
}

function relativeChangePath(filePath: string, workspaceRoot: string): string {
  if (!workspaceRoot || !path.isAbsolute(filePath)) {
    return filePath;
  }
  const relative = path.relative(workspaceRoot, filePath);
  return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`)
    ? relative
    : filePath;
}

function appendPatchSummary(
  turn: CodexIndexedTurn,
  payload: Record<string, unknown>,
  workspaceRoot: string,
): void {
  if (payload.success !== true) {
    return;
  }
  const rawChanges = payload.changes;
  if (!rawChanges || typeof rawChanges !== "object" || Array.isArray(rawChanges)) {
    return;
  }
  const summaries = new Map(
    (turn.fileChanges?.files ?? []).map((file) => [file.path, { ...file }]),
  );
  for (const [rawPath, rawChange] of Object.entries(
    rawChanges as Record<string, unknown>,
  )) {
    if (!rawChange || typeof rawChange !== "object" || Array.isArray(rawChange)) {
      continue;
    }
    const change = rawChange as Record<string, unknown>;
    const filePath = relativeChangePath(rawPath, workspaceRoot);
    const kind = typeof change.type === "string" ? change.type : "update";
    const diff =
      typeof change.unified_diff === "string"
        ? change.unified_diff
        : typeof change.unifiedDiff === "string"
          ? change.unifiedDiff
          : "";
    const content = typeof change.content === "string" ? change.content : "";
    const counts = diff
      ? countPatchLines(diff)
      : kind === "add"
        ? { additions: contentLineCount(content), deletions: 0 }
        : kind === "delete"
          ? { additions: 0, deletions: contentLineCount(content) }
          : { additions: 0, deletions: 0 };
    const existing = summaries.get(filePath) ?? {
      path: filePath,
      additions: 0,
      deletions: 0,
    };
    existing.additions += counts.additions;
    existing.deletions += counts.deletions;
    summaries.set(filePath, existing);
  }
  // Codex Desktop presents the final turn diff in Git's deterministic path
  // order, not in the chronological order of individual patch calls.
  const files = [...summaries.values()].sort((left, right) =>
    left.path === right.path ? 0 : left.path < right.path ? -1 : 1,
  );
  if (files.length === 0) {
    return;
  }
  turn.fileChanges = {
    files,
    totalAdditions: files.reduce((total, file) => total + file.additions, 0),
    totalDeletions: files.reduce((total, file) => total + file.deletions, 0),
  };
}

function createFallbackTurn(
  items: CodexIndexedTurn[],
  timestamp: string,
  context: ParsedLineContext,
): CodexIndexedTurn {
  const turn: CodexIndexedTurn = {
    id: `legacy:${context.startOffset}`,
    ordinal: items.length,
    userPreview: "",
    startedAt: timestamp,
    status: "in_progress",
    startOffset: context.startOffset,
    endOffset: context.endOffset,
    hasFinalAnswer: false,
    processDetailsAvailable: false,
  };
  items.push(turn);
  return turn;
}

function shouldParseLine(line: string): boolean {
  const head = line.slice(0, 1_024);
  if (/"type"\s*:\s*"event_msg"/.test(head)) {
    return /"type"\s*:\s*"(?:task_started|task_complete|turn_aborted|thread_rolled_back|user_message|agent_message|patch_apply_end|web_search_begin|web_search_end|context_compacted|thread_goal_updated|thread_goal_cleared)"/.test(
      head,
    );
  }
  return (
    /"type"\s*:\s*"response_item"/.test(head) &&
    ((
      /"type"\s*:\s*"message"/.test(head) &&
      /"role"\s*:\s*"(?:user|assistant)"/.test(head)
    ) ||
      /"type"\s*:\s*"(?:web_search_call|function_call|custom_tool_call|function_call_output|custom_tool_call_output)"/.test(
        head,
      ))
  );
}

function recordHasRenderableProcessDetails(
  record: Record<string, unknown>,
  payload: Record<string, unknown>,
): boolean {
  if (record.type === "event_msg") {
    switch (payload.type) {
      case "agent_message":
        return payload.phase !== "final_answer";
      case "patch_apply_end":
      case "web_search_begin":
      case "web_search_end":
      case "context_compacted":
      case "thread_goal_updated":
      case "thread_goal_cleared":
        return true;
      default:
        return false;
    }
  }
  if (record.type !== "response_item") {
    return false;
  }
  if (payload.type === "message") {
    return payload.role === "assistant" && payload.phase !== "final_answer";
  }
  return (
    payload.type === "web_search_call" ||
    payload.type === "function_call" ||
    payload.type === "custom_tool_call" ||
    payload.type === "function_call_output" ||
    payload.type === "custom_tool_call_output"
  );
}

function applyRolloutLine(
  items: CodexIndexedTurn[],
  line: string,
  context: ParsedLineContext,
  workspaceRoot: string,
  captureSummaryText = false,
): void {
  if (!shouldParseLine(line)) {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return;
  }
  const record = parsed as Record<string, unknown>;
  const payload = recordPayload(record);
  if (!payload) {
    return;
  }
  const timestamp = typeof record.timestamp === "string" ? record.timestamp : new Date().toISOString();
  const latest = items.at(-1);
  const processTurn = findTurn(items, payload.turn_id) ?? latest;
  if (
    processTurn &&
    recordHasRenderableProcessDetails(record, payload)
  ) {
    processTurn.processDetailsAvailable = true;
    processTurn.endOffset = context.endOffset;
  }

  if (record.type === "event_msg") {
    switch (payload.type) {
      case "task_started": {
        if (latest?.status === "in_progress") {
          latest.status = "interrupted";
          latest.completedAt = timestamp;
          latest.endOffset = context.startOffset;
        }
        const turnId =
          typeof payload.turn_id === "string" ? payload.turn_id : `legacy:${context.startOffset}`;
        items.push({
          id: turnId,
          ordinal: items.length,
          userPreview: "",
          startedAt: timestamp,
          status: "in_progress",
          startOffset: context.startOffset,
          endOffset: context.endOffset,
          hasFinalAnswer: false,
          processDetailsAvailable: false,
        });
        return;
      }
      case "user_message": {
        const persisted =
          typeof payload.message === "string"
            ? parsePersistedUserMessageContent(payload.message)
            : undefined;
        const text = persisted?.text ?? "";
        if (!text || isBootstrapUserMessage(text)) {
          return;
        }
        const turn = latest?.status === "in_progress"
          ? latest
          : createFallbackTurn(items, timestamp, context);
        if (!turn.userPreview) {
          turn.userPreview = compactPreviewText(text, USER_PREVIEW_TEXT_LIMIT) || "Message";
        }
        if (captureSummaryText) {
          turn.userText ??= summaryText(text);
        }
        const imageCount = persisted?.imageCount ?? 0;
        if (imageCount > 0) {
          turn.userImageCount = Math.max(
            turn.userImageCount ?? 0,
            imageCount,
          );
        }
        turn.endOffset = context.endOffset;
        return;
      }
      case "agent_message": {
        const text = typeof payload.message === "string" ? payload.message : "";
        const turn = findTurn(items, payload.turn_id) ?? items.at(-1);
        if (!turn || !text) {
          return;
        }
        const preview = compactPreviewText(text, ASSISTANT_PREVIEW_TEXT_LIMIT);
        if (preview) {
          turn.assistantPreview = preview;
          if (captureSummaryText) {
            turn.assistantText = summaryText(text);
          }
          turn.assistantPhase = payload.phase === "final_answer" ? "final_answer" : "commentary";
          turn.hasFinalAnswer = turn.assistantPhase === "final_answer" || turn.hasFinalAnswer;
        }
        turn.endOffset = context.endOffset;
        return;
      }
      case "patch_apply_end": {
        const turn = findTurn(items, payload.turn_id) ?? items.at(-1);
        if (!turn) {
          return;
        }
        appendPatchSummary(turn, payload, workspaceRoot);
        turn.endOffset = context.endOffset;
        return;
      }
      case "task_complete": {
        const turn = findTurn(items, payload.turn_id) ?? items.at(-1);
        if (!turn) {
          return;
        }
        const finalText =
          typeof payload.last_agent_message === "string" ? payload.last_agent_message : "";
        if (finalText) {
          turn.assistantPreview = compactPreviewText(finalText, ASSISTANT_PREVIEW_TEXT_LIMIT);
          if (captureSummaryText) {
            turn.assistantText = summaryText(finalText);
          }
          turn.assistantPhase = "final_answer";
          turn.hasFinalAnswer = true;
        }
        turn.status = "completed";
        turn.completedAt = epochSecondsToIso(payload.completed_at, timestamp);
        const durationMs = normalizeDuration(payload.duration_ms);
        if (durationMs !== undefined) {
          turn.durationMs = durationMs;
        }
        turn.endOffset = context.endOffset;
        return;
      }
      case "turn_aborted": {
        const turn = findTurn(items, payload.turn_id) ?? items.at(-1);
        if (!turn) {
          return;
        }
        turn.status = completionStatus(payload.reason);
        turn.completedAt = epochSecondsToIso(payload.completed_at, timestamp);
        const durationMs = normalizeDuration(payload.duration_ms);
        if (durationMs !== undefined) {
          turn.durationMs = durationMs;
        }
        turn.endOffset = context.endOffset;
        return;
      }
      case "thread_rolled_back":
        removeRolledBackTurns(items, payload.num_turns);
        return;
      default:
        return;
    }
  }

  if (record.type !== "response_item" || payload.type !== "message") {
    return;
  }
  const text = messageContentText(payload);
  if (!text) {
    return;
  }
  if (payload.role === "user") {
    const persisted = parsePersistedUserMessageContent(text);
    const visibleText = persisted.text;
    if (isBootstrapUserMessage(visibleText)) {
      return;
    }
    const turn = items.at(-1)?.status === "in_progress"
      ? items.at(-1)!
      : createFallbackTurn(items, timestamp, context);
    if (!turn.userPreview) {
      turn.userPreview =
        compactPreviewText(visibleText, USER_PREVIEW_TEXT_LIMIT) || "Message";
    }
    if (captureSummaryText) {
      turn.userText ??= summaryText(visibleText);
    }
    const imageCount = Math.max(
      persisted.imageCount,
      messageContentImageCount(payload),
    );
    if (imageCount > 0) {
      turn.userImageCount = Math.max(turn.userImageCount ?? 0, imageCount);
    }
    if (typeof payload.id === "string") {
      turn.userItemId ??= payload.id;
    }
    turn.endOffset = context.endOffset;
    return;
  }
  if (payload.role === "assistant") {
    const turn = items.at(-1);
    if (!turn) {
      return;
    }
    const preview = compactPreviewText(text, ASSISTANT_PREVIEW_TEXT_LIMIT);
    if (preview) {
      turn.assistantPreview = preview;
      if (captureSummaryText) {
        turn.assistantText = summaryText(text);
      }
      if (typeof payload.id === "string") {
        turn.assistantItemId = payload.id;
      }
      turn.assistantPhase = payload.phase === "final_answer" ? "final_answer" : "commentary";
      turn.hasFinalAnswer = turn.assistantPhase === "final_answer" || turn.hasFinalAnswer;
    }
    turn.endOffset = context.endOffset;
  }
}

async function scanAppendedLines(args: {
  rolloutPath: string;
  startOffset: number;
  items: CodexIndexedTurn[];
  workspaceRoot: string;
  captureSummaryText?: boolean;
  endOffset?: number;
  selectHead?: (head: string) => boolean;
}): Promise<number> {
  const scannedBytes = await scanSelectedJsonlLines({
    filePath: args.rolloutPath,
    startOffset: args.startOffset,
    ...(args.endOffset !== undefined ? { endOffset: args.endOffset } : {}),
    selectHead: args.selectHead ?? shouldParseLine,
    onLine: ({ text, startOffset, endOffset }) => {
      applyRolloutLine(
        args.items,
        text,
        { startOffset, endOffset },
        args.workspaceRoot,
        args.captureSummaryText ?? false,
      );
    },
    onOversizedSelectedLine: (head, context) => {
      if (!/"type"\s*:\s*"response_item"/.test(head) || !/"role"\s*:\s*"user"/.test(head)) {
        return;
      }
      const turn = args.items.at(-1)?.status === "in_progress"
        ? args.items.at(-1)!
        : createFallbackTurn(args.items, new Date().toISOString(), context);
      if (!turn.userPreview) {
        turn.userPreview = "Message with attachment";
      }
      turn.userImageCount = Math.max(turn.userImageCount ?? 0, 1);
      turn.endOffset = context.endOffset;
    },
  });
  const current = args.items.at(-1);
  if (current?.status === "in_progress") {
    current.endOffset = scannedBytes;
  }
  return scannedBytes;
}

function shouldParseSummaryLine(line: string): boolean {
  const head = line.slice(0, 1_024);
  if (/"type"\s*:\s*"event_msg"/.test(head)) {
    return /"type"\s*:\s*"(?:task_started|task_complete|turn_aborted|user_message|agent_message)"/.test(
      head,
    );
  }
  return (
    /"type"\s*:\s*"response_item"/.test(head) &&
    /"type"\s*:\s*"message"/.test(head) &&
    /"role"\s*:\s*"(?:user|assistant)"/.test(head)
  );
}

export async function hydrateCodexTurnSummaries(
  request: {
    rolloutPath: string;
    workspaceRoot: string;
    turns: CodexTurnSummaryRange[];
    textBudgetBytes?: number;
  },
): Promise<CodexIndexedTurn[]> {
  if (request.turns.length === 0) {
    return [];
  }
  const startOffset = Math.min(...request.turns.map((turn) => turn.startOffset));
  const endOffset = Math.max(...request.turns.map((turn) => turn.endOffset));
  const hydrated: CodexIndexedTurn[] = [];
  await scanAppendedLines({
    rolloutPath: request.rolloutPath,
    startOffset,
    endOffset,
    items: hydrated,
    workspaceRoot: request.workspaceRoot,
    captureSummaryText: true,
    selectHead: shouldParseSummaryLine,
  });
  const byId = new Map(hydrated.map((turn) => [turn.id, turn]));
  const ordered: CodexIndexedTurn[] = request.turns.map((range) => {
    const exact = byId.get(range.id);
    if (exact) {
      return exact;
    }
    const overlapping = hydrated.find(
      (turn) =>
        turn.startOffset < range.endOffset &&
        turn.endOffset > range.startOffset,
    );
    return (
      overlapping ?? ({
        id: range.id,
        ordinal: 0,
        userPreview: "",
        startedAt: "1970-01-01T00:00:00.000Z",
        status: "in_progress" as const,
        startOffset: range.startOffset,
        endOffset: range.endOffset,
        hasFinalAnswer: false,
        processDetailsAvailable: false,
      } satisfies CodexIndexedTurn)
    );
  });
  let remainingTextBytes = Math.max(
    0,
    request.textBudgetBytes ?? DEFAULT_SUMMARY_PAGE_TEXT_BUDGET,
  );
  for (const turn of ordered) {
    for (const field of ["userText", "assistantText"] as const) {
      const text = turn[field];
      if (!text) {
        continue;
      }
      const bytes = Buffer.byteLength(text, "utf8");
      if (bytes <= remainingTextBytes) {
        remainingTextBytes -= bytes;
        continue;
      }
      delete turn[field];
    }
  }
  return ordered;
}

function compactIndexedTurn(
  item: CodexIndexedTurn,
  includeFileChanges = false,
): CodexIndexedTurn {
  const {
    userText: _userText,
    assistantText: _assistantText,
    fileChanges,
    ...compact
  } = item;
  return {
    ...compact,
    ...(includeFileChanges && fileChanges ? { fileChanges } : {}),
  };
}

function transportSnapshot(
  snapshot: CodexTurnDirectorySnapshot,
): CodexTurnDirectorySnapshot {
  const retainedFromOrdinal = Math.max(
    0,
    snapshot.items.length - DIRECTORY_TRANSPORT_ITEM_LIMIT,
  );
  return {
    ...snapshot,
    retainedFromOrdinal,
    items: snapshot.items
      .slice(retainedFromOrdinal)
      .map((item) => compactIndexedTurn(item)),
  };
}

async function hydrateCodexTurnSummaryPage(
  request: SummaryWorkerRequest,
): Promise<CodexTurnSummaryPageWorkerResult> {
  const snapshot = await readCache(request.cachePath);
  if (!snapshot) {
    throw new Error("Codex turn directory cache is unavailable.");
  }
  const indexedTurns = snapshot.items.filter((item) => item.userPreview);
  let startIndex = indexedTurns.length - 1;
  if (request.cursor) {
    const anchorIndex = indexedTurns.findIndex(
      (item) => item.id === request.cursor!.turnId,
    );
    if (anchorIndex < 0) {
      throw new Error("Codex history cursor no longer exists in the indexed rollout.");
    }
    startIndex = request.cursor.includeAnchor ? anchorIndex : anchorIndex - 1;
  }
  const limit = Math.max(1, Math.min(100, Math.floor(request.limit)));
  const selected = indexedTurns
    .slice(Math.max(0, startIndex - limit + 1), startIndex + 1)
    .reverse();
  const hydrated = await hydrateCodexTurnSummaries({
    rolloutPath: request.rolloutPath,
    workspaceRoot: request.workspaceRoot,
    turns: selected.map((item) => ({
      id: item.id,
      startOffset: item.startOffset,
      endOffset: item.endOffset,
    })),
    ...(request.textBudgetBytes !== undefined
      ? { textBudgetBytes: request.textBudgetBytes }
      : {}),
  });
  const hydratedById = new Map(hydrated.map((item) => [item.id, item]));
  const items = selected.map((item) => {
    const detail = hydratedById.get(item.id);
    return {
      ...compactIndexedTurn(item),
      ...(detail?.userText !== undefined ? { userText: detail.userText } : {}),
      ...(detail?.userItemId !== undefined
        ? { userItemId: detail.userItemId }
        : {}),
      ...(detail?.userImageCount !== undefined
        ? { userImageCount: detail.userImageCount }
        : {}),
      ...(detail?.assistantText !== undefined
        ? { assistantText: detail.assistantText }
        : {}),
      ...(detail?.assistantItemId !== undefined
        ? { assistantItemId: detail.assistantItemId }
        : {}),
      ...(detail?.assistantPhase !== undefined
        ? { assistantPhase: detail.assistantPhase }
        : {}),
    };
  });
  const oldest = selected.at(-1);
  const oldestIndex = oldest
    ? indexedTurns.findIndex((item) => item.id === oldest.id)
    : -1;
  return {
    items,
    hasOlder: oldestIndex > 0,
  };
}

async function lookupCodexTurns(
  request: LookupWorkerRequest,
): Promise<CodexIndexedTurn[]> {
  if (request.turnIds.length === 0) {
    return [];
  }
  const snapshot = await readCache(request.cachePath);
  if (!snapshot) {
    throw new Error("Codex turn directory cache is unavailable.");
  }
  const requested = new Set(request.turnIds);
  return snapshot.items
    .filter((item) => requested.has(item.id))
    .map((item) => compactIndexedTurn(item, request.includeFileChanges));
}

async function readCache(cachePath: string): Promise<CodexTurnDirectorySnapshot | null> {
  try {
    const parsed = JSON.parse(await readFile(cachePath, "utf8")) as CodexTurnDirectorySnapshot;
    return parsed.version === CACHE_VERSION && Array.isArray(parsed.items) ? parsed : null;
  } catch {
    return null;
  }
}

function canIncrementCache(
  cached: CodexTurnDirectorySnapshot,
  source: CodexTurnDirectorySnapshot["source"],
  workspaceRoot: string,
): boolean {
  if (cached.workspaceRoot !== workspaceRoot) {
    return false;
  }
  if (cached.source.dev !== source.dev || cached.source.ino !== source.ino) {
    return false;
  }
  if (cached.scannedBytes > source.size) {
    return false;
  }
  if (cached.scannedBytes === source.size && cached.source.mtimeMs !== source.mtimeMs) {
    return false;
  }
  return true;
}

async function writeCache(cachePath: string, snapshot: CodexTurnDirectorySnapshot): Promise<void> {
  await mkdir(path.dirname(cachePath), { recursive: true });
  const temporaryPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(snapshot), { mode: 0o600 });
  await rename(temporaryPath, cachePath);
}

export async function scanCodexTurnDirectory(
  request: Omit<DirectoryWorkerRequest, "kind">,
): Promise<CodexTurnDirectorySnapshot> {
  const workspaceRoot =
    typeof request.workspaceRoot === "string" ? request.workspaceRoot : "";
  const initialStats = await stat(request.rolloutPath);
  let source = {
    dev: initialStats.dev,
    ino: initialStats.ino,
    size: initialStats.size,
    mtimeMs: initialStats.mtimeMs,
  };
  const cached = await readCache(request.cachePath);
  const incremental =
    cached && canIncrementCache(cached, source, workspaceRoot)
      ? cached
      : null;
  const items = incremental ? incremental.items.map((item) => ({ ...item })) : [];
  const scannedBytes = await scanAppendedLines({
    rolloutPath: request.rolloutPath,
    startOffset: incremental?.scannedBytes ?? 0,
    items,
    workspaceRoot,
  });
  const finalStats = await stat(request.rolloutPath);
  if (
    finalStats.dev === initialStats.dev &&
    finalStats.ino === initialStats.ino &&
    finalStats.size >= scannedBytes
  ) {
    // A live rollout may grow while its existing file descriptor is being
    // scanned. Associate the snapshot with the final append-only revision so
    // the next request can continue from scannedBytes without a full rebuild.
    source = {
      dev: finalStats.dev,
      ino: finalStats.ino,
      size: finalStats.size,
      mtimeMs: finalStats.mtimeMs,
    };
  }
  items.forEach((item, ordinal) => {
    item.ordinal = ordinal;
  });
  const generatedAt = new Date().toISOString();
  const snapshot: CodexTurnDirectorySnapshot = {
    version: CACHE_VERSION,
    providerSessionId: request.providerSessionId,
    rolloutPath: request.rolloutPath,
    workspaceRoot,
    source,
    scannedBytes,
    generatedAt,
    items,
  };
  await writeCache(request.cachePath, snapshot);
  return snapshot;
}

async function runWorker(
  request: WorkerRequest,
): Promise<CodexTurnDirectoryWorkerResponse> {
  try {
    if (request.kind === "codex-turn-summary-page") {
      const summaryPage = await hydrateCodexTurnSummaryPage(request);
      return {
        ok: true,
        summaryPage,
      };
    }
    if (request.kind === "codex-turn-lookup") {
      const lookups = await lookupCodexTurns(request);
      return {
        ok: true,
        lookups,
      };
    }
    const snapshot = await scanCodexTurnDirectory(request);
    return {
      ok: true,
      snapshot: transportSnapshot(snapshot),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

serveBackgroundIpcTask<WorkerRequest, CodexTurnDirectoryWorkerResponse>({
  label: "Codex turn history worker",
  handle: (request) => {
    if (
      request?.kind !== "codex-turn-directory" &&
      request?.kind !== "codex-turn-summary-page" &&
      request?.kind !== "codex-turn-lookup"
    ) {
      throw new Error("Unknown Codex turn history worker request.");
    }
    return runWorker(request);
  },
  onError: (error) => ({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }),
  maxResponseBytes: 8 * 1024 * 1024,
});
