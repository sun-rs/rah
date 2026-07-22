import type {
  ResumeSessionRequest,
  ResumeSessionResponse,
  ConversationEvidencePage,
  StoredSessionRef,
} from "@rah/runtime-protocol";
import { existsSync } from "node:fs";
import type {
  ProviderAdapter,
  ProviderShutdownAdapter,
  ProviderStoredHistoryAdapter,
  RuntimeServices,
} from "./provider-adapter";
import type { StoredSessionCatalogRecord } from "./stored-session-catalog-types";
import {
  deleteOpenCodeStoredSession,
  createOpenCodeStoredSessionFrozenHistoryPageLoader,
  discoverOpenCodeStoredSessions,
  findOpenCodeStoredSessionRecord,
  getOpenCodeStoredSessionHistoryPage,
  getOpenCodeStoredSessionTurnDetail,
  getOpenCodeStoredSessionTurnDirectory,
  getOpenCodeStoredSessionTurnHistoryPage,
  OpenCodeSqliteReadError,
  resolveOpenCodeStoredSessionWatchRoots,
  resumeOpenCodeStoredSession,
  restoreOpenCodeStoredSession,
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

  private storedSessionIndex = new Map<string, OpenCodeStoredSessionRecord>();
  private readonly rehydratedSessionIds = new Set<string>();
  private archiveServer: OpenCodeServerHandle | null = null;
  private archiveServerPromise: Promise<OpenCodeServerHandle> | null = null;

  constructor(private readonly services: RuntimeServices) {}

  resumeStoredSession(request: ResumeSessionRequest): ResumeSessionResponse {
    const preparedResume = prepareProviderSessionResume({
      services: this.services,
      provider: "opencode",
      providerSessionId: request.providerSessionId,
      preferStoredReplay: true,
      rehydratedSessionIds: this.rehydratedSessionIds,
    });
    const record =
      this.storedSessionIndex.get(request.providerSessionId) ??
      this.refreshStoredSessionIndex().get(request.providerSessionId) ??
      findOpenCodeStoredSessionRecord(request.providerSessionId);
    if (!record) {
      throw new Error(`Unknown OpenCode session ${request.providerSessionId}.`);
    }
    try {
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

  getConversationEvidencePage(
    sessionId: string,
    options?: { beforeTs?: string; cursor?: string; limit?: number },
  ): ConversationEvidencePage {
    void options?.cursor;
    const record = this.findRecordForRuntimeSession(sessionId);
    if (!record) {
      return { sessionId, events: [] };
    }
    return getOpenCodeStoredSessionHistoryPage({
      sessionId,
      record,
      ...(options?.beforeTs ? { beforeTs: options.beforeTs } : {}),
      ...(options?.limit ? { limit: options.limit } : {}),
    });
  }

  getConversationSummaryEvidencePage(
    sessionId: string,
    options: { cursor?: string; limit?: number } = {},
  ): ConversationEvidencePage | undefined {
    const record = this.findRecordForRuntimeSession(sessionId);
    if (!record) {
      return undefined;
    }
    const runtime = this.services.sessionStore.getSession(sessionId)?.session.runtime;
    return getOpenCodeStoredSessionTurnHistoryPage({
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

  getSessionConversationDirectory(sessionId: string) {
    const record = this.findRecordForRuntimeSession(sessionId);
    if (!record) {
      return {
        sessionId,
        revision: "missing",
        items: [],
        complete: false,
        generatedAt: new Date().toISOString(),
      };
    }
    return getOpenCodeStoredSessionTurnDirectory({ sessionId, record });
  }

  getSessionConversationTurnDetail(
    sessionId: string,
    options: { providerTurnId: string },
  ): ConversationEvidencePage | undefined {
    const record = this.findRecordForRuntimeSession(sessionId);
    if (!record) {
      return undefined;
    }
    return getOpenCodeStoredSessionTurnDetail({
      sessionId,
      record,
      providerTurnId: options.providerTurnId,
    });
  }

  createFrozenHistoryPageLoader(sessionId: string) {
    const record = this.findRecordForRuntimeSession(sessionId);
    if (!record) {
      return undefined;
    }
    return createOpenCodeStoredSessionFrozenHistoryPageLoader({
      sessionId,
      record,
    });
  }

  listStoredSessions(): StoredSessionRef[] {
    if (this.storedSessionIndex.size === 0) {
      this.refreshStoredSessionIndex();
    }
    return [...this.storedSessionIndex.values()].map((record) => record.ref);
  }

  refreshStoredSessionsCatalog(): StoredSessionRef[] {
    this.refreshStoredSessionIndex();
    return this.listStoredSessions();
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
    const record =
      this.storedSessionIndex.get(session.providerSessionId) ??
      this.refreshStoredSessionIndex().get(session.providerSessionId) ??
      findOpenCodeStoredSessionRecord(session.providerSessionId);
    if (!record) {
      throw new Error(`Could not find a stored OpenCode session for ${session.providerSessionId}.`);
    }
    if (record.ref.providerState?.archived === true) {
      return "provider_native";
    }
    const recordedCwd = record.ref.cwd ?? record.ref.rootDir;
    const cwd = recordedCwd && existsSync(recordedCwd) ? recordedCwd : process.cwd();
    const server = await this.getArchiveServer(cwd);
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
    } catch (error) {
      await this.resetArchiveServer();
      throw error;
    }
    this.refreshStoredSessionIndex();
    return "provider_native";
  }

  removeStoredSession(session: StoredSessionRef): void {
    const record =
      this.storedSessionIndex.get(session.providerSessionId) ??
      this.refreshStoredSessionIndex().get(session.providerSessionId) ??
      findOpenCodeStoredSessionRecord(session.providerSessionId);
    if (!record) {
      throw new Error(`Could not find a stored OpenCode session for ${session.providerSessionId}.`);
    }
    deleteOpenCodeStoredSession(record);
    this.storedSessionIndex.delete(session.providerSessionId);
  }

  restoreStoredSession(session: StoredSessionRef): void {
    const record =
      this.storedSessionIndex.get(session.providerSessionId) ??
      this.refreshStoredSessionIndex().get(session.providerSessionId) ??
      findOpenCodeStoredSessionRecord(session.providerSessionId);
    if (!record) {
      throw new Error(`Could not find a stored OpenCode session for ${session.providerSessionId}.`);
    }
    // OpenCode 1.18.4 exposes archive through session.update, but its public
    // schema only accepts a numeric archived timestamp and silently ignores
    // null. Clearing the provider-owned field is therefore the narrow,
    // reversible counterpart until an official unarchive endpoint exists.
    restoreOpenCodeStoredSession(record);
    this.refreshStoredSessionIndex();
  }

  async shutdown(): Promise<void> {
    await this.resetArchiveServer();
  }

  private findRecordForRuntimeSession(sessionId: string): OpenCodeStoredSessionRecord | undefined {
    const state = this.services.sessionStore.getSession(sessionId);
    const providerSessionId = state?.session.providerSessionId;
    if (!providerSessionId) {
      return undefined;
    }
    return (
      this.storedSessionIndex.get(providerSessionId) ??
      this.refreshStoredSessionIndex().get(providerSessionId) ??
      findOpenCodeStoredSessionRecord(providerSessionId)
    ) ?? undefined;
  }

  private refreshStoredSessionIndex(): Map<string, OpenCodeStoredSessionRecord> {
    try {
      this.storedSessionIndex = new Map(
        discoverOpenCodeStoredSessions({ throwOnReadError: true }).map((record) => [
          record.ref.providerSessionId,
          record,
        ]),
      );
    } catch (error) {
      if (error instanceof OpenCodeSqliteReadError) {
        console.warn(
          `[rah] OpenCode history refresh failed; keeping ${this.storedSessionIndex.size} cached session(s). ${error.message}`,
        );
        return this.storedSessionIndex;
      }
      throw error;
    }
    return this.storedSessionIndex;
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
