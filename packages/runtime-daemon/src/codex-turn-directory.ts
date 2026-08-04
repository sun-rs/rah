import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ConversationTurnDirectoryResponse,
} from "@rah/runtime-protocol";
import type { CodexAppServerTurnsPage } from "./codex-app-server-turns-page";
import {
  codexStoredSessionWorkspaceRoot,
  type CodexStoredSessionRecord,
} from "./codex-stored-session-types";
import type {
  CodexIndexedTurn,
  CodexTurnDirectorySnapshot,
  CodexTurnDirectoryWorkerResponse,
  CodexTurnSummaryPageWorkerResult,
} from "./codex-turn-directory-worker";
import { BoundedTaskScheduler } from "./bounded-task-scheduler";
import {
  runBackgroundIpcTask,
  terminateBackgroundIpcProcess,
  type BackgroundIpcChild,
} from "./background-ipc-task";
import {
  HISTORY_WORKLOAD_PRIORITY,
  sharedHistoryWorkloadScheduler,
} from "./history-workload-governor";

const SUMMARY_PAGE_TEXT_BUDGET_BYTES = 4 * 1024 * 1024;
const TURN_DIRECTORY_RESPONSE_BYTES = 8 * 1024 * 1024;
const TURN_SUMMARY_RESPONSE_BYTES = 8 * 1024 * 1024;
const TURN_LOOKUP_RESPONSE_BYTES = 8 * 1024 * 1024;

function resolveRahRuntimeHome(): string {
  return process.env.RAH_HOME ?? path.join(os.homedir(), ".rah", "runtime-daemon");
}

function cacheKey(providerSessionId: string): string {
  return createHash("sha256").update(providerSessionId).digest("hex").slice(0, 32);
}

function directoryCachePath(providerSessionId: string): string {
  return path.join(
    resolveRahRuntimeHome(),
    "turn-directory",
    "codex",
    `${cacheKey(providerSessionId)}.json`,
  );
}

function summaryCachePath(providerSessionId: string): string {
  return path.join(
    resolveRahRuntimeHome(),
    "turn-directory",
    "codex",
    `${cacheKey(providerSessionId)}.summaries.json`,
  );
}

function sourceRevision(snapshot: CodexTurnDirectorySnapshot): string {
  return createHash("sha256")
    .update(
      [
        snapshot.source.dev,
        snapshot.source.ino,
        snapshot.source.size,
        snapshot.source.mtimeMs,
        snapshot.scannedBytes,
      ].join(":"),
    )
    .digest("base64url")
    .slice(0, 22);
}

async function statKey(filePath: string): Promise<string> {
  const stats = await stat(filePath);
  return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}`;
}

function snapshotStatKey(snapshot: CodexTurnDirectorySnapshot): string {
  return [
    snapshot.source.dev,
    snapshot.source.ino,
    snapshot.source.size,
    snapshot.source.mtimeMs,
  ].join(":");
}

export class CodexTurnDirectoryStore {
  private readonly snapshotsByPath = new Map<
    string,
    { statKey: string; snapshot: CodexTurnDirectorySnapshot }
  >();
  private readonly inFlightByPath = new Map<string, Promise<CodexTurnDirectorySnapshot>>();
  private readonly workers = new Set<BackgroundIpcChild>();
  private readonly scanAbortControllers = new Set<AbortController>();
  private closed = false;

  constructor(
    private readonly scheduler: BoundedTaskScheduler = sharedHistoryWorkloadScheduler,
  ) {}

  async getDirectory(
    sessionId: string,
    record: CodexStoredSessionRecord,
  ): Promise<ConversationTurnDirectoryResponse> {
    const snapshot = await this.getSnapshot(record);
    const sourceIsCurrent =
      snapshotStatKey(snapshot) === await statKey(record.rolloutPath);
    return {
      sessionId,
      revision: sourceRevision(snapshot),
      items: snapshot.items
        .filter((item) => item.userPreview)
        .map((item) => ({
          id: item.id,
          ordinal: item.ordinal,
          userPreview: item.userPreview,
          ...(item.assistantPreview !== undefined
            ? { assistantPreview: item.assistantPreview }
            : {}),
          startedAt: item.startedAt,
          ...(item.completedAt !== undefined ? { completedAt: item.completedAt } : {}),
          ...(item.durationMs !== undefined ? { durationMs: item.durationMs } : {}),
          status: item.status,
        })),
      complete:
        sourceIsCurrent &&
        snapshot.scannedBytes >= snapshot.source.size &&
        (snapshot.retainedFromOrdinal ?? 0) === 0,
      sourceBytes: snapshot.source.size,
      generatedAt: snapshot.generatedAt,
    };
  }

  async getTurnRange(
    record: CodexStoredSessionRecord,
    turnId: string,
  ): Promise<{ startOffset: number; endOffset: number } | null> {
    const snapshot = await this.getSnapshot(record);
    const item =
      snapshot.items.find((candidate) => candidate.id === turnId) ??
      (await this.lookupTurns(record, [turnId]))[0];
    return item ? { startOffset: item.startOffset, endOffset: item.endOffset } : null;
  }

  async getSummaryPage(
    record: CodexStoredSessionRecord,
    options: { cursor?: string; limit: number; sourceSettled: boolean },
  ): Promise<CodexAppServerTurnsPage> {
    const anchor = options.cursor ? parseTurnCursor(options.cursor) : undefined;
    const summaryPage = await this.hydrateSummaryPage(
      record,
      anchor,
      options.limit,
    );
    const selected = summaryPage.items;
    const data = selected.map((item, index) => {
      const isTrailing = !options.cursor && index === 0;
      const status =
        item.status === "in_progress" && options.sourceSettled && isTrailing
          ? "interrupted"
          : item.status === "in_progress"
            ? "inProgress"
            : item.status;
      const userText = item.userText ?? item.userPreview;
      const userContent: unknown[] = [
        { type: "text", text: userText, text_elements: [] },
        ...Array.from(
          { length: item.userImageCount ?? 0 },
          () => ({ type: "image", summaryOnly: true }),
        ),
      ];
      const items: unknown[] = [
        {
          type: "userMessage",
          id: item.userItemId ?? `history-user:${item.id}`,
          content: userContent,
        },
      ];
      const assistantText = item.assistantText ?? item.assistantPreview;
      if (assistantText) {
        items.push({
          type: "agentMessage",
          id:
            item.assistantItemId ??
            `history-assistant:${item.id}`,
          text: assistantText,
          phase:
            item.assistantPhase ??
            (item.hasFinalAnswer ? "final_answer" : "commentary"),
          memoryCitation: null,
        });
      }
      return {
        id: item.id,
        items,
        itemsView: "summary",
        processDetailsAvailable: item.processDetailsAvailable,
        status,
        error: item.status === "failed" ? { message: "Codex turn failed" } : null,
        startedAt: isoToEpochSeconds(item.startedAt),
        completedAt: item.completedAt ? isoToEpochSeconds(item.completedAt) : null,
        durationMs: item.durationMs ?? null,
      };
    });
    const oldest = selected.at(-1);
    return {
      data,
      sourceRevision: summaryPage.sourceRevision,
      ...(oldest && summaryPage.hasOlder
        ? { nextCursor: createTurnCursor(oldest.id, false) }
        : { nextCursor: null }),
      ...(selected[0]
        ? { backwardsCursor: createTurnCursor(selected[0].id, true) }
        : { backwardsCursor: null }),
    };
  }

  clear(providerSessionId: string): void {
    for (const [filePath, cached] of this.snapshotsByPath) {
      if (cached.snapshot.providerSessionId === providerSessionId) {
        this.snapshotsByPath.delete(filePath);
      }
    }
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    for (const controller of this.scanAbortControllers) {
      controller.abort(new DOMException("Turn directory store closed", "AbortError"));
    }
    this.scanAbortControllers.clear();
    const workers = [...this.workers];
    this.workers.clear();
    await Promise.all(workers.map(terminateBackgroundIpcProcess));
  }

  private async getSnapshot(record: CodexStoredSessionRecord): Promise<CodexTurnDirectorySnapshot> {
    if (this.closed) {
      throw new Error("Codex turn directory store is closed.");
    }
    const currentStatKey = await statKey(record.rolloutPath);
    const workspaceRoot = codexStoredSessionWorkspaceRoot(record) ?? "";
    const cached = this.snapshotsByPath.get(record.rolloutPath);
    if (
      cached?.statKey === currentStatKey &&
      cached.snapshot.workspaceRoot === workspaceRoot
    ) {
      return cached.snapshot;
    }
    const inFlight = this.inFlightByPath.get(record.rolloutPath);
    if (inFlight) {
      return inFlight;
    }
    const promise = this.scan(record).finally(() => {
      if (this.inFlightByPath.get(record.rolloutPath) === promise) {
        this.inFlightByPath.delete(record.rolloutPath);
      }
    });
    this.inFlightByPath.set(record.rolloutPath, promise);
    const snapshot = await promise;
    this.snapshotsByPath.set(record.rolloutPath, {
      // Bind the memory entry to the exact file revision the worker scanned.
      // If the rollout grew during the scan, the next request incrementally
      // catches up instead of treating the older snapshot as current.
      statKey: snapshotStatKey(snapshot),
      snapshot,
    });
    return snapshot;
  }

  private scan(record: CodexStoredSessionRecord): Promise<CodexTurnDirectorySnapshot> {
    const controller = new AbortController();
    this.scanAbortControllers.add(controller);
    return this.scheduler.schedule(
      (signal) => this.runScanWorker(record, signal),
      {
        signal: controller.signal,
        priority: HISTORY_WORKLOAD_PRIORITY.interactive,
      },
    ).finally(() => {
      this.scanAbortControllers.delete(controller);
    });
  }

  private hydrateSummaryPage(
    record: CodexStoredSessionRecord,
    cursor: { turnId: string; includeAnchor: boolean } | undefined,
    limit: number,
  ): Promise<CodexTurnSummaryPageWorkerResult> {
    const controller = new AbortController();
    this.scanAbortControllers.add(controller);
    return this.scheduler
      .schedule(
        (signal) => this.runSummaryWorker(record, cursor, limit, signal),
        {
          signal: controller.signal,
          priority: HISTORY_WORKLOAD_PRIORITY.interactive,
        },
      )
      .finally(() => {
        this.scanAbortControllers.delete(controller);
      });
  }

  private runScanWorker(
    record: CodexStoredSessionRecord,
    signal: AbortSignal,
  ): Promise<CodexTurnDirectorySnapshot> {
    return runBackgroundIpcTask<
      {
        kind: "codex-turn-directory";
        providerSessionId: string;
        rolloutPath: string;
        workspaceRoot: string;
        cachePath: string;
      },
      CodexTurnDirectoryWorkerResponse
    >({
      script: new URL("./codex-turn-directory-worker.ts", import.meta.url),
      request: {
          kind: "codex-turn-directory",
          providerSessionId: record.ref.providerSessionId,
          rolloutPath: record.rolloutPath,
          workspaceRoot: codexStoredSessionWorkspaceRoot(record) ?? "",
          cachePath: directoryCachePath(record.ref.providerSessionId),
        },
      label: "Codex turn directory worker",
      signal,
      timeoutMs: 120_000,
      maxResponseBytes: TURN_DIRECTORY_RESPONSE_BYTES,
      onSpawn: (worker) => {
        this.workers.add(worker);
      },
      onClose: (worker) => {
        this.workers.delete(worker);
      },
    }).then((response) => {
      if (response.ok && "snapshot" in response) {
        return response.snapshot;
      }
      if (response.ok) {
        throw new Error(
          "Codex turn directory worker returned an unexpected summary result.",
        );
      }
      throw new Error(response.error);
    });
  }

  private runSummaryWorker(
    record: CodexStoredSessionRecord,
    cursor: { turnId: string; includeAnchor: boolean } | undefined,
    limit: number,
    signal: AbortSignal,
  ): Promise<CodexTurnSummaryPageWorkerResult> {
    return runBackgroundIpcTask<
      {
        kind: "codex-turn-summary-page";
        providerSessionId: string;
        rolloutPath: string;
        cachePath: string;
        summaryCachePath: string;
        workspaceRoot: string;
        cursor?: { turnId: string; includeAnchor: boolean };
        limit: number;
        textBudgetBytes: number;
      },
      CodexTurnDirectoryWorkerResponse
    >({
      script: new URL("./codex-turn-directory-worker.ts", import.meta.url),
      request: {
        kind: "codex-turn-summary-page",
        providerSessionId: record.ref.providerSessionId,
        rolloutPath: record.rolloutPath,
        cachePath: directoryCachePath(record.ref.providerSessionId),
        summaryCachePath: summaryCachePath(record.ref.providerSessionId),
        workspaceRoot: codexStoredSessionWorkspaceRoot(record) ?? "",
        ...(cursor ? { cursor } : {}),
        limit,
        textBudgetBytes: SUMMARY_PAGE_TEXT_BUDGET_BYTES,
      },
      label: "Codex turn summary worker",
      signal,
      timeoutMs: 30_000,
      maxResponseBytes: TURN_SUMMARY_RESPONSE_BYTES,
      onSpawn: (worker) => {
        this.workers.add(worker);
      },
      onClose: (worker) => {
        this.workers.delete(worker);
      },
    }).then((response) => {
      if (response.ok && "summaryPage" in response) {
        return response.summaryPage;
      }
      if (response.ok) {
        throw new Error(
          "Codex turn summary worker returned an unexpected directory result.",
        );
      }
      throw new Error(response.error);
    });
  }

  private runLookupWorker(
    record: CodexStoredSessionRecord,
    turnIds: readonly string[],
    signal: AbortSignal,
  ): Promise<CodexIndexedTurn[]> {
    return runBackgroundIpcTask<
      {
        kind: "codex-turn-lookup";
        cachePath: string;
        turnIds: string[];
      },
      CodexTurnDirectoryWorkerResponse
    >({
      script: new URL("./codex-turn-directory-worker.ts", import.meta.url),
      request: {
        kind: "codex-turn-lookup",
        cachePath: directoryCachePath(record.ref.providerSessionId),
        turnIds: [...turnIds],
      },
      label: "Codex turn lookup worker",
      signal,
      timeoutMs: 30_000,
      maxResponseBytes: TURN_LOOKUP_RESPONSE_BYTES,
      onSpawn: (worker) => {
        this.workers.add(worker);
      },
      onClose: (worker) => {
        this.workers.delete(worker);
      },
    }).then((response) => {
      if (response.ok && "lookups" in response) {
        return response.lookups;
      }
      if (response.ok) {
        throw new Error(
          "Codex turn lookup worker returned an unexpected result.",
        );
      }
      throw new Error(response.error);
    });
  }

  private lookupTurns(
    record: CodexStoredSessionRecord,
    turnIds: readonly string[],
  ): Promise<CodexIndexedTurn[]> {
    const controller = new AbortController();
    this.scanAbortControllers.add(controller);
    return this.scheduler
      .schedule(
        (signal) =>
          this.runLookupWorker(
            record,
            turnIds,
            signal,
          ),
        {
          signal: controller.signal,
          priority: HISTORY_WORKLOAD_PRIORITY.interactive,
        },
      )
      .finally(() => {
        this.scanAbortControllers.delete(controller);
      });
  }
}

function isoToEpochSeconds(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp / 1_000 : 0;
}

function createTurnCursor(turnId: string, includeAnchor: boolean): string {
  return JSON.stringify({ turnId, includeAnchor });
}

function parseTurnCursor(cursor: string): { turnId: string; includeAnchor: boolean } | undefined {
  try {
    const parsed = JSON.parse(cursor) as Record<string, unknown>;
    return typeof parsed.turnId === "string"
      ? { turnId: parsed.turnId, includeAnchor: parsed.includeAnchor === true }
      : undefined;
  } catch {
    return cursor ? { turnId: cursor, includeAnchor: false } : undefined;
  }
}
