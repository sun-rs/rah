import type {
  ResumeSessionRequest,
  ResumeSessionResponse,
  SessionHistoryPageResponse,
  SessionTurnDirectoryResponse,
  SessionTurnHistoryResponse,
  StoredSessionRef,
} from "@rah/runtime-protocol";
import { canFinalizeCodexStoredHistory } from "./codex-history-liveness";
import {
  createCodexStoredSessionFrozenHistoryPageLoader,
  discoverCodexStoredSessions,
  findCodexStoredSessionRecord,
  getCodexStoredSessionHistoryPage,
  resolveCodexStoredSessionWatchRoots,
  resumeCodexStoredSession,
  type CodexStoredSessionRecord,
} from "./codex-stored-sessions";
import type {
  ProviderAdapter,
  ProviderShutdownAdapter,
  ProviderStoredHistoryAdapter,
  RuntimeServices,
} from "./provider-adapter";
import {
  finalizeStoredReplayResume,
  prepareProviderSessionResume,
} from "./provider-resume";
import { movePathToTrash } from "./trash";
import { CodexTurnDirectoryStore } from "./codex-turn-directory";
import { readCodexTurnHistory } from "./codex-turn-history";
import { createCodexAppServerClient } from "./codex-app-server-client";
import type { CodexAppServerRpcClient } from "./codex-live-rpc";
import {
  materializeCodexAppServerTurnsPage,
  type CodexAppServerTurnsPage,
} from "./codex-app-server-turns-page";

function isUnsupportedTurnsListError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /method not found|unknown method|experimental api/i.test(message);
}

function isBrokenPagingTransport(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timed out|closed|exited|ECONN|socket|websocket/i.test(message);
}

export class CodexStoredHistoryAdapter
  implements ProviderAdapter, ProviderStoredHistoryAdapter, ProviderShutdownAdapter
{
  readonly id = "codex-stored-history";
  readonly providers: Array<"codex"> = ["codex"];

  private storedSessionIndex = new Map<string, CodexStoredSessionRecord>();
  private readonly rehydratedSessionIds = new Set<string>();
  private readonly turnDirectories = new CodexTurnDirectoryStore();
  private turnsListSupport: "unknown" | "available" | "unavailable" = "unknown";
  private pagingClient: CodexAppServerRpcClient | undefined;
  private pagingClientPromise: Promise<CodexAppServerRpcClient> | undefined;

  constructor(
    private readonly services: RuntimeServices,
    private readonly createPagingClient: () => Promise<CodexAppServerRpcClient> = createCodexAppServerClient,
  ) {}

  resumeStoredSession(request: ResumeSessionRequest): ResumeSessionResponse {
    const preparedResume = prepareProviderSessionResume({
      services: this.services,
      provider: "codex",
      providerSessionId: request.providerSessionId,
      preferStoredReplay: true,
      rehydratedSessionIds: this.rehydratedSessionIds,
    });
    const record =
      this.storedSessionIndex.get(request.providerSessionId) ??
      this.refreshStoredSessionIndex().get(request.providerSessionId) ??
      findCodexStoredSessionRecord(request.providerSessionId);
    if (!record) {
      throw new Error(`Unknown Codex session ${request.providerSessionId}.`);
    }
    try {
      return finalizeStoredReplayResume({
        services: this.services,
        provider: "codex",
        providerSessionId: request.providerSessionId,
        rehydratedSessionIds: this.rehydratedSessionIds,
        createSession: () =>
          resumeCodexStoredSession(
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

  getSessionHistoryPage(
    sessionId: string,
    options: { beforeTs?: string; cursor?: string; limit?: number } = {},
  ): SessionHistoryPageResponse {
    const record = this.findRecordForRuntimeSession(sessionId);
    if (!record) {
      return { sessionId, events: [] };
    }
    return getCodexStoredSessionHistoryPage({
      sessionId,
      record,
      finalizeUnterminatedTools: this.canFinalizeStoredHistory(record),
      ...options,
    });
  }

  async getSessionConversationHistoryPage(
    sessionId: string,
    options: { cursor?: string; limit?: number } = {},
  ): Promise<SessionHistoryPageResponse | undefined> {
    if (this.turnsListSupport === "unavailable") {
      return undefined;
    }
    const record = this.findRecordForRuntimeSession(sessionId);
    if (!record) {
      return undefined;
    }
    try {
      const client = await this.getPagingClient();
      const raw = (await client.request(
        "thread/turns/list",
        {
          threadId: record.ref.providerSessionId,
          ...(options.cursor ? { cursor: options.cursor } : {}),
          limit: Math.max(1, Math.min(options.limit ?? 20, 100)),
          sortDirection: "desc",
          itemsView: "summary",
        },
        30_000,
      )) as CodexAppServerTurnsPage;
      if (!Array.isArray(raw?.data)) {
        throw new Error("Codex thread/turns/list returned an invalid page.");
      }
      this.turnsListSupport = "available";
      return materializeCodexAppServerTurnsPage({
        sessionId,
        providerSessionId: record.ref.providerSessionId,
        page: raw,
      });
    } catch (error) {
      if (isUnsupportedTurnsListError(error)) {
        this.turnsListSupport = "unavailable";
      }
      if (isBrokenPagingTransport(error)) {
        await this.resetPagingClient();
      }
      return undefined;
    }
  }

  createFrozenHistoryPageLoader(sessionId: string) {
    const record = this.findRecordForRuntimeSession(sessionId);
    if (!record) {
      return undefined;
    }
    return createCodexStoredSessionFrozenHistoryPageLoader({
      sessionId,
      record,
      finalizeUnterminatedTools: this.canFinalizeStoredHistory(record),
    });
  }

  async getSessionTurnDirectory(sessionId: string): Promise<SessionTurnDirectoryResponse> {
    const record = this.findRecordForRuntimeSession(sessionId);
    if (!record) {
      return {
        sessionId,
        revision: "unavailable",
        items: [],
        complete: false,
        generatedAt: new Date().toISOString(),
      };
    }
    return this.turnDirectories.getDirectory(sessionId, record);
  }

  async getSessionTurnHistory(
    sessionId: string,
    turnId: string,
  ): Promise<SessionTurnHistoryResponse> {
    const record = this.findRecordForRuntimeSession(sessionId);
    if (!record) {
      return { sessionId, turnId, events: [] };
    }
    const range = await this.turnDirectories.getTurnRange(record, turnId);
    if (!range) {
      return { sessionId, turnId, events: [] };
    }
    return readCodexTurnHistory({ sessionId, turnId, record, range });
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

  listStoredSessionWatchRoots(): string[] {
    return resolveCodexStoredSessionWatchRoots();
  }

  async removeStoredSession(session: StoredSessionRef): Promise<void> {
    const record =
      this.storedSessionIndex.get(session.providerSessionId) ??
      this.refreshStoredSessionIndex().get(session.providerSessionId);
    if (!record) {
      throw new Error(`Could not find a stored Codex history file for ${session.providerSessionId}.`);
    }
    await movePathToTrash(record.rolloutPath);
    this.turnDirectories.clear(session.providerSessionId);
    this.storedSessionIndex.delete(session.providerSessionId);
  }

  async shutdown(): Promise<void> {
    await this.resetPagingClient();
    await this.turnDirectories.shutdown();
  }

  private async getPagingClient(): Promise<CodexAppServerRpcClient> {
    if (this.pagingClient) {
      return this.pagingClient;
    }
    this.pagingClientPromise ??= this.createPagingClient();
    try {
      this.pagingClient = await this.pagingClientPromise;
      return this.pagingClient;
    } finally {
      this.pagingClientPromise = undefined;
    }
  }

  private async resetPagingClient(): Promise<void> {
    const pendingClient = this.pagingClientPromise;
    const client =
      this.pagingClient ??
      (pendingClient ? await pendingClient.catch(() => undefined) : undefined);
    this.pagingClient = undefined;
    this.pagingClientPromise = undefined;
    await client?.dispose().catch(() => undefined);
  }

  private findRecordForRuntimeSession(sessionId: string): CodexStoredSessionRecord | undefined {
    const state = this.services.sessionStore.getSession(sessionId);
    const providerSessionId = state?.session.providerSessionId;
    if (!providerSessionId) {
      return undefined;
    }
    return (
      this.storedSessionIndex.get(providerSessionId) ??
      this.refreshStoredSessionIndex().get(providerSessionId) ??
      findCodexStoredSessionRecord(providerSessionId)
    );
  }

  private canFinalizeStoredHistory(record: CodexStoredSessionRecord): boolean {
    return canFinalizeCodexStoredHistory({
      rolloutPath: record.rolloutPath,
      hasRahManagedWriter: this.hasRahManagedCodexWriter(record.ref.providerSessionId),
    });
  }

  private hasRahManagedCodexWriter(providerSessionId: string): boolean {
    const managed = this.services.sessionStore.findManagedByProviderSession(
      "codex",
      providerSessionId,
    );
    if (!managed) {
      return false;
    }
    return (
      managed.session.capabilities.steerInput ||
      managed.session.capabilities.queuedInput ||
      managed.session.capabilities.actions.stop
    );
  }

  private refreshStoredSessionIndex(): Map<string, CodexStoredSessionRecord> {
    this.storedSessionIndex = new Map(
      discoverCodexStoredSessions().map((record) => [record.ref.providerSessionId, record]),
    );
    return this.storedSessionIndex;
  }
}
