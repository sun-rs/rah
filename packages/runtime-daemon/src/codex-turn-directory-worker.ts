import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  isMainThread,
  parentPort,
  workerData,
  type MessagePort,
} from "node:worker_threads";
import type {
  SessionTurnDirectoryItem,
  SessionTurnDirectoryStatus,
} from "@rah/runtime-protocol";
import { scanSelectedJsonlLines } from "./bounded-jsonl-reader.ts";

const CACHE_VERSION = 1;
const PREVIEW_TEXT_LIMIT = 180;

export type CodexIndexedTurn = SessionTurnDirectoryItem & {
  startOffset: number;
  endOffset: number;
  hasFinalAnswer: boolean;
};

export type CodexTurnDirectorySnapshot = {
  version: number;
  providerSessionId: string;
  rolloutPath: string;
  source: {
    dev: number;
    ino: number;
    size: number;
    mtimeMs: number;
  };
  scannedBytes: number;
  generatedAt: string;
  items: CodexIndexedTurn[];
};

type WorkerRequest = {
  kind: "codex-turn-directory";
  providerSessionId: string;
  rolloutPath: string;
  cachePath: string;
};

type WorkerResponse =
  | { ok: true; snapshot: CodexTurnDirectorySnapshot }
  | { ok: false; error: string };

type ParsedLineContext = {
  startOffset: number;
  endOffset: number;
};

function compactPreviewText(text: string): string {
  const compact = text
    .replace(/data:image\/[^\s)]+/gi, "[image]")
    .replace(/\s+/g, " ")
    .trim();
  if (compact.length <= PREVIEW_TEXT_LIMIT) {
    return compact;
  }
  return `${compact.slice(0, PREVIEW_TEXT_LIMIT - 1).trimEnd()}…`;
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

function completionStatus(reason: unknown): SessionTurnDirectoryStatus {
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
  };
  items.push(turn);
  return turn;
}

function shouldParseLine(line: string): boolean {
  const head = line.slice(0, 1_024);
  if (/"type"\s*:\s*"event_msg"/.test(head)) {
    return /"type"\s*:\s*"(?:task_started|task_complete|turn_aborted|thread_rolled_back|user_message|agent_message)"/.test(
      head,
    );
  }
  return (
    /"type"\s*:\s*"response_item"/.test(head) &&
    /"type"\s*:\s*"message"/.test(head) &&
    /"role"\s*:\s*"(?:user|assistant)"/.test(head)
  );
}

function applyRolloutLine(
  items: CodexIndexedTurn[],
  line: string,
  context: ParsedLineContext,
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
        });
        return;
      }
      case "user_message": {
        const text = typeof payload.message === "string" ? payload.message : "";
        if (!text || isBootstrapUserMessage(text)) {
          return;
        }
        const turn = latest?.status === "in_progress"
          ? latest
          : createFallbackTurn(items, timestamp, context);
        if (!turn.userPreview) {
          turn.userPreview = compactPreviewText(text) || "Message";
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
        const preview = compactPreviewText(text);
        if (preview) {
          turn.assistantPreview = preview;
          turn.hasFinalAnswer = payload.phase === "final_answer" || turn.hasFinalAnswer;
        }
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
          turn.assistantPreview = compactPreviewText(finalText);
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
    if (isBootstrapUserMessage(text)) {
      return;
    }
    const turn = items.at(-1)?.status === "in_progress"
      ? items.at(-1)!
      : createFallbackTurn(items, timestamp, context);
    if (!turn.userPreview) {
      turn.userPreview = compactPreviewText(text) || "Message";
    }
    turn.endOffset = context.endOffset;
    return;
  }
  if (payload.role === "assistant") {
    const turn = items.at(-1);
    if (!turn) {
      return;
    }
    const preview = compactPreviewText(text);
    if (preview) {
      turn.assistantPreview = preview;
      turn.hasFinalAnswer = payload.phase === "final_answer" || turn.hasFinalAnswer;
    }
    turn.endOffset = context.endOffset;
  }
}

async function scanAppendedLines(args: {
  rolloutPath: string;
  startOffset: number;
  items: CodexIndexedTurn[];
}): Promise<number> {
  const scannedBytes = await scanSelectedJsonlLines({
    filePath: args.rolloutPath,
    startOffset: args.startOffset,
    selectHead: shouldParseLine,
    onLine: ({ text, startOffset, endOffset }) => {
      applyRolloutLine(args.items, text, { startOffset, endOffset });
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
      turn.endOffset = context.endOffset;
    },
  });
  const current = args.items.at(-1);
  if (current?.status === "in_progress") {
    current.endOffset = scannedBytes;
  }
  return scannedBytes;
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
): boolean {
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
  request: Omit<WorkerRequest, "kind">,
): Promise<CodexTurnDirectorySnapshot> {
  const initialStats = await stat(request.rolloutPath);
  let source = {
    dev: initialStats.dev,
    ino: initialStats.ino,
    size: initialStats.size,
    mtimeMs: initialStats.mtimeMs,
  };
  const cached = await readCache(request.cachePath);
  const incremental = cached && canIncrementCache(cached, source) ? cached : null;
  const items = incremental ? incremental.items.map((item) => ({ ...item })) : [];
  const scannedBytes = await scanAppendedLines({
    rolloutPath: request.rolloutPath,
    startOffset: incremental?.scannedBytes ?? 0,
    items,
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
    source,
    scannedBytes,
    generatedAt,
    items,
  };
  await writeCache(request.cachePath, snapshot);
  return snapshot;
}

async function runWorker(request: WorkerRequest, port: MessagePort): Promise<void> {
  try {
    const snapshot = await scanCodexTurnDirectory(request);
    port.postMessage({ ok: true, snapshot } satisfies WorkerResponse);
  } catch (error) {
    port.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    } satisfies WorkerResponse);
  }
}

if (!isMainThread && parentPort) {
  const request = workerData as WorkerRequest;
  if (request?.kind === "codex-turn-directory") {
    void runWorker(request, parentPort);
  }
}
