import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { ConversationTurnDirectoryResponse } from "@rah/runtime-protocol";
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
        .map(
          (
            {
              startOffset: _startOffset,
              endOffset: _endOffset,
              hasFinalAnswer: _hasFinalAnswer,
              ...item
            },
            ordinal,
          ) => ({ ...item, ordinal }),
        ),
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
