import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ProviderKind,
  StoredSessionArchiveBackend,
  StoredSessionIdentity,
  StoredSessionRef,
} from "@rah/runtime-protocol";

const STORAGE_VERSION = 1;
const STORAGE_FILE = "session-library.json";
const NATIVE_ARCHIVE_RECONCILIATION_GRACE_MS = 30_000;

export interface StoredSessionArchiveRecord extends StoredSessionIdentity {
  archivedAt: string;
  backend: StoredSessionArchiveBackend;
  workspaceDir?: string;
  snapshot: StoredSessionRef;
}

interface StoredSessionLibraryFile {
  version: number;
  updatedAt: string;
  archives: StoredSessionArchiveRecord[];
}

function resolveRahHome(): string {
  return process.env.RAH_HOME ?? path.join(os.homedir(), ".rah");
}

function identityKey(identity: StoredSessionIdentity): string {
  return `${identity.provider}:${identity.providerSessionId}`;
}

function isProviderKind(value: unknown): value is ProviderKind {
  return value === "codex" || value === "claude" || value === "opencode" || value === "custom";
}

function isArchiveBackend(value: unknown): value is StoredSessionArchiveBackend {
  return value === "provider_native" || value === "rah_overlay" || value === "rah_snapshot";
}

function withoutLibraryState(ref: StoredSessionRef): StoredSessionRef {
  const { libraryState: _libraryState, ...snapshot } = ref;
  void _libraryState;
  return snapshot;
}

function sanitizeStoredSessionRef(value: unknown): StoredSessionRef | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Partial<StoredSessionRef>;
  if (!isProviderKind(candidate.provider) || typeof candidate.providerSessionId !== "string") {
    return null;
  }
  const providerSessionId = candidate.providerSessionId.trim();
  if (!providerSessionId) {
    return null;
  }
  return withoutLibraryState({ ...candidate, providerSessionId } as StoredSessionRef);
}

function sanitizeArchiveRecord(value: unknown): StoredSessionArchiveRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Partial<StoredSessionArchiveRecord>;
  if (
    !isProviderKind(candidate.provider) ||
    typeof candidate.providerSessionId !== "string" ||
    !candidate.providerSessionId.trim() ||
    typeof candidate.archivedAt !== "string" ||
    !Number.isFinite(Date.parse(candidate.archivedAt)) ||
    !isArchiveBackend(candidate.backend)
  ) {
    return null;
  }
  const snapshot = sanitizeStoredSessionRef(candidate.snapshot);
  if (
    !snapshot ||
    snapshot.provider !== candidate.provider ||
    snapshot.providerSessionId !== candidate.providerSessionId.trim()
  ) {
    return null;
  }
  return {
    provider: candidate.provider,
    providerSessionId: candidate.providerSessionId.trim(),
    archivedAt: candidate.archivedAt,
    backend: candidate.backend,
    ...(typeof candidate.workspaceDir === "string" && candidate.workspaceDir.trim()
      ? { workspaceDir: candidate.workspaceDir.trim() }
      : {}),
    snapshot,
  };
}

function quarantineCorruptFile(filePath: string, error: unknown): void {
  if (!existsSync(filePath)) {
    return;
  }
  const quarantinePath = `${filePath}.corrupt-${Date.now()}`;
  try {
    renameSync(filePath, quarantinePath);
    console.warn("[rah:session-library] quarantined unreadable registry", {
      filePath,
      quarantinePath,
      error,
    });
  } catch (renameError) {
    console.warn("[rah:session-library] failed to quarantine unreadable registry", {
      filePath,
      error,
      renameError,
    });
  }
}

function mergeSnapshot(snapshot: StoredSessionRef, discovered: StoredSessionRef): StoredSessionRef {
  return {
    ...snapshot,
    ...withoutLibraryState(discovered),
    provider: discovered.provider,
    providerSessionId: discovered.providerSessionId,
  };
}

/**
 * Persists RAH's cross-provider archive placement. Provider-native archive
 * state remains an input to projection, never the only source of recovery
 * metadata.
 */
export class StoredSessionLibraryStore {
  private readonly rootDir: string;
  private readonly filePath: string;
  private records = new Map<string, StoredSessionArchiveRecord>();
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(rootDir = path.join(resolveRahHome(), "runtime-daemon")) {
    this.rootDir = rootDir;
    this.filePath = path.join(rootDir, STORAGE_FILE);
    mkdirSync(rootDir, { recursive: true });
  }

  load(): StoredSessionArchiveRecord[] {
    if (!existsSync(this.filePath)) {
      this.records.clear();
      return [];
    }
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<StoredSessionLibraryFile>;
      const next = new Map<string, StoredSessionArchiveRecord>();
      for (const raw of Array.isArray(parsed.archives) ? parsed.archives : []) {
        const record = sanitizeArchiveRecord(raw);
        if (record) {
          next.set(identityKey(record), record);
        }
      }
      this.records = next;
      return this.list();
    } catch (error) {
      quarantineCorruptFile(this.filePath, error);
      this.records.clear();
      return [];
    }
  }

  list(): StoredSessionArchiveRecord[] {
    return [...this.records.values()].map((record) => ({
      ...record,
      snapshot: { ...record.snapshot },
    }));
  }

  find(identity: StoredSessionIdentity): StoredSessionArchiveRecord | undefined {
    const record = this.records.get(identityKey(identity));
    return record
      ? { ...record, snapshot: { ...record.snapshot } }
      : undefined;
  }

  async archive(
    session: StoredSessionRef,
    options: {
      backend: StoredSessionArchiveBackend;
      archivedAt?: string;
      workspaceDir?: string;
    },
  ): Promise<StoredSessionArchiveRecord> {
    const archivedAt = options.archivedAt ?? new Date().toISOString();
    const record: StoredSessionArchiveRecord = {
      provider: session.provider,
      providerSessionId: session.providerSessionId,
      archivedAt,
      backend: options.backend,
      ...(options.workspaceDir ? { workspaceDir: options.workspaceDir } : {}),
      snapshot: withoutLibraryState(session),
    };
    return await this.enqueueMutation((draft) => {
      draft.set(identityKey(record), record);
      return {
        changed: true,
        value: { ...record, snapshot: { ...record.snapshot } },
      };
    });
  }

  async restore(identity: StoredSessionIdentity): Promise<void> {
    await this.enqueueMutation((draft) => ({
      changed: draft.delete(identityKey(identity)),
      value: undefined,
    }));
  }

  async remove(identity: StoredSessionIdentity): Promise<void> {
    await this.restore(identity);
  }

  project(sessions: readonly StoredSessionRef[]): StoredSessionRef[] {
    const projected: StoredSessionRef[] = [];
    const seen = new Set<string>();
    for (const discovered of sessions) {
      const key = identityKey(discovered);
      let record = this.records.get(key);
      const providerArchived = discovered.providerState?.archived === true;
      if (
        record?.backend === "provider_native" &&
        !providerArchived &&
        Date.now() - Date.parse(record.archivedAt) >= NATIVE_ARCHIVE_RECONCILIATION_GRACE_MS
      ) {
        record = undefined;
        void this.restore(discovered).catch((error) => {
          console.warn("[rah:session-library] failed to persist native archive reconciliation", {
            key,
            error,
          });
        });
      }
      const archived = providerArchived || record !== undefined;
      seen.add(key);
      if (!archived) {
        const { libraryState: _libraryState, ...normal } = discovered;
        void _libraryState;
        projected.push(normal);
        continue;
      }
      const merged = record ? mergeSnapshot(record.snapshot, discovered) : discovered;
      projected.push({
        ...merged,
        libraryState: {
          placement: "archive",
          ...(discovered.providerState?.archivedAt ?? record?.archivedAt
            ? {
                archivedAt:
                  discovered.providerState?.archivedAt ?? record!.archivedAt,
              }
            : {}),
          backend: providerArchived ? "provider_native" : record?.backend ?? "rah_overlay",
        },
      });
    }
    for (const [key, record] of this.records) {
      if (seen.has(key)) {
        continue;
      }
      projected.push({
        ...record.snapshot,
        libraryState: {
          placement: "archive",
          archivedAt: record.archivedAt,
          backend: record.backend,
        },
      });
    }
    return projected;
  }

  async flush(): Promise<void> {
    await this.mutationQueue;
  }

  private enqueueMutation<T>(
    mutate: (
      draft: Map<string, StoredSessionArchiveRecord>,
    ) => { changed: boolean; value: T },
  ): Promise<T> {
    const operation = this.mutationQueue.then(async () => {
      const draft = new Map(this.records);
      const result = mutate(draft);
      if (result.changed) {
        await this.persist(draft);
        this.records = draft;
      }
      return result.value;
    });
    this.mutationQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async persist(records: ReadonlyMap<string, StoredSessionArchiveRecord>): Promise<void> {
    const value: StoredSessionLibraryFile = {
      version: STORAGE_VERSION,
      updatedAt: new Date().toISOString(),
      archives: [...records.values()].map((record) => ({
        ...record,
        snapshot: { ...record.snapshot },
      })),
    };
    mkdirSync(this.rootDir, { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(value, null, 2), "utf8");
    await rename(temporaryPath, this.filePath);
  }
}

export function isStoredSessionArchived(session: StoredSessionRef): boolean {
  return (
    session.libraryState?.placement === "archive" ||
    session.providerState?.archived === true
  );
}
