import type {
  ResumeSessionRequest,
  ResumeSessionResponse,
  ConversationEvidencePage,
  StoredSessionRef,
} from "@rah/runtime-protocol";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import type {
  ProviderAdapter,
  ProviderShutdownAdapter,
  ProviderStoredHistoryAdapter,
  RuntimeServices,
} from "./provider-adapter";
import type { StoredSessionCatalogRecord } from "./stored-session-catalog-types";
import {
  deleteOpenCodeStoredSessionAsync,
  findOpenCodeStoredSessionRecordAsync,
  getOpenCodeStoredSessionTurnDetailAsync,
  getOpenCodeStoredSessionTurnDirectoryAsync,
  getOpenCodeStoredSessionTurnHistoryPageAsync,
  resolveOpenCodeStoredSessionWatchRoots,
  resumeOpenCodeStoredSession,
  restoreOpenCodeStoredSessionAsync,
  type OpenCodeStoredSessionRecord,
} from "./opencode-stored-sessions";
import {
  finalizeStoredReplayResume,
  prepareProviderSessionResume,
} from "./provider-resume";
import {
  archiveOpenCodeSession,
  startOpenCodeServer,
  stopOpenCodeServer,
  type OpenCodeServerHandle,
} from "./opencode-api";

export class OpenCodeStoredHistoryAdapter
  implements ProviderAdapter, ProviderStoredHistoryAdapter, ProviderShutdownAdapter
{
  readonly id = "opencode-stored-history";
  readonly providers: Array<"opencode"> = ["opencode"];
  readonly storedSessionArchiveBackend = "provider_native" as const;

  private storedSessionIndex = new Map<string, OpenCodeStoredSessionRecord>();
  private readonly rehydratedSessionIds = new Set<string>();
  private archiveServer: OpenCodeServerHandle | null = null;
  private archiveServerPromise: Promise<OpenCodeServerHandle> | null = null;

  constructor(private readonly services: RuntimeServices) {}

  async resumeStoredSession(request: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    const preparedResume = prepareProviderSessionResume({
      services: this.services,
      provider: "opencode",
      providerSessionId: request.providerSessionId,
      preferStoredReplay: true,
      rehydratedSessionIds: this.rehydratedSessionIds,
    });
    try {
      const record = await this.findRecord(request.providerSessionId);
      if (!record) {
        throw new Error(`Unknown OpenCode session ${request.providerSessionId}.`);
      }
      return finalizeStoredReplayResume({
        services: this.services,
        provider: "opencode",
        providerSessionId: request.providerSessionId,
        rehydratedSessionIds: this.rehydratedSessionIds,
        createSession: () =>
          resumeOpenCodeStoredSession(
            request.attach !== undefined
              ? { services: this.services, record, attach: request.attach }
              : { services: this.services, record },
          ),
      });
    } catch (error) {
      preparedResume.rollback();
      throw error;
    }
  }

  async getSessionConversationSourceRevision(
    sessionId: string,
  ): Promise<string | undefined> {
    const record = await this.findRecordForRuntimeSession(sessionId);
    if (!record) {
      return undefined;
    }
    const revisions: string[] = [];
    for (const sourcePath of [
      record.databasePath,
      `${record.databasePath}-wal`,
      `${record.databasePath}-shm`,
    ]) {
      try {
        const source = await stat(sourcePath);
        revisions.push(
          `${sourcePath === record.databasePath ? "db" : sourcePath.endsWith("-wal") ? "wal" : "shm"}:${Math.trunc(source.mtimeMs)}:${source.size}`,
        );
      } catch {
        // SQLite sidecars are optional and may disappear after a checkpoint.
      }
    }
    return revisions.length > 0 ? revisions.join("|") : undefined;
  }

  async getConversationSummaryEvidencePage(
    sessionId: string,
    options: { cursor?: string; limit?: number } = {},
  ): Promise<ConversationEvidencePage | undefined> {
    const record = await this.findRecordForRuntimeSession(sessionId);
    if (!record) {
      return undefined;
    }
    const runtime = this.services.sessionStore.getSession(sessionId)?.session.runtime;
    return getOpenCodeStoredSessionTurnHistoryPageAsync({
      sessionId,
      record,
      ...(options.cursor ? { cursor: options.cursor } : {}),
      ...(options.limit ? { limit: options.limit } : {}),
      // A read-only replay represents settled history. A live structured
      // session gets its lifecycle from the server overlay, so an unfinished
      // database tail must remain in progress rather than being fabricated as
      // completed by the pager.
      finalizeTrailingTurn: runtime?.structuredLiveEvents !== true,
    });
  }

  async getSessionConversationDirectory(sessionId: string) {
    const record = await this.findRecordForRuntimeSession(sessionId);
    if (!record) {
      return {
        sessionId,
        revision: "missing",
        items: [],
        complete: false,
        generatedAt: new Date().toISOString(),
      };
    }
    return getOpenCodeStoredSessionTurnDirectoryAsync({ sessionId, record });
  }

  async getSessionConversationTurnDetail(
    sessionId: string,
    options: { providerTurnId: string },
  ): Promise<ConversationEvidencePage | undefined> {
    const record = await this.findRecordForRuntimeSession(sessionId);
    if (!record) {
      return undefined;
    }
    return getOpenCodeStoredSessionTurnDetailAsync({
      sessionId,
      record,
      providerTurnId: options.providerTurnId,
    });
  }

  listStoredSessions(): StoredSessionRef[] {
    return [...this.storedSessionIndex.values()].map((record) => record.ref);
  }

  hydrateStoredSessionsCatalog(records: readonly StoredSessionCatalogRecord[]): void {
    this.storedSessionIndex = new Map(
      records
        .filter((record) => record.ref.provider === "opencode")
        .map((record) => [
          record.ref.providerSessionId,
          { ref: record.ref, databasePath: record.storagePath },
        ] as const),
    );
  }

  listStoredSessionWatchRoots(): string[] {
    return resolveOpenCodeStoredSessionWatchRoots();
  }

  async archiveStoredSession(session: StoredSessionRef): Promise<"provider_native"> {
    const record = await this.findRecord(session.providerSessionId);
    if (!record) {
      throw new Error(`Could not find a stored OpenCode session for ${session.providerSessionId}.`);
    }
    if (record.ref.providerState?.archived === true) {
      return "provider_native";
    }
    const recordedCwd = record.ref.cwd ?? record.ref.rootDir;
    const cwd = recordedCwd && existsSync(recordedCwd) ? recordedCwd : process.cwd();
    const server = await this.getArchiveServer(cwd);
    let archivedAtMs: number;
    try {
      const updated = await archiveOpenCodeSession({
        handle: {
          baseUrl: server.baseUrl,
          cwd,
          ...(server.authHeader ? { authHeader: server.authHeader } : {}),
        },
        providerSessionId: session.providerSessionId,
      });
      if (typeof updated.time?.archived !== "number") {
        throw new Error(
          `OpenCode did not confirm native archive for ${session.providerSessionId}.`,
        );
      }
      archivedAtMs = updated.time.archived;
    } catch (error) {
      await this.resetArchiveServer();
      throw error;
    }
    this.storedSessionIndex.set(session.providerSessionId, {
      ...record,
      ref: {
        ...record.ref,
        providerState: {
          ...record.ref.providerState,
          archived: true,
          archivedAt: new Date(archivedAtMs).toISOString(),
        },
      },
    });
    return "provider_native";
  }

  async removeStoredSession(session: StoredSessionRef): Promise<void> {
    const record = await this.findRecord(session.providerSessionId);
    if (!record) {
      throw new Error(`Could not find a stored OpenCode session for ${session.providerSessionId}.`);
    }
    await deleteOpenCodeStoredSessionAsync(record);
    this.storedSessionIndex.delete(session.providerSessionId);
  }

  async restoreStoredSession(session: StoredSessionRef): Promise<void> {
    const record = await this.findRecord(session.providerSessionId);
    if (!record) {
      throw new Error(`Could not find a stored OpenCode session for ${session.providerSessionId}.`);
    }
    // OpenCode 1.18.4 exposes archive through session.update, but its public
    // schema only accepts a numeric archived timestamp and silently ignores
    // null. Clearing the provider-owned field is therefore the narrow,
    // reversible counterpart until an official unarchive endpoint exists.
    await restoreOpenCodeStoredSessionAsync(record);
    const { archived: _archived, archivedAt: _archivedAt, ...providerState } =
      record.ref.providerState ?? {};
    void _archived;
    void _archivedAt;
    const { providerState: _oldProviderState, ...ref } = record.ref;
    void _oldProviderState;
    this.storedSessionIndex.set(session.providerSessionId, {
      ...record,
      ref: {
        ...ref,
        ...(Object.keys(providerState).length > 0 ? { providerState } : {}),
      },
    });
  }

  async shutdown(): Promise<void> {
    await this.resetArchiveServer();
  }

  private async findRecordForRuntimeSession(
    sessionId: string,
  ): Promise<OpenCodeStoredSessionRecord | undefined> {
    const state = this.services.sessionStore.getSession(sessionId);
    const providerSessionId = state?.session.providerSessionId;
    if (!providerSessionId) {
      return undefined;
    }
    // Normal conversation reads never start a SQLite discovery query. The
    // process-wide catalog owns discovery and hydrates this map; targeted
    // asynchronous lookup remains available only to explicit lifecycle work.
    return this.storedSessionIndex.get(providerSessionId);
  }

  private async findRecord(
    providerSessionId: string,
  ): Promise<OpenCodeStoredSessionRecord | null> {
    const cached = this.storedSessionIndex.get(providerSessionId);
    if (cached) {
      return cached;
    }
    const record = await findOpenCodeStoredSessionRecordAsync(providerSessionId);
    if (record) {
      this.storedSessionIndex.set(providerSessionId, record);
    }
    return record;
  }

  private async getArchiveServer(cwd: string): Promise<OpenCodeServerHandle> {
    if (
      this.archiveServer &&
      this.archiveServer.child.exitCode === null &&
      this.archiveServer.child.signalCode === null
    ) {
      return this.archiveServer;
    }
    this.archiveServerPromise ??= startOpenCodeServer({ cwd });
    try {
      this.archiveServer = await this.archiveServerPromise;
      return this.archiveServer;
    } finally {
      this.archiveServerPromise = null;
    }
  }

  private async resetArchiveServer(): Promise<void> {
    const pending = this.archiveServerPromise;
    this.archiveServerPromise = null;
    const server = this.archiveServer ?? (pending ? await pending.catch(() => null) : null);
    this.archiveServer = null;
    if (server) {
      await stopOpenCodeServer(server);
    }
  }
}
