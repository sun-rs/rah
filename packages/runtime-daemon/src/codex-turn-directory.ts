import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { ConversationTurnDirectoryResponse } from "@rah/runtime-protocol";
import type { CodexAppServerTurnsPage } from "./codex-app-server-turns-page";
import type { CodexStoredSessionRecord } from "./codex-stored-session-types";
import type { CodexTurnDirectorySnapshot } from "./codex-turn-directory-worker";

type WorkerResponse =
  | { ok: true; snapshot: CodexTurnDirectorySnapshot }
  | { ok: false; error: string };

function resolveRahRuntimeHome(): string {
  return process.env.RAH_HOME ?? path.join(os.homedir(), ".rah", "runtime-daemon");
}

function cacheKey(providerSessionId: string): string {
  return createHash("sha256").update(providerSessionId).digest("hex").slice(0, 32);
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

function statKey(filePath: string): string {
  const stats = statSync(filePath);
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
  private readonly workers = new Set<Worker>();

  async getDirectory(
    sessionId: string,
    record: CodexStoredSessionRecord,
  ): Promise<ConversationTurnDirectoryResponse> {
    const snapshot = await this.getSnapshot(record);
    const sourceIsCurrent = snapshotStatKey(snapshot) === statKey(record.rolloutPath);
    return {
      sessionId,
      revision: sourceRevision(snapshot),
      items: snapshot.items
        .filter((item) => item.userPreview)
        .map((item, ordinal) => ({
          id: item.id,
          ordinal,
          userPreview: item.userPreview,
          ...(item.assistantPreview !== undefined
            ? { assistantPreview: item.assistantPreview }
            : {}),
          startedAt: item.startedAt,
          ...(item.completedAt !== undefined ? { completedAt: item.completedAt } : {}),
          ...(item.durationMs !== undefined ? { durationMs: item.durationMs } : {}),
          status: item.status,
        })),
      complete: sourceIsCurrent && snapshot.scannedBytes >= snapshot.source.size,
      sourceBytes: snapshot.source.size,
      generatedAt: snapshot.generatedAt,
    };
  }

  async getTurnRange(
    record: CodexStoredSessionRecord,
    turnId: string,
  ): Promise<{ startOffset: number; endOffset: number } | null> {
    const snapshot = await this.getSnapshot(record);
    const item = snapshot.items.find((candidate) => candidate.id === turnId);
    return item ? { startOffset: item.startOffset, endOffset: item.endOffset } : null;
  }

  async getSummaryPage(
    record: CodexStoredSessionRecord,
    options: { cursor?: string; limit: number; sourceSettled: boolean },
  ): Promise<CodexAppServerTurnsPage> {
    const snapshot = await this.getSnapshot(record);
    const indexedTurns = snapshot.items.filter((item) => item.userText || item.userPreview);
    const anchor = options.cursor ? parseTurnCursor(options.cursor) : undefined;
    let startIndex = indexedTurns.length - 1;
    if (anchor) {
      const anchorIndex = indexedTurns.findIndex((item) => item.id === anchor.turnId);
      if (anchorIndex < 0) {
        throw new Error("Codex history cursor no longer exists in the indexed rollout.");
      }
      startIndex = anchor.includeAnchor ? anchorIndex : anchorIndex - 1;
    }
    const selected = indexedTurns
      .slice(Math.max(0, startIndex - options.limit + 1), startIndex + 1)
      .reverse();
    const data = selected.map((item, index) => {
      const isTrailing = !options.cursor && index === 0;
      const status =
        item.status === "in_progress" && options.sourceSettled && isTrailing
          ? "interrupted"
          : item.status === "in_progress"
            ? "inProgress"
            : item.status;
      const userText = item.userText ?? item.userPreview;
      const items: unknown[] = [
        {
          type: "userMessage",
          id: item.userItemId ?? `history-user:${item.id}`,
          content: [{ type: "text", text: userText, text_elements: [] }],
        },
      ];
      if (item.assistantText || item.assistantPreview) {
        items.push({
          type: "agentMessage",
          id: item.assistantItemId ?? `history-assistant:${item.id}`,
          text: item.assistantText ?? item.assistantPreview,
          phase: item.assistantPhase ?? (item.hasFinalAnswer ? "final_answer" : "commentary"),
          memoryCitation: null,
        });
      }
      return {
        id: item.id,
        items,
        itemsView: "summary",
        status,
        error: item.status === "failed" ? { message: "Codex turn failed" } : null,
        startedAt: isoToEpochSeconds(item.startedAt),
        completedAt: item.completedAt ? isoToEpochSeconds(item.completedAt) : null,
        durationMs: item.durationMs ?? null,
      };
    });
    const oldest = selected.at(-1);
    const oldestIndex = oldest
      ? indexedTurns.findIndex((item) => item.id === oldest.id)
      : -1;
    return {
      data,
      ...(oldest && oldestIndex > 0
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
    const workers = [...this.workers];
    this.workers.clear();
    await Promise.all(workers.map((worker) => worker.terminate().then(() => undefined)));
  }

  private async getSnapshot(record: CodexStoredSessionRecord): Promise<CodexTurnDirectorySnapshot> {
    const currentStatKey = statKey(record.rolloutPath);
    const cached = this.snapshotsByPath.get(record.rolloutPath);
    if (cached?.statKey === currentStatKey) {
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
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL("./codex-turn-directory-worker.ts", import.meta.url), {
        workerData: {
          kind: "codex-turn-directory",
          providerSessionId: record.ref.providerSessionId,
          rolloutPath: record.rolloutPath,
          cachePath: path.join(
            resolveRahRuntimeHome(),
            "turn-directory",
            "codex",
            `${cacheKey(record.ref.providerSessionId)}.json`,
          ),
        },
      });
      this.workers.add(worker);
      let settled = false;
      const finish = () => {
        this.workers.delete(worker);
      };
      worker.once("message", (response: WorkerResponse) => {
        settled = true;
        finish();
        if (response.ok) {
          resolve(response.snapshot);
        } else {
          reject(new Error(response.error));
        }
      });
      worker.once("error", (error) => {
        settled = true;
        finish();
        reject(error);
      });
      worker.once("exit", (code) => {
        finish();
        if (!settled) {
          reject(
            new Error(
              code === 0
                ? "Codex turn directory worker exited without a result."
                : `Codex turn directory worker exited with code ${code}.`,
            ),
          );
        }
      });
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
