import type {
  CloseSessionRequest,
  ContextUsage,
  GitDiffResponse,
  GitStatusResponse,
  InterruptSessionRequest,
  PermissionResponseRequest,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SessionFileResponse,
  SessionHistoryPageResponse,
  SessionInputRequest,
  SessionSummary,
  StartSessionRequest,
  StartSessionResponse,
  StoredSessionRef,
  WorkspaceSnapshotResponse,
} from "@rah/runtime-protocol";
import type { ProviderAdapter, RuntimeServices } from "./provider-adapter";
import { getCodexGitDiff, getCodexGitStatus, getCodexWorkspaceSnapshot, readWorkspaceFile } from "./codex-stored-sessions";
import {
  closeKimiLiveSession,
  interruptKimiLiveSession,
  respondToKimiLivePermission,
  resumeKimiLiveSession,
  sendInputToKimiLiveSession,
  startKimiLiveSession,
  type LiveKimiSession,
} from "./kimi-live-client";
import {
  discoverKimiStoredSessions,
  getKimiStoredSessionHistoryPage,
  resumeKimiStoredSession,
  type KimiStoredSessionRecord,
} from "./kimi-session-files";
import {
  finalizeStoredReplayResume,
  prepareProviderSessionResume,
} from "./provider-resume";
import { kimiLaunchSpec, probeProviderDiagnostic } from "./provider-diagnostics";
import { toSessionSummary } from "./session-store";
import { movePathToTrash } from "./trash";
import path from "node:path";

export class KimiAdapter implements ProviderAdapter {
  readonly id = "kimi";
  readonly providers: Array<"kimi"> = ["kimi"];

  private readonly services: RuntimeServices;
  private readonly liveSessions = new Map<string, LiveKimiSession>();
  private readonly rehydratedSessionIds = new Set<string>();
  private storedSessionIndex = new Map<string, KimiStoredSessionRecord>();

  constructor(services: RuntimeServices) {
    this.services = services;
  }

  async startSession(request: StartSessionRequest): Promise<StartSessionResponse> {
    const response = await startKimiLiveSession({
      services: this.services,
      request,
    });
    this.liveSessions.set(response.liveSession.sessionId, response.liveSession);
    return { session: response.summary };
  }

  async resumeSession(request: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    prepareProviderSessionResume({
      services: this.services,
      provider: "kimi",
      providerSessionId: request.providerSessionId,
      preferStoredReplay: request.preferStoredReplay,
      rehydratedSessionIds: this.rehydratedSessionIds,
    });
    const existing = this.services.sessionStore.findManagedByProviderSession(
      "kimi",
      request.providerSessionId,
    );
    if (existing) {
      throw new Error(
        `Provider session kimi:${request.providerSessionId} is already running; attach instead of resume.`,
      );
    }

    const record =
      this.refreshStoredSessions().get(request.providerSessionId) ??
      this.storedSessionIndex.get(request.providerSessionId);
    if (request.preferStoredReplay) {
      if (!record) {
        throw new Error(`Unknown Kimi session ${request.providerSessionId}.`);
      }
      return finalizeStoredReplayResume({
        services: this.services,
        provider: "kimi",
        providerSessionId: request.providerSessionId,
        rehydratedSessionIds: this.rehydratedSessionIds,
        createSession: () =>
          resumeKimiStoredSession({
            services: this.services,
            record,
            ...(request.attach ? { attach: request.attach } : {}),
          }),
      });
    }

    const cwd = request.cwd ?? record?.ref.cwd ?? process.cwd();
    const response = await resumeKimiLiveSession({
      services: this.services,
      providerSessionId: request.providerSessionId,
      cwd,
      ...(request.attach ? { attach: request.attach } : {}),
    });
    this.liveSessions.set(response.liveSession.sessionId, response.liveSession);
    return { session: response.summary };
  }

  sendInput(sessionId: string, request: SessionInputRequest): void {
    const live = this.liveSessions.get(sessionId);
    if (!live) {
      throw new Error("Rehydrated Kimi sessions are currently read-only.");
    }
    void sendInputToKimiLiveSession({
      services: this.services,
      liveSession: live,
      request,
    });
  }

  async closeSession(sessionId: string, request: CloseSessionRequest): Promise<void> {
    const state = this.services.sessionStore.getSession(sessionId);
    if (!state) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    if (!state.clients.some((client) => client.id === request.clientId)) {
      throw new Error(`Client ${request.clientId} is not attached to ${sessionId}.`);
    }
    const live = this.liveSessions.get(sessionId);
    if (live) {
      this.liveSessions.delete(sessionId);
      await closeKimiLiveSession(live, request);
    }
    this.rehydratedSessionIds.delete(sessionId);
  }

  async destroySession(sessionId: string): Promise<void> {
    const live = this.liveSessions.get(sessionId);
    if (live) {
      this.liveSessions.delete(sessionId);
      await closeKimiLiveSession(live);
    }
    this.rehydratedSessionIds.delete(sessionId);
  }

  interruptSession(sessionId: string, request: InterruptSessionRequest): SessionSummary {
    const live = this.liveSessions.get(sessionId);
    if (!live) {
      const state = this.services.sessionStore.getSession(sessionId);
      if (!state) {
        throw new Error(`Unknown session ${sessionId}`);
      }
      return toSessionSummary(state);
    }
    return interruptKimiLiveSession({
      services: this.services,
      liveSession: live,
      request,
    });
  }

  async respondToPermission(
    sessionId: string,
    requestId: string,
    response: PermissionResponseRequest,
  ): Promise<void> {
    const live = this.liveSessions.get(sessionId);
    if (!live) {
      throw new Error(`Session ${sessionId} does not support live permission responses.`);
    }
    await respondToKimiLivePermission({
      liveSession: live,
      requestId,
      response,
    });
  }

  onPtyInput(): void {
    throw new Error("Kimi sessions do not support PTY input bridging.");
  }

  onPtyResize(): void {
    // Kimi sessions do not use PTY-backed rendering.
  }

  getWorkspaceSnapshot(sessionId: string): WorkspaceSnapshotResponse {
    const state = this.services.sessionStore.getSession(sessionId);
    if (!state) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    const snapshot = getCodexWorkspaceSnapshot(state.session.cwd);
    return {
      sessionId,
      cwd: snapshot.cwd,
      nodes: snapshot.nodes,
    };
  }

  getGitStatus(sessionId: string): GitStatusResponse {
    const state = this.services.sessionStore.getSession(sessionId);
    if (!state) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    const status = getCodexGitStatus(state.session.cwd);
    return {
      sessionId,
      ...(status.branch ? { branch: status.branch } : {}),
      changedFiles: status.changedFiles,
    };
  }

  getGitDiff(sessionId: string, targetPath: string): GitDiffResponse {
    const state = this.services.sessionStore.getSession(sessionId);
    if (!state) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    return {
      sessionId,
      path: targetPath,
      diff: getCodexGitDiff(state.session.cwd, targetPath),
    };
  }

  readSessionFile(sessionId: string, targetPath: string): SessionFileResponse {
    const state = this.services.sessionStore.getSession(sessionId);
    if (!state) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    return {
      sessionId,
      ...readWorkspaceFile(state.session.cwd, targetPath),
    };
  }

  getSessionHistoryPage(
    sessionId: string,
    options?: { beforeTs?: string; cursor?: string; limit?: number },
  ): SessionHistoryPageResponse {
    const state = this.services.sessionStore.getSession(sessionId);
    if (!state?.session.providerSessionId) {
      return { sessionId, events: [] };
    }
    const record =
      this.refreshStoredSessions().get(state.session.providerSessionId) ??
      this.storedSessionIndex.get(state.session.providerSessionId);
    if (!record) {
      return { sessionId, events: [] };
    }
    return getKimiStoredSessionHistoryPage({
      sessionId,
      record,
      ...(options?.beforeTs ? { beforeTs: options.beforeTs } : {}),
      ...(options?.limit ? { limit: options.limit } : {}),
    });
  }

  getContextUsage(sessionId: string): ContextUsage | undefined {
    return this.services.sessionStore.getSession(sessionId)?.usage;
  }

  listStoredSessions(): StoredSessionRef[] {
    return [...this.refreshStoredSessions().values()].map((record) => record.ref);
  }

  async removeStoredSession(session: StoredSessionRef): Promise<void> {
    const record =
      this.storedSessionIndex.get(session.providerSessionId) ??
      this.refreshStoredSessions().get(session.providerSessionId);
    if (!record) {
      throw new Error(`Could not find a stored Kimi history directory for ${session.providerSessionId}.`);
    }
    await movePathToTrash(path.dirname(record.wirePath));
    this.storedSessionIndex.delete(session.providerSessionId);
  }

  getProviderDiagnostic(options?: { forceRefresh?: boolean }) {
    return probeProviderDiagnostic("kimi", kimiLaunchSpec(), options);
  }

  private refreshStoredSessions() {
    this.storedSessionIndex = new Map(
      discoverKimiStoredSessions().map((record) => [record.ref.providerSessionId, record] as const),
    );
    return this.storedSessionIndex;
  }
}
