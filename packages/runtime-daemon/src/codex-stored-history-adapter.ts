import type {
  ResumeSessionRequest,
  ResumeSessionResponse,
  SessionHistoryPageResponse,
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
  ProviderStoredHistoryAdapter,
  RuntimeServices,
} from "./provider-adapter";
import {
  finalizeStoredReplayResume,
  prepareProviderSessionResume,
} from "./provider-resume";
import { movePathToTrash } from "./trash";

export class CodexStoredHistoryAdapter implements ProviderAdapter, ProviderStoredHistoryAdapter {
  readonly id = "codex-stored-history";
  readonly providers: Array<"codex"> = ["codex"];

  private storedSessionIndex = new Map<string, CodexStoredSessionRecord>();
  private readonly rehydratedSessionIds = new Set<string>();

  constructor(private readonly services: RuntimeServices) {}

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
    this.storedSessionIndex.delete(session.providerSessionId);
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
