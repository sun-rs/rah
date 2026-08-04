import type {
  CoreLiveProvider,
  DebugScenarioDescriptor,
  ForkSessionRequest,
  ResumeSessionRequest,
  SessionConfigValue,
  SessionInputAttachment,
  SessionInputAnnotation,
  SessionSummary,
  StartSessionRequest,
  StoredSessionRef,
} from "@rah/runtime-protocol";
import {
  defaultLiveBackendForProvider,
  isCoreLiveProvider,
} from "@rah/runtime-protocol";
import * as api from "./api";
import { isReadOnlyReplay } from "./session-capabilities";
import { readErrorMessage } from "./session-store-bootstrap";
import {
  applyResumedHistorySessionState,
  applyForkedSessionState,
  applyPendingStoredReplaySessionState,
  applyResumedStoredSessionState,
  applyStartedSessionState,
  resolveStoredSessionRef,
  createEmptySessionProjection,
  mergeResumedHistoryProjection,
  storedReplayPlaceholderSessionId,
} from "./session-store-session-lifecycle";
import {
  createClientSideId,
  createInteractiveAttachRequest,
  createObserveAttachRequest,
} from "./session-store-session-commands";
import type { PendingSessionTransition } from "./session-transition-contract";
import {
  createPendingScenarioTransition,
  createPendingStartTransition,
  createPendingStoredSessionTransition,
} from "./session-transition-contract";
import {
  findDaemonRunningSessionForStoredRef,
  resolveHistoryActivationMode,
} from "./session-store-workspace";
import { updateSessionSummaryInProjectionMap } from "./session-store-projections";
import {
  appendOptimisticUserMessage,
  initialConversationSyncState,
  providerLabel,
  removeOptimisticUserMessage,
  type SessionProjection,
} from "./types";

type ProviderChoice = CoreLiveProvider;

type StartSessionOptions = {
  provider?: ProviderChoice;
  cwd?: string;
  title?: string;
  model?: string;
  optionValues?: Record<string, SessionConfigValue>;
  reasoningId?: string;
  modeId?: string;
  liveBackend?: StartSessionRequest["liveBackend"];
  initialInput?: string;
  initialAttachments?: SessionInputAttachment[];
  initialAnnotations?: SessionInputAnnotation[];
  confirmCreateMissingWorkspace?: (dir: string) => Promise<boolean>;
  onSessionCreated?: (sessionId: string) => void;
};

export type ForkSessionOptions = Pick<
  ForkSessionRequest,
  "kind" | "workspaceMode" | "lastTurnId"
> & {
  operationId?: string;
};

type ForkSessionFlight = {
  key: string;
  promise: Promise<string>;
};

const FORK_OPERATION_RETRY_TTL_MS = 5 * 60_000;
const forkSessionFlights = new Map<string, ForkSessionFlight>();
const forkSessionRetryIds = new Map<string, { operationId: string; expiresAt: number }>();
const canceledSessionStartupIds = new Set<string>();

type SessionStartupState = {
  clientId: string;
  connectionId: string;
  projections: Map<string, SessionProjection>;
  unreadSessionIds: Set<string>;
  hiddenWorkspaceDirs: Set<string>;
  workspaceDirs: string[];
  workspaceVisibilityVersion: number;
  sessionTopologyVersion: number;
  workspaceDir: string;
  selectedSessionId: string | null;
  newSessionProvider: ProviderChoice;
  pendingSessionTransition: PendingSessionTransition | null;
  pendingSessionAction:
    | {
        kind: "attach_session" | "claim_control" | "resume_history";
        sessionId: string;
        provider?: SessionSummary["session"]["provider"];
        providerSessionId?: string;
      }
    | null;
  storedSessions: StoredSessionRef[];
  recentSessions: StoredSessionRef[];
  error: string | null;
};

type SessionStartupSetState = (
  partial:
    | Partial<SessionStartupState>
    | ((state: SessionStartupState) => Partial<SessionStartupState> | SessionStartupState),
) => void;

type SessionStartupDeps = {
  get: () => SessionStartupState;
  set: SessionStartupSetState;
  ensureConversationLoaded: (sessionId: string) => Promise<void>;
  initializeLiveConversationProjection: (sessionId: string) => Promise<void>;
  sendInput: (
    sessionId: string,
    text: string,
    attachments?: SessionInputAttachment[],
    identity?: {
      clientMessageId?: string;
      clientTurnId?: string;
      skipOptimisticQueue?: boolean;
      annotations?: SessionInputAnnotation[];
    },
  ) => Promise<void>;
  attachSession: (summary: SessionSummary) => Promise<void>;
  resumeStoredSession: (
    ref: StoredSessionRef,
    options?: {
      preferStoredReplay?: boolean;
      historyReplay?: "include" | "skip";
      confirmCreateMissingWorkspace?: (dir: string) => Promise<boolean>;
    },
  ) => Promise<void>;
  applySessionsResponse: (
    state: Pick<
      SessionStartupState,
      | "projections"
      | "workspaceDir"
      | "selectedSessionId"
      | "hiddenWorkspaceDirs"
      | "workspaceVisibilityVersion"
      | "storedSessions"
      | "recentSessions"
    >,
    sessionsResponse: Awaited<ReturnType<typeof api.listSessions>>,
    options?: {
      workspaceVisibilityVersionAtRequest?: number;
      preserveStoredSessionCatalog?: boolean;
    },
  ) => Pick<
    SessionStartupState,
    | "projections"
    | "storedSessions"
    | "recentSessions"
    | "workspaceDirs"
    | "hiddenWorkspaceDirs"
    | "workspaceVisibilityVersion"
    | "workspaceDir"
    | "selectedSessionId"
  >;
  adoptExistingProjectionForProviderSession: (
    projections: Map<string, SessionProjection>,
    summary: SessionSummary,
  ) => Map<string, SessionProjection>;
  applyEventsToMap: (
    current: Map<string, SessionProjection>,
    events: import("@rah/runtime-protocol").RahEvent[],
  ) => Map<string, SessionProjection>;
  takePendingEventsForSessions: (sessionIds: Set<string>) => import("@rah/runtime-protocol").RahEvent[];
  confirmCreateMissingWorkspace: (dir: string) => Promise<boolean>;
};

export function cancelPendingSessionStartupCommand(
  deps: Pick<SessionStartupDeps, "get" | "set">,
  sessionId: string,
): boolean {
  const state = deps.get();
  const isPendingResume =
    state.pendingSessionAction?.kind === "resume_history" &&
    state.pendingSessionAction.sessionId === sessionId;
  const isPendingStart =
    state.pendingSessionTransition?.kind === "new" &&
    state.selectedSessionId === sessionId &&
    sessionId.startsWith("starting-session:");
  if (!isPendingResume && !isPendingStart) return false;
  canceledSessionStartupIds.add(sessionId);
  deps.set((current) => {
    const projection = current.projections.get(sessionId);
    if (!projection) return current;
    const projections = new Map(current.projections);
    projections.set(sessionId, {
      ...projection,
      currentRuntimeStatus: "stopping",
      summary: {
        ...projection.summary,
        session: {
          ...projection.summary.session,
          status: "running",
          phase: "stopping",
          runtimeState: "running",
          updatedAt: new Date().toISOString(),
        },
      },
    });
    return { projections };
  });
  return true;
}

function consumeCanceledSessionStartup(sessionId: string | null): boolean {
  if (!sessionId || !canceledSessionStartupIds.has(sessionId)) return false;
  canceledSessionStartupIds.delete(sessionId);
  return true;
}

function historyOnlyRunningMessage(provider: string): string {
  const label = isCoreLiveProvider(provider) ? providerLabel(provider) : provider;
  return `${label} is not a supported running provider. Use Codex, Claude, or OpenCode.`;
}

function createPendingLiveSessionProjection(args: {
  sessionId: string;
  provider: ProviderChoice;
  cwd: string;
  title: string;
  clientId: string;
  connectionId: string;
  text: string;
  attachments: SessionInputAttachment[];
  clientMessageId: string;
  clientTurnId: string;
}): SessionProjection {
  const now = new Date().toISOString();
  const summary: SessionSummary = {
    session: {
      id: args.sessionId,
      provider: args.provider,
      launchSource: "web",
      ...(() => {
        const liveBackend = defaultLiveBackendForProvider(args.provider);
        return liveBackend ? { liveBackend } : {};
      })(),
      status: "running",
      phase: "starting",
      cwd: args.cwd,
      rootDir: args.cwd,
      runtimeState: "starting",
      ptyId: args.sessionId,
      title: args.title,
      inputQueuePolicy: "queue",
      capabilities: {
        liveAttach: true,
        structuredTimeline: true,
        nativeTui: args.provider === "claude",
        rawPtyInput: args.provider === "claude",
        chatMirror: args.provider === "claude",
        structuredControl: true,
        livePermissions: true,
        contextUsage: true,
        resumeByProvider: true,
        listProviderSessions: true,
        actions: {
          info: true,
          stop: true,
          archive: args.provider === "codex",
          delete: true,
          rename: "native",
        },
        steerInput: true,
        queuedInput: args.provider !== "claude",
        modelSwitch: true,
        planMode: true,
        subagents: true,
      },
      createdAt: now,
      updatedAt: now,
    },
    attachedClients: [
      {
        id: args.clientId,
        kind: "web",
        sessionId: args.sessionId,
        connectionId: args.connectionId,
        attachMode: "interactive",
        focus: true,
        lastSeenAt: now,
      },
    ],
    controlLease: {
      sessionId: args.sessionId,
      holderClientId: args.clientId,
      holderKind: "web",
      grantedAt: now,
    },
  };
  return appendOptimisticUserMessage(
    createEmptySessionProjection(summary),
    args.text,
    {
      clientMessageId: args.clientMessageId,
      clientTurnId: args.clientTurnId,
      ...(args.attachments.length ? { attachments: args.attachments } : {}),
      imageCount: args.attachments.filter((attachment) => attachment.kind === "image").length,
    },
  );
}

function rollbackImmediateUserInput(
  projection: SessionProjection,
  args: {
    text: string;
    clientMessageId: string;
    baselineSeq: number | undefined;
  },
): SessionProjection {
  const restored = removeOptimisticUserMessage(
    projection,
    args.text,
    args.clientMessageId,
  );
  if (
    args.baselineSeq !== undefined &&
    projection.lastSeq === args.baselineSeq &&
    restored.currentRuntimeStatus === "thinking"
  ) {
    const next = { ...restored };
    delete next.currentRuntimeStatus;
    return next;
  }
  return restored;
}

function pruneReadOnlyReplaysForResumedProviderSession(
  projections: Map<string, SessionProjection>,
  resumedSession: SessionSummary,
): void {
  const providerSessionId = resumedSession.session.providerSessionId;
  if (!providerSessionId) {
    return;
  }
  for (const [sessionId, projection] of projections) {
    if (
      sessionId !== resumedSession.session.id &&
      projection.summary.session.provider === resumedSession.session.provider &&
      projection.summary.session.providerSessionId === providerSessionId &&
      isReadOnlyReplay(projection.summary)
    ) {
      projections.delete(sessionId);
    }
  }
}

export async function startSessionCommand(
  deps: SessionStartupDeps,
  options?: StartSessionOptions,
): Promise<string | null> {
  let provisionalSessionId: string | null = null;
  let initialInputRollback: {
    sessionId: string;
    text: string;
    clientMessageId: string;
    baselineSeq: number | undefined;
  } | null = null;
  try {
    const state = deps.get();
    const cwd = options?.cwd?.trim() || state.workspaceDir.trim();
    if (!cwd) {
      deps.set({ error: "Choose a workspace directory first." });
      return null;
    }
    const provider = options?.provider ?? state.newSessionProvider;
    if (!isCoreLiveProvider(provider)) {
      const error = historyOnlyRunningMessage(provider);
      deps.set({ pendingSessionTransition: null, error });
      throw new Error(error);
    }
    const initialInput = options?.initialInput?.trim();
    const initialAttachments = options?.initialAttachments ?? [];
    const initialAnnotations = options?.initialAnnotations ?? [];
    const title = options?.title ?? `${providerLabel(provider)} session`;
    const clientMessageId = createClientSideId("client-message");
    const clientTurnId = createClientSideId("client-turn");
    const pendingTransition = createPendingStartTransition({
      provider,
      cwd,
      ...(options?.title ? { title: options.title } : {}),
    });
    if (initialInput || initialAttachments.length > 0 || initialAnnotations.length > 0) {
      provisionalSessionId = createClientSideId("starting-session");
      const provisionalProjection = createPendingLiveSessionProjection({
        sessionId: provisionalSessionId,
        provider,
        cwd,
        title,
        clientId: state.clientId,
        connectionId: state.connectionId,
        text: initialInput ?? "",
        attachments: initialAttachments,
        clientMessageId,
        clientTurnId,
      });
      deps.set((current) => {
        const projections = new Map(current.projections);
        projections.set(provisionalProjection.summary.session.id, provisionalProjection);
        return {
          projections,
          selectedSessionId: provisionalProjection.summary.session.id,
          pendingSessionTransition: pendingTransition,
          sessionTopologyVersion: current.sessionTopologyVersion + 1,
          error: null,
        };
      });
    } else {
      deps.set({ pendingSessionTransition: pendingTransition, error: null });
    }
    if (!(await ensureLaunchWorkspaceAvailable(deps, cwd))) {
      if (provisionalSessionId) {
        consumeCanceledSessionStartup(provisionalSessionId);
        deps.set((current) => {
          const projections = new Map(current.projections);
          projections.delete(provisionalSessionId!);
          return {
            projections,
            selectedSessionId:
              current.selectedSessionId === provisionalSessionId
                ? null
                : current.selectedSessionId,
            pendingSessionTransition: null,
            sessionTopologyVersion: current.sessionTopologyVersion + 1,
          };
        });
      }
      return null;
    }
    const liveBackend = options?.liveBackend ?? defaultLiveBackendForProvider(provider);
    const response = await api.startSession({
      provider,
      cwd,
      ...(liveBackend ? { liveBackend } : {}),
      title,
      ...(options?.model ? { model: options.model } : {}),
      ...(options?.optionValues !== undefined ? { optionValues: options.optionValues } : {}),
      ...(options?.modeId ? { modeId: options.modeId } : {}),
      attach: createInteractiveAttachRequest(state.clientId, state.connectionId),
    });
    if (consumeCanceledSessionStartup(provisionalSessionId)) {
      await api.closeSession(response.session.session.id, { clientId: state.clientId });
      deps.set((current) => {
        const projections = new Map(current.projections);
        if (provisionalSessionId) projections.delete(provisionalSessionId);
        projections.delete(response.session.session.id);
        return {
          projections,
          selectedSessionId:
            current.selectedSessionId === provisionalSessionId ? null : current.selectedSessionId,
          pendingSessionTransition: null,
          sessionTopologyVersion: current.sessionTopologyVersion + 1,
          error: null,
        };
      });
      return null;
    }
    const session =
      options?.modeId &&
      response.session.session.mode?.mutable &&
      response.session.session.mode.currentModeId !== options.modeId
        ? await api.setSessionMode(response.session.session.id, { modeId: options.modeId })
        : response.session;
    deps.set((current) => {
      const next = deps.adoptExistingProjectionForProviderSession(
        new Map(current.projections),
        session,
      );
      const provisionalProjection = provisionalSessionId
        ? next.get(provisionalSessionId)
        : undefined;
      if (provisionalSessionId) next.delete(provisionalSessionId);
      const existingLiveProjection = next.get(session.session.id);
      const startedState = applyStartedSessionState(current, session, {
        cwd,
        provider,
        projections: next,
      });
      const startedProjections = startedState.projections ?? next;
      if (provisionalProjection) {
        startedProjections.set(
          session.session.id,
          mergeResumedHistoryProjection(
            session,
            provisionalProjection,
            existingLiveProjection,
          ),
        );
      }
      return {
        ...startedState,
        projections: deps.applyEventsToMap(
          startedProjections,
          deps.takePendingEventsForSessions(new Set([session.session.id])),
        ),
      };
    });
    options?.onSessionCreated?.(session.session.id);
    if (initialInput || initialAttachments.length > 0 || initialAnnotations.length > 0) {
      void deps.initializeLiveConversationProjection(session.session.id).catch(() => undefined);
      initialInputRollback = {
        sessionId: session.session.id,
        text: initialInput ?? "",
        clientMessageId,
        baselineSeq: deps.get().projections.get(session.session.id)?.lastSeq,
      };
      await deps.sendInput(
        session.session.id,
        initialInput ?? "",
        initialAttachments,
        {
          clientMessageId,
          clientTurnId,
          skipOptimisticQueue: true,
          ...(initialAnnotations.length ? { annotations: initialAnnotations } : {}),
        },
      );
    } else {
      await deps.initializeLiveConversationProjection(session.session.id);
    }
    return session.session.id;
  } catch (error) {
    consumeCanceledSessionStartup(provisionalSessionId);
    deps.set((state) => {
      const projections = new Map(state.projections);
      if (initialInputRollback) {
        const projection = projections.get(initialInputRollback.sessionId);
        if (projection) {
          projections.set(
            initialInputRollback.sessionId,
            rollbackImmediateUserInput(projection, initialInputRollback),
          );
        }
      }
      const removedProvisional = Boolean(
        provisionalSessionId && projections.delete(provisionalSessionId),
      );
      return {
        projections,
        selectedSessionId:
          removedProvisional && state.selectedSessionId === provisionalSessionId
            ? null
            : state.selectedSessionId,
        pendingSessionTransition: null,
        sessionTopologyVersion:
          state.sessionTopologyVersion + (removedProvisional ? 1 : 0),
        error: readErrorMessage(error),
      };
    });
    throw error;
  }
}

export function forkSessionCommand(
  deps: SessionStartupDeps,
  parentSessionId: string,
  options: ForkSessionOptions,
): Promise<string> {
  const key = JSON.stringify({
    parentSessionId,
    kind: options.kind,
    workspaceMode: options.workspaceMode,
    lastTurnId: options.lastTurnId ?? null,
  });
  const active = forkSessionFlights.get(parentSessionId);
  if (active) {
    if (active.key === key) {
      return active.promise;
    }
    return Promise.reject(
      new Error(`A branch operation is already running for session ${parentSessionId}.`),
    );
  }

  const retry = forkSessionRetryIds.get(key);
  const now = Date.now();
  if (retry && retry.expiresAt <= now) {
    forkSessionRetryIds.delete(key);
  }
  const operationId =
    options.operationId ??
    forkSessionRetryIds.get(key)?.operationId ??
    createClientSideId("fork-operation");
  forkSessionRetryIds.set(key, {
    operationId,
    expiresAt: now + FORK_OPERATION_RETRY_TTL_MS,
  });

  const promise = executeForkSessionCommand(deps, parentSessionId, options, operationId);
  const flight = { key, promise };
  forkSessionFlights.set(parentSessionId, flight);
  void promise.then(
    () => {
      forkSessionRetryIds.delete(key);
    },
    () => undefined,
  ).finally(() => {
    if (forkSessionFlights.get(parentSessionId) === flight) {
      forkSessionFlights.delete(parentSessionId);
    }
  });
  return promise;
}

async function executeForkSessionCommand(
  deps: SessionStartupDeps,
  parentSessionId: string,
  options: ForkSessionOptions,
  operationId: string,
): Promise<string> {
  try {
    const state = deps.get();
    const response = await api.forkSession(parentSessionId, {
      operationId,
      kind: options.kind,
      workspaceMode: options.workspaceMode,
      ...(options.lastTurnId ? { lastTurnId: options.lastTurnId } : {}),
      attach: createInteractiveAttachRequest(state.clientId, state.connectionId),
    });
    deps.set((current) => {
      const next = new Map(current.projections);
      const forkedState = applyForkedSessionState(current, response.session, {
        projections: next,
        selectChild: options.kind === "fork",
      });
      return {
        ...forkedState,
        projections: deps.applyEventsToMap(
          forkedState.projections ?? next,
          deps.takePendingEventsForSessions(new Set([response.session.session.id])),
        ),
      };
    });
    await deps.initializeLiveConversationProjection(response.session.session.id);
    return response.session.session.id;
  } catch (error) {
    deps.set({ error: readErrorMessage(error) });
    throw error;
  }
}

export async function startScenarioCommand(
  deps: SessionStartupDeps,
  scenario: DebugScenarioDescriptor,
) {
  try {
    deps.set({
      pendingSessionTransition: createPendingScenarioTransition(scenario),
      error: null,
    });
    const response = await api.startDebugScenario({
      scenarioId: scenario.id,
      attach: createInteractiveAttachRequest(deps.get().clientId, deps.get().connectionId),
    });
    deps.set((current) => {
      const next = new Map(current.projections);
      return applyStartedSessionState(current, response.session, {
        cwd: scenario.rootDir,
        projections: next,
      });
    });
    void deps.ensureConversationLoaded(response.session.session.id);
  } catch (error) {
    deps.set({ pendingSessionTransition: null, error: readErrorMessage(error) });
    throw error;
  }
}

export async function activateHistorySessionCommand(
  deps: SessionStartupDeps,
  ref: StoredSessionRef,
  options?: { confirmCreateMissingWorkspace?: (dir: string) => Promise<boolean> },
) {
  const state = deps.get();
  const existingRunning = findDaemonRunningSessionForStoredRef(state.projections, ref);
  const mode = resolveHistoryActivationMode({
    existingRunningSummary: existingRunning,
    clientId: state.clientId,
  });
  if (mode === "select" && existingRunning) {
    deps.set({ selectedSessionId: existingRunning.session.id });
    void deps.ensureConversationLoaded(existingRunning.session.id);
    return;
  }
  if (mode === "attach" && existingRunning) {
    await deps.attachSession(existingRunning);
    return;
  }
  await deps.resumeStoredSession(ref, {
    preferStoredReplay: true,
    ...(options?.confirmCreateMissingWorkspace
      ? { confirmCreateMissingWorkspace: options.confirmCreateMissingWorkspace }
      : {}),
  });
}

export async function resumeStoredSessionCommand(
  deps: SessionStartupDeps,
  ref: StoredSessionRef,
  options?: {
    preferStoredReplay?: boolean;
    historyReplay?: "include" | "skip";
    confirmCreateMissingWorkspace?: (dir: string) => Promise<boolean>;
  },
) {
  const preferStoredReplay = options?.preferStoredReplay ?? true;
  const provisionalSessionId = preferStoredReplay
    ? storedReplayPlaceholderSessionId(ref)
    : null;
  try {
    const targetDir = ref.cwd ?? ref.rootDir;
    if (!preferStoredReplay && !(await ensureLaunchWorkspaceAvailable(deps, targetDir))) {
      return;
    }
    if (preferStoredReplay) {
      deps.set((current) => applyPendingStoredReplaySessionState(current, ref));
    } else {
      deps.set({
        pendingSessionTransition: createPendingStoredSessionTransition(ref, "history"),
        error: null,
      });
    }
    if (ref.source === "previous_running") {
      const workspaceVisibilityVersionAtRequest = deps.get().workspaceVisibilityVersion;
      const sessionsResponse = await api.listSessions({ storedSessions: "recent" });
      const running = sessionsResponse.sessions.find(
        (summary) =>
          !isReadOnlyReplay(summary) &&
          summary.session.provider === ref.provider &&
          summary.session.providerSessionId === ref.providerSessionId,
      );
      if (running) {
        deps.set((state) => ({
          ...(() => {
            const next = deps.applySessionsResponse(state, sessionsResponse, {
              workspaceVisibilityVersionAtRequest,
              preserveStoredSessionCatalog: true,
            });
            if (!provisionalSessionId) {
              return next;
            }
            const projections = new Map(next.projections);
            projections.delete(provisionalSessionId);
            return { ...next, projections };
          })(),
          workspaceDir:
            ref.rootDir ??
            ref.cwd ??
            running.session.rootDir ??
            running.session.cwd ??
            state.workspaceDir,
          pendingSessionTransition: state.pendingSessionTransition,
          error: null,
        }));
        await deps.attachSession(running);
        deps.set({ pendingSessionTransition: null });
        return;
      }
    }

    const request: ResumeSessionRequest = {
      provider: ref.provider,
      providerSessionId: ref.providerSessionId,
      ...(!preferStoredReplay
        ? (() => {
            const liveBackend = defaultLiveBackendForProvider(ref.provider);
            return liveBackend ? { liveBackend } : {};
          })()
        : {}),
      preferStoredReplay,
      attach: createObserveAttachRequest(deps.get().clientId, deps.get().connectionId),
    };
    if (options?.historyReplay !== undefined) {
      request.historyReplay = options.historyReplay;
    }
    if (targetDir !== undefined) {
      request.cwd = targetDir;
    }
    const response = await api.resumeSession(request);
    deps.set((current) => {
      const next = deps.adoptExistingProjectionForProviderSession(
        new Map(current.projections),
        response.session,
      );
      const shouldSelectResponse =
        !provisionalSessionId ||
        current.selectedSessionId === provisionalSessionId ||
        current.selectedSessionId === response.session.session.id;
      const resumedState = applyResumedStoredSessionState(
        current,
        response.session,
        ref,
        {
          projections: next,
          replayProjection: createEmptySessionProjection(response.session),
          ...(provisionalSessionId ? { replaceSessionId: provisionalSessionId } : {}),
          selectSession: shouldSelectResponse,
        },
      );
      return {
        ...resumedState,
        projections: deps.applyEventsToMap(
          resumedState.projections ?? next,
          deps.takePendingEventsForSessions(new Set([response.session.session.id])),
        ),
      };
    });
    void deps.ensureConversationLoaded(response.session.session.id);
  } catch (error) {
    const message = readErrorMessage(error);
    if (message.includes("attach instead of resume")) {
      const workspaceVisibilityVersionAtRequest = deps.get().workspaceVisibilityVersion;
      const sessionsResponse = await api.listSessions({ storedSessions: "recent" });
      const running = sessionsResponse.sessions.find(
        (summary) =>
          summary.session.provider === ref.provider &&
          summary.session.providerSessionId === ref.providerSessionId,
      );
      if (running) {
        deps.set((state) => {
          const next = deps.applySessionsResponse(state, sessionsResponse, {
            workspaceVisibilityVersionAtRequest,
            preserveStoredSessionCatalog: true,
          });
          const projections = new Map(next.projections);
          if (provisionalSessionId) {
            projections.delete(provisionalSessionId);
          }
          return {
            ...next,
            projections,
            workspaceDir:
              ref.rootDir ??
              ref.cwd ??
              running.session.rootDir ??
              running.session.cwd ??
              next.workspaceDir,
            error: null,
          };
        });
        await deps.attachSession(running);
        deps.set({ pendingSessionTransition: null });
        return;
      }
    }
    deps.set((state) => {
      if (!provisionalSessionId) {
        return { pendingSessionTransition: null, error: message };
      }
      const current = state.projections.get(provisionalSessionId);
      if (!current) {
        return { pendingSessionTransition: null, error: message };
      }
      const next = new Map(state.projections);
      next.set(provisionalSessionId, {
        ...current,
        conversation: {
          ...(current.conversation ?? initialConversationSyncState()),
          phase: "error",
          loadedScope: "history",
          lastError: message,
        },
      });
      return { projections: next, pendingSessionTransition: null, error: message };
    });
    throw error;
  }
}

type ResumeHistorySessionOptions = {
  modeId?: string;
  modelId?: string;
  optionValues?: Record<string, SessionConfigValue>;
  reasoningId?: string | null;
  initialInput?: string;
  initialAttachments?: SessionInputAttachment[];
  initialAnnotations?: SessionInputAnnotation[];
};

type ResumeHistoryInitialInput = {
  text: string;
  attachments: SessionInputAttachment[];
  annotations: SessionInputAnnotation[];
  hasInput: boolean;
  clientMessageId: string;
  clientTurnId: string;
};

type ResumeHistoryOperation = {
  promise: Promise<string | null>;
  carriesInitialInput: boolean;
};

const resumeHistoryOperations = new Map<string, ResumeHistoryOperation>();

function createResumeHistoryInitialInput(
  options: ResumeHistorySessionOptions | undefined,
): ResumeHistoryInitialInput {
  const text = options?.initialInput ?? "";
  const attachments = options?.initialAttachments ?? [];
  const annotations = options?.initialAnnotations ?? [];
  return {
    text,
    attachments,
    annotations,
    hasInput: Boolean(text.trim() || attachments.length > 0 || annotations.length > 0),
    clientMessageId: createClientSideId("client-message"),
    clientTurnId: createClientSideId("client-turn"),
  };
}

function stageResumeHistoryInitialInput(
  deps: SessionStartupDeps,
  sessionId: string,
  previousProjection: SessionProjection | undefined,
  input: ResumeHistoryInitialInput,
): void {
  if (!input.hasInput || !previousProjection) {
    return;
  }
  const now = new Date().toISOString();
  const imageCount = input.attachments.filter(
    (attachment) => attachment.kind === "image",
  ).length;
  const optimistic = appendOptimisticUserMessage(previousProjection, input.text, {
    clientMessageId: input.clientMessageId,
    clientTurnId: input.clientTurnId,
    ...(input.attachments.length ? { attachments: input.attachments } : {}),
    imageCount,
  });
  deps.set((state) => {
    const projections = new Map(state.projections);
    projections.set(sessionId, {
      ...optimistic,
      currentRuntimeStatus: "thinking",
      summary: {
        ...optimistic.summary,
        session: {
          ...optimistic.summary.session,
          status: "running",
          phase: "starting",
          runtimeState: "starting",
          capabilities: {
            ...optimistic.summary.session.capabilities,
            structuredControl: true,
            livePermissions: true,
            steerInput: true,
            queuedInput: optimistic.summary.session.provider !== "claude",
            actions: {
              ...optimistic.summary.session.capabilities.actions,
              stop: true,
            },
          },
          updatedAt: now,
        },
        attachedClients: [
          ...optimistic.summary.attachedClients.filter(
            (client) => client.id !== state.clientId,
          ),
          {
            id: state.clientId,
            kind: "web",
            sessionId,
            connectionId: state.connectionId,
            attachMode: "interactive",
            focus: true,
            lastSeenAt: now,
          },
        ],
        controlLease: {
          sessionId,
          holderClientId: state.clientId,
          holderKind: "web",
          grantedAt: now,
        },
      },
    });
    return { projections, error: null };
  });
}

async function sendResumeHistoryInitialInput(
  deps: SessionStartupDeps,
  resumedSessionId: string,
  input: ResumeHistoryInitialInput,
): Promise<void> {
  if (!input.hasInput) {
    return;
  }
  await deps.sendInput(resumedSessionId, input.text, input.attachments, {
    clientMessageId: input.clientMessageId,
    clientTurnId: input.clientTurnId,
    skipOptimisticQueue: true,
    ...(input.annotations.length ? { annotations: input.annotations } : {}),
  });
}

function rollbackResumeHistoryInitialInput(
  deps: SessionStartupDeps,
  resumedSessionId: string,
  input: ResumeHistoryInitialInput,
  baselineSeq: number | undefined,
): void {
  deps.set((state) => {
    const projection = state.projections.get(resumedSessionId);
    if (!projection) return state;
    const projections = new Map(state.projections);
    projections.set(
      resumedSessionId,
      rollbackImmediateUserInput(projection, {
        text: input.text,
        clientMessageId: input.clientMessageId,
        baselineSeq,
      }),
    );
    return { projections };
  });
}

function resumeHistoryOperationKey(deps: SessionStartupDeps, sessionId: string): string {
  const session = deps.get().projections.get(sessionId)?.summary.session;
  return session?.providerSessionId
    ? `${session.provider}:${session.providerSessionId}`
    : `runtime:${sessionId}`;
}

export function resumeHistorySessionCommand(
  deps: SessionStartupDeps,
  sessionId: string,
  options?: ResumeHistorySessionOptions,
): Promise<string | null> {
  const operationKey = resumeHistoryOperationKey(deps, sessionId);
  const initial = createResumeHistoryInitialInput(options);
  const existing = resumeHistoryOperations.get(operationKey);
  if (existing) {
    if (!initial.hasInput || existing.carriesInitialInput) {
      return existing.promise;
    }
    const previousProjection = deps.get().projections.get(sessionId);
    stageResumeHistoryInitialInput(deps, sessionId, previousProjection, initial);
    let resumedSessionId: string | null = null;
    let resumedInputBaselineSeq: number | undefined;
    return existing.promise
      .then(async (nextSessionId) => {
        resumedSessionId = nextSessionId;
        if (!nextSessionId) {
          if (previousProjection) {
            deps.set((state) => {
              const projections = new Map(state.projections);
              projections.set(sessionId, previousProjection);
              return { projections };
            });
          }
          return null;
        }
        resumedInputBaselineSeq = deps.get().projections.get(nextSessionId)?.lastSeq;
        await sendResumeHistoryInitialInput(
          deps,
          nextSessionId,
          initial,
        );
        return nextSessionId;
      })
      .catch((error) => {
        if (resumedSessionId) {
          rollbackResumeHistoryInitialInput(
            deps,
            resumedSessionId,
            initial,
            resumedInputBaselineSeq,
          );
        } else if (previousProjection) {
          deps.set((state) => {
            const projections = new Map(state.projections);
            projections.set(sessionId, previousProjection);
            return { projections };
          });
        }
        throw error;
      });
  }

  const hasInitialInput = initial.hasInput;
  const previousProjection = deps.get().projections.get(sessionId);
  stageResumeHistoryInitialInput(deps, sessionId, previousProjection, initial);

  let resumedSessionId: string | null = null;
  let resumedInputBaselineSeq: number | undefined;
  const operation = resumeHistorySessionCommandInternal(deps, sessionId, options)
    .then(async (nextSessionId) => {
      resumedSessionId = nextSessionId;
      if (consumeCanceledSessionStartup(sessionId)) {
        try {
          if (nextSessionId) {
            await api.closeSession(nextSessionId, { clientId: deps.get().clientId });
          }
        } finally {
          deps.set((state) => {
            const projections = new Map(state.projections);
            if (nextSessionId) projections.delete(nextSessionId);
            if (previousProjection) projections.set(sessionId, previousProjection);
            return {
              projections,
              selectedSessionId:
                previousProjection && state.selectedSessionId === nextSessionId
                  ? sessionId
                  : state.selectedSessionId,
              pendingSessionAction: null,
              pendingSessionTransition: null,
              sessionTopologyVersion: state.sessionTopologyVersion + 1,
              error: null,
            };
          });
        }
        return null;
      }
      if (nextSessionId && hasInitialInput) {
        resumedInputBaselineSeq = deps.get().projections.get(nextSessionId)?.lastSeq;
        await sendResumeHistoryInitialInput(
          deps,
          nextSessionId,
          initial,
        );
      }
      return nextSessionId;
    })
    .catch((error) => {
      consumeCanceledSessionStartup(sessionId);
      if (resumedSessionId === null && previousProjection) {
        deps.set((state) => {
          if (!state.projections.has(sessionId)) return state;
          const projections = new Map(state.projections);
          projections.set(sessionId, previousProjection);
          return { projections };
        });
      } else if (resumedSessionId !== null && hasInitialInput) {
        rollbackResumeHistoryInitialInput(
          deps,
          resumedSessionId,
          initial,
          resumedInputBaselineSeq,
        );
      }
      throw error;
    })
    .finally(() => {
      if (resumeHistoryOperations.get(operationKey)?.promise === operation) {
        resumeHistoryOperations.delete(operationKey);
      }
    });
  resumeHistoryOperations.set(operationKey, {
    promise: operation,
    carriesInitialInput: hasInitialInput,
  });
  return operation;
}

async function resumeHistorySessionCommandInternal(
  deps: SessionStartupDeps,
  sessionId: string,
  options?: ResumeHistorySessionOptions,
): Promise<string | null> {
  const state = deps.get();
  const projection = state.projections.get(sessionId);
  const summary = projection?.summary;
  const providerSessionId = summary?.session.providerSessionId;
  if (!projection || !summary || !providerSessionId) {
    const error = "Only persisted provider sessions can be resumed from history.";
    deps.set({ error });
    throw new Error(error);
  }

  const ref = resolveStoredSessionRef(summary, state.recentSessions, state.storedSessions);
  if (!ref) {
    const error = "Only persisted provider sessions can be resumed from history.";
    deps.set({ error });
    throw new Error(error);
  }
  if (!isCoreLiveProvider(ref.provider)) {
    const error = historyOnlyRunningMessage(ref.provider);
    deps.set({ pendingSessionAction: null, pendingSessionTransition: null, error });
    throw new Error(error);
  }

  const pendingResumeAction = {
    kind: "resume_history" as const,
    sessionId,
    provider: ref.provider,
    providerSessionId: ref.providerSessionId,
  };
  deps.set({
    pendingSessionAction: pendingResumeAction,
    pendingSessionTransition: null,
    error: null,
  });
  const preservedProjection: SessionProjection = {
    ...projection,
    summary,
  };
  if (!preservedProjection.summary) {
    const error = "The history session disappeared while preparing Resume.";
    deps.set({ pendingSessionAction: null, error });
    throw new Error(error);
  }
  const ensureResumedConversationLoaded = (resumedSessionId: string) => {
    const conversation = deps.get().projections.get(resumedSessionId)?.conversation;
    if (conversation?.phase === "ready" && conversation.loadedScope === "history") {
      return;
    }
    void deps.ensureConversationLoaded(resumedSessionId).catch(() => undefined);
  };
  const applyResumedSession = (resumedSession: SessionSummary) => {
    deps.set((current) => {
      const next = new Map(current.projections);
      const sourceProjection = current.projections.get(sessionId) ?? preservedProjection;
      if (next.has(sessionId)) {
        const resumedState = applyResumedHistorySessionState(
          current,
          resumedSession,
          sessionId,
          sourceProjection,
          ref,
          next,
        );
        pruneReadOnlyReplaysForResumedProviderSession(
          resumedState.projections ?? next,
          resumedSession,
        );
        return {
          ...resumedState,
          projections: deps.applyEventsToMap(
            resumedState.projections ?? next,
            deps.takePendingEventsForSessions(new Set([resumedSession.session.id])),
          ),
        };
      }
      const existingProjection = next.get(resumedSession.session.id);
      const selectionFollowsResume =
        current.selectedSessionId === sessionId ||
        current.selectedSessionId === resumedSession.session.id;
      next.set(
        resumedSession.session.id,
        mergeResumedHistoryProjection(resumedSession, sourceProjection, existingProjection),
      );
      pruneReadOnlyReplaysForResumedProviderSession(next, resumedSession);
      return {
        projections: deps.applyEventsToMap(
          next,
          deps.takePendingEventsForSessions(new Set([resumedSession.session.id])),
        ),
        unreadSessionIds: new Set(
          [...current.unreadSessionIds].filter(
            (sessionIdValue) =>
              sessionIdValue !== sessionId &&
              (!selectionFollowsResume ||
                sessionIdValue !== resumedSession.session.id),
          ),
        ),
        selectedSessionId: selectionFollowsResume
          ? resumedSession.session.id
          : current.selectedSessionId,
        sessionTopologyVersion: current.sessionTopologyVersion + 1,
        pendingSessionAction: null,
        pendingSessionTransition: null,
        error: null,
      };
    });
    ensureResumedConversationLoaded(resumedSession.session.id);
  };
  const updateResumedSessionSummary = (resumedSession: SessionSummary) => {
    deps.set((current) => ({
      projections: deps.applyEventsToMap(
        updateSessionSummaryInProjectionMap(current.projections, resumedSession),
        deps.takePendingEventsForSessions(new Set([resumedSession.session.id])),
      ),
      pendingSessionAction: null,
      pendingSessionTransition: null,
      error: null,
    }));
  };

  const targetDir = ref.cwd ?? ref.rootDir ?? null;
  const findExistingRunningForResume = (): SessionSummary | null => {
    for (const projection of deps.get().projections.values()) {
      const summary = projection.summary;
      if (summary.session.id === sessionId || isReadOnlyReplay(summary)) {
        continue;
      }
      if (
        summary.session.provider === ref.provider &&
        summary.session.providerSessionId === ref.providerSessionId
      ) {
        return summary;
      }
    }
    return null;
  };
  const resumeExistingRunning = async (
    running: SessionSummary,
  ): Promise<string> => {
    const mode = resolveHistoryActivationMode({
      existingRunningSummary: running,
      clientId: deps.get().clientId,
    });
    if (mode === "select") {
      applyResumedSession(running);
      return running.session.id;
    }
    deps.set({
      pendingSessionAction: pendingResumeAction,
      pendingSessionTransition: null,
      error: null,
    });
    try {
      const attachResponse = await api.attachSession(
        running.session.id,
        createInteractiveAttachRequest(deps.get().clientId, deps.get().connectionId),
      );
      applyResumedSession(attachResponse.session);
      return attachResponse.session.session.id;
    } catch (attachError) {
      deps.set({
        pendingSessionAction: null,
        pendingSessionTransition: null,
        error: readErrorMessage(attachError),
      });
      throw attachError;
    }
  };

  const existingRunning = findExistingRunningForResume();
  if (existingRunning) {
    return await resumeExistingRunning(existingRunning);
  }

  if (!(await ensureLaunchWorkspaceAvailable(deps, targetDir))) {
    deps.set({ pendingSessionAction: null });
    return null;
  }

  try {
    deps.set({
      pendingSessionAction: pendingResumeAction,
      pendingSessionTransition: null,
      error: null,
    });
    const request: ResumeSessionRequest = {
      provider: ref.provider,
      providerSessionId: ref.providerSessionId,
      ...(() => {
        const liveBackend = defaultLiveBackendForProvider(ref.provider);
        return liveBackend ? { liveBackend } : {};
      })(),
      ...(options?.modelId ? { model: options.modelId } : {}),
      ...(options?.optionValues !== undefined ? { optionValues: options.optionValues } : {}),
      ...(options?.modeId ? { modeId: options.modeId } : {}),
      preferStoredReplay: false,
      historyReplay: "skip",
      historySourceSessionId: sessionId,
      attach: createInteractiveAttachRequest(state.clientId, state.connectionId),
    };
    if (targetDir !== null) {
      request.cwd = targetDir;
    }
    const response = await api.resumeSession(request);
    let session = response.session;
    applyResumedSession(session);
    try {
      if (
        options?.modeId &&
        session.session.mode?.mutable &&
        session.session.mode.currentModeId !== options.modeId
      ) {
        session = await api.setSessionMode(session.session.id, { modeId: options.modeId });
        updateResumedSessionSummary(session);
      }
      if (
        options?.modelId &&
        session.session.model?.mutable &&
        (session.session.model.currentModelId !== options.modelId ||
          (options.reasoningId !== undefined &&
            session.session.model.currentReasoningId !== options.reasoningId))
      ) {
        session = await api.setSessionModel(session.session.id, {
          modelId: options.modelId,
          ...(options.optionValues !== undefined ? { optionValues: options.optionValues } : {}),
        });
        updateResumedSessionSummary(session);
      }
    } catch (configurationError) {
      deps.set({
        pendingSessionAction: null,
        pendingSessionTransition: null,
        error: `Session was resumed, but updating session controls failed: ${readErrorMessage(configurationError)}`,
      });
    }
    return session.session.id;
  } catch (error) {
    const message = readErrorMessage(error);
    if (message.includes("attach instead of resume")) {
      const sessionsResponse = await api.listSessions({ storedSessions: "recent" });
      const running = sessionsResponse.sessions.find(
        (candidate) =>
          !isReadOnlyReplay(candidate) &&
          candidate.session.provider === ref.provider &&
          candidate.session.providerSessionId === ref.providerSessionId,
      );
      if (running) {
        return await resumeExistingRunning(running);
      }
    }
    deps.set({
      pendingSessionAction: null,
      pendingSessionTransition: null,
      error: message,
    });
    throw error;
  }
}

async function ensureLaunchWorkspaceAvailable(
  deps: SessionStartupDeps,
  dir: string | null | undefined,
): Promise<boolean> {
  const targetDir = dir?.trim();
  if (!targetDir) {
    return true;
  }
  try {
    await api.listDirectory(targetDir);
    return true;
  } catch (error) {
    if (!isMissingWorkspaceError(error)) {
      throw error;
    }
    const shouldCreate = await deps.confirmCreateMissingWorkspace(targetDir);
    if (!shouldCreate) {
      deps.set({
        pendingSessionAction: null,
        pendingSessionTransition: null,
        error: null,
      });
      return false;
    }
    await api.ensureDirectory({ dir: targetDir });
    return true;
  }
}

function isMissingWorkspaceError(error: unknown): boolean {
  const message = readErrorMessage(error).toLowerCase();
  return message.includes("enoent") || message.includes("no such file or directory");
}
