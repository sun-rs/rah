import { readFileSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type {
  ConversationTurnFileChangesProjection,
  ManagedSession,
  TurnFileChangesResponse,
  TurnFileDiffResponse,
} from "@rah/runtime-protocol";
import { parseUnifiedDiff } from "./unified-diff-summary";

const ARTIFACT_VERSION = 2;
const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
const DEFAULT_MAX_TURN_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_ARTIFACTS_PER_SESSION = 200;
const DEFAULT_MAX_ARTIFACTS = 2_000;
const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAINTENANCE_INTERVAL_MS = 15 * 60 * 1_000;
const DEFAULT_STALE_FILE_GRACE_MS = 5 * 60 * 1_000;

type StoredTurnFile = {
  path: string;
  diffFile: string;
  truncated: boolean;
};

type StoredTurnArtifact = {
  version: typeof ARTIFACT_VERSION;
  ownerId: string;
  turnId: string;
  capturedAt: string;
  fileChanges: ConversationTurnFileChangesProjection;
  truncated: boolean;
  files: StoredTurnFile[];
};

type StoredArtifactRecord = {
  artifact: StoredTurnArtifact;
  turnDir: string;
  sessionDir: string;
  capturedAtMs: number;
  bytes: number;
};

export type TurnArtifactStoreOptions = {
  rootDir?: string;
  maxFileBytes?: number;
  maxTurnBytes?: number;
  maxArtifactsPerSession?: number;
  maxArtifacts?: number;
  maxTotalBytes?: number;
  maxAgeMs?: number;
  maintenanceIntervalMs?: number;
  staleFileGraceMs?: number;
  now?: () => number;
};

export function turnArtifactOwnerKey(
  runtimeSessionId: string,
  session?: Pick<ManagedSession, "provider" | "providerSessionId">,
): string {
  const providerSessionId = session?.providerSessionId?.trim();
  if (session && providerSessionId) {
    return `provider:${session.provider}\0${providerSessionId}`;
  }
  return `runtime\0${runtimeSessionId}`;
}

function resolveRahHome(): string {
  return process.env.RAH_HOME ?? path.join(os.homedir(), ".rah");
}

function digest(value: string, length = 32): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function utf8Prefix(value: string, maxBytes: number): {
  value: string;
  truncated: boolean;
  bytes: number;
} {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) {
    return { value, truncated: false, bytes: buffer.byteLength };
  }
  const prefix = buffer
    .subarray(0, Math.max(0, maxBytes))
    .toString("utf8")
    .replace(/\uFFFD+$/, "");
  return {
    value: prefix,
    truncated: true,
    bytes: Buffer.byteLength(prefix, "utf8"),
  };
}

function isStoredTurnFile(value: unknown): value is StoredTurnFile {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as StoredTurnFile).path === "string" &&
    typeof (value as StoredTurnFile).diffFile === "string" &&
    typeof (value as StoredTurnFile).truncated === "boolean"
  );
}

function parseStoredArtifact(value: unknown): StoredTurnArtifact | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return null;
  }
  const candidate = value as Partial<StoredTurnArtifact>;
  if (
    candidate.version !== ARTIFACT_VERSION ||
    typeof candidate.ownerId !== "string" ||
    typeof candidate.turnId !== "string" ||
    typeof candidate.capturedAt !== "string" ||
    typeof candidate.truncated !== "boolean" ||
    typeof candidate.fileChanges !== "object" ||
    candidate.fileChanges === null ||
    !Array.isArray(candidate.files) ||
    !candidate.files.every(isStoredTurnFile)
  ) {
    return null;
  }
  return candidate as StoredTurnArtifact;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

export class TurnArtifactStore {
  private readonly rootDir: string;
  private readonly maxFileBytes: number;
  private readonly maxTurnBytes: number;
  private readonly maxArtifactsPerSession: number;
  private readonly maxArtifacts: number;
  private readonly maxTotalBytes: number;
  private readonly maxAgeMs: number;
  private readonly maintenanceIntervalMs: number;
  private readonly staleFileGraceMs: number;
  private readonly now: () => number;
  private readonly pendingWrites = new Map<
    string,
    Promise<ConversationTurnFileChangesProjection>
  >();
  private readonly activeTurnDirs = new Set<string>();
  private maintenancePromise: Promise<void> | undefined;
  private lastMaintenanceAt: number;

  constructor(options: TurnArtifactStoreOptions = {}) {
    this.rootDir =
      options.rootDir ?? path.join(resolveRahHome(), "runtime-daemon", "turn-artifacts");
    this.maxFileBytes = Math.max(0, options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES);
    this.maxTurnBytes = Math.max(0, options.maxTurnBytes ?? DEFAULT_MAX_TURN_BYTES);
    this.maxArtifactsPerSession = Math.max(
      1,
      options.maxArtifactsPerSession ?? DEFAULT_MAX_ARTIFACTS_PER_SESSION,
    );
    this.maxArtifacts = Math.max(1, options.maxArtifacts ?? DEFAULT_MAX_ARTIFACTS);
    this.maxTotalBytes = Math.max(0, options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES);
    this.maxAgeMs = Math.max(0, options.maxAgeMs ?? DEFAULT_MAX_AGE_MS);
    this.maintenanceIntervalMs = Math.max(
      0,
      options.maintenanceIntervalMs ?? DEFAULT_MAINTENANCE_INTERVAL_MS,
    );
    this.staleFileGraceMs = Math.max(
      0,
      options.staleFileGraceMs ?? DEFAULT_STALE_FILE_GRACE_MS,
    );
    this.now = options.now ?? Date.now;
    this.lastMaintenanceAt = this.now();
  }

  replaceTurnDiff(
    ownerId: string,
    turnId: string,
    unifiedDiff: string,
  ): Promise<ConversationTurnFileChangesProjection> {
    const key = `${ownerId}\0${turnId}`;
    const previous = this.pendingWrites.get(key);
    const write = previous
      ? previous
          .catch(() => undefined)
          .then(() => this.persistTurnDiff(ownerId, turnId, unifiedDiff))
      : this.persistTurnDiff(ownerId, turnId, unifiedDiff);
    this.pendingWrites.set(key, write);
    const clear = () => {
      if (this.pendingWrites.get(key) === write) {
        this.pendingWrites.delete(key);
      }
    };
    void write.then(clear, clear);
    return write;
  }

  getTurnFileChanges(
    ownerId: string,
    turnId: string,
    responseSessionId = ownerId,
  ): TurnFileChangesResponse {
    const artifact = this.requireArtifact(ownerId, turnId);
    return {
      sessionId: responseSessionId,
      turnId,
      fileChanges: artifact.fileChanges,
      capturedAt: artifact.capturedAt,
      truncated: artifact.truncated,
    };
  }

  getTurnFileDiff(
    ownerId: string,
    turnId: string,
    filePath: string,
    responseSessionId = ownerId,
  ): TurnFileDiffResponse {
    const artifact = this.requireArtifact(ownerId, turnId);
    const file = artifact.files.find((candidate) => candidate.path === filePath);
    if (!file) {
      throw new Error(`Unknown turn file ${filePath}.`);
    }
    if (path.basename(file.diffFile) !== file.diffFile) {
      throw new Error("Turn artifact manifest is invalid.");
    }
    let diff: string;
    try {
      diff = readFileSync(path.join(this.turnDir(ownerId, turnId), file.diffFile), "utf8");
    } catch {
      throw new Error("Turn artifact manifest is invalid.");
    }
    return {
      sessionId: responseSessionId,
      turnId,
      path: file.path,
      diff,
      truncated: file.truncated,
    };
  }

  async runMaintenance(): Promise<void> {
    if (this.maintenancePromise) {
      return this.maintenancePromise;
    }
    const maintenance = (async () => {
      await this.waitForPendingWrites();
      await this.performMaintenance();
      this.lastMaintenanceAt = this.now();
    })();
    this.maintenancePromise = maintenance;
    try {
      await maintenance;
    } finally {
      if (this.maintenancePromise === maintenance) {
        this.maintenancePromise = undefined;
      }
    }
  }

  async flush(): Promise<void> {
    await this.waitForPendingWrites();
    if (this.maintenancePromise) {
      await this.maintenancePromise;
    }
  }

  private async persistTurnDiff(
    ownerId: string,
    turnId: string,
    unifiedDiff: string,
  ): Promise<ConversationTurnFileChangesProjection> {
    const turnDir = this.turnDir(ownerId, turnId);
    this.activeTurnDirs.add(turnDir);
    let summary: ConversationTurnFileChangesProjection;
    try {
      // Keep parsing out of the app-server notification stack and serialize it per turn.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const parsed = parseUnifiedDiff(unifiedDiff);
      summary = parsed.summary;
      await mkdir(turnDir, { recursive: true, mode: 0o700 });

      const revision = `${this.now()}-${randomUUID()}`;
      const writtenFiles: string[] = [];
      let temporaryManifestPath: string | undefined;
      const files: StoredTurnFile[] = [];
      let remainingBytes = this.maxTurnBytes;
      let turnTruncated = false;
      let committed = false;

      try {
        for (const file of parsed.files) {
          const allowedBytes = Math.min(this.maxFileBytes, remainingBytes);
          const storedDiff = utf8Prefix(file.diff, allowedBytes);
          const diffFile = `${revision}-${digest(file.path, 20)}.diff`;
          const diffPath = path.join(turnDir, diffFile);
          await writeFile(diffPath, storedDiff.value, { encoding: "utf8", mode: 0o600 });
          writtenFiles.push(diffPath);
          remainingBytes = Math.max(0, remainingBytes - storedDiff.bytes);
          const truncated =
            storedDiff.truncated || Buffer.byteLength(file.diff, "utf8") > allowedBytes;
          turnTruncated ||= truncated;
          files.push({ path: file.path, diffFile, truncated });
        }

        const manifest: StoredTurnArtifact = {
          version: ARTIFACT_VERSION,
          ownerId,
          turnId,
          capturedAt: new Date(this.now()).toISOString(),
          fileChanges: parsed.summary,
          truncated: turnTruncated,
          files,
        };
        const manifestPath = path.join(turnDir, "manifest.json");
        temporaryManifestPath = `${manifestPath}.${revision}.tmp`;
        await writeFile(temporaryManifestPath, `${JSON.stringify(manifest)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        await rename(temporaryManifestPath, manifestPath);
        committed = true;
      } catch (error) {
        if (!committed) {
          await Promise.all(
            writtenFiles.map((writtenFile) => rm(writtenFile, { force: true })),
          );
          if (temporaryManifestPath) {
            await rm(temporaryManifestPath, { force: true });
          }
        }
        throw error;
      }
    } finally {
      this.activeTurnDirs.delete(turnDir);
    }

    if (this.now() - this.lastMaintenanceAt >= this.maintenanceIntervalMs) {
      void this.runMaintenance().catch((error) => {
        console.warn("[rah] turn artifact maintenance failed", { error });
      });
    }
    return summary;
  }

  private requireArtifact(ownerId: string, turnId: string): StoredTurnArtifact {
    const manifestPath = path.join(this.turnDir(ownerId, turnId), "manifest.json");
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      throw new Error(`Unknown turn artifact ${turnId}.`);
    }
    const artifact = parseStoredArtifact(parsed);
    if (
      !artifact ||
      artifact.ownerId !== ownerId ||
      artifact.turnId !== turnId
    ) {
      throw new Error("Turn artifact manifest is invalid.");
    }
    return artifact;
  }

  private turnDir(ownerId: string, turnId: string): string {
    return path.join(this.rootDir, digest(ownerId), digest(turnId));
  }

  private async waitForPendingWrites(): Promise<void> {
    while (this.pendingWrites.size > 0) {
      await Promise.allSettled([...this.pendingWrites.values()]);
    }
  }

  private async performMaintenance(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    const records: StoredArtifactRecord[] = [];
    const sessionDirs: string[] = [];
    const rootEntries = await readdir(this.rootDir, { withFileTypes: true });

    for (const sessionEntry of rootEntries) {
      if (!sessionEntry.isDirectory()) continue;
      const sessionDir = path.join(this.rootDir, sessionEntry.name);
      sessionDirs.push(sessionDir);
      const turnEntries = await readdir(sessionDir, { withFileTypes: true });
      for (const turnEntry of turnEntries) {
        if (!turnEntry.isDirectory()) continue;
        const turnDir = path.join(sessionDir, turnEntry.name);
        if (this.activeTurnDirs.has(turnDir)) continue;
        const record = await this.inspectArtifactDirectory(sessionDir, turnDir);
        if (record) records.push(record);
      }
    }

    const removeDirs = new Set<string>();
    const cutoff = this.now() - this.maxAgeMs;
    for (const record of records) {
      if (this.maxAgeMs === 0 || record.capturedAtMs <= cutoff) {
        removeDirs.add(record.turnDir);
      }
    }

    const bySession = new Map<string, StoredArtifactRecord[]>();
    for (const record of records) {
      const group = bySession.get(record.artifact.ownerId) ?? [];
      group.push(record);
      bySession.set(record.artifact.ownerId, group);
    }
    for (const group of bySession.values()) {
      group.sort((left, right) => right.capturedAtMs - left.capturedAtMs);
      for (const record of group.slice(this.maxArtifactsPerSession)) {
        removeDirs.add(record.turnDir);
      }
    }

    const newestFirst = [...records].sort(
      (left, right) => right.capturedAtMs - left.capturedAtMs,
    );
    let retainedBytes = 0;
    let retainedCount = 0;
    for (const record of newestFirst) {
      if (removeDirs.has(record.turnDir)) continue;
      retainedCount += 1;
      retainedBytes += record.bytes;
      if (
        retainedCount > this.maxArtifacts ||
        retainedBytes > this.maxTotalBytes
      ) {
        removeDirs.add(record.turnDir);
      }
    }

    await Promise.all(
      [...removeDirs].map((turnDir) => rm(turnDir, { recursive: true, force: true })),
    );
    await Promise.all(
      sessionDirs.map(async (sessionDir) => {
        try {
          await rm(sessionDir, { recursive: false });
        } catch {
          // Non-empty session directories are expected.
        }
      }),
    );
  }

  private async inspectArtifactDirectory(
    sessionDir: string,
    turnDir: string,
  ): Promise<StoredArtifactRecord | null> {
    let artifact: StoredTurnArtifact | null = null;
    try {
      artifact = parseStoredArtifact(
        JSON.parse(await readFile(path.join(turnDir, "manifest.json"), "utf8")),
      );
    } catch {
      // A damaged manifest remains for diagnostics; only stale revisions are cleaned.
    }

    const currentFiles = new Set(artifact?.files.map((file) => file.diffFile) ?? []);
    const entries = await readdir(turnDir, { withFileTypes: true });
    let bytes = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const entryPath = path.join(turnDir, entry.name);
      let entryStat;
      try {
        entryStat = await stat(entryPath);
      } catch (error) {
        if (isNotFound(error)) continue;
        throw error;
      }
      const isStaleDiff = entry.name.endsWith(".diff") && !currentFiles.has(entry.name);
      const isTemporary = entry.name.endsWith(".tmp");
      if (
        (isStaleDiff || isTemporary) &&
        this.now() - entryStat.mtimeMs >= this.staleFileGraceMs
      ) {
        await rm(entryPath, { force: true });
        continue;
      }
      bytes += entryStat.size;
    }
    if (!artifact) {
      try {
        const turnStat = await stat(turnDir);
        if (
          this.maxAgeMs === 0 ||
          this.now() - turnStat.mtimeMs >= this.maxAgeMs
        ) {
          await rm(turnDir, { recursive: true, force: true });
        }
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      return null;
    }
    const capturedAtMs = Date.parse(artifact.capturedAt);
    return {
      artifact,
      turnDir,
      sessionDir,
      capturedAtMs: Number.isFinite(capturedAtMs) ? capturedAtMs : 0,
      bytes,
    };
  }
}
