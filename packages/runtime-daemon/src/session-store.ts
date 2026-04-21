import type {
  AttachedClient,
  AttachMode,
  ClientKind,
  ControlLease,
  ManagedSession,
  SessionCapabilities,
  SessionSummary,
  Workbench,
} from "@rah/runtime-protocol";

const DEFAULT_CAPABILITIES: SessionCapabilities = {
  liveAttach: true,
  structuredTimeline: true,
  livePermissions: true,
  contextUsage: true,
  resumeByProvider: true,
  listProviderSessions: true,
  steerInput: false,
  queuedInput: false,
  modelSwitch: false,
  planMode: false,
  subagents: false,
};

export type StoredSessionState = {
  session: ManagedSession;
  clients: AttachedClient[];
  controlLease: ControlLease;
  usage?: {
    usedTokens?: number;
    contextWindow?: number;
    percentRemaining?: number;
  };
  activeTurnId?: string;
};

export function toSessionSummary(state: StoredSessionState): SessionSummary {
  const summary: SessionSummary = {
    session: state.session,
    attachedClients: [...state.clients],
    controlLease: { ...state.controlLease },
  };
  if (state.usage !== undefined) {
    summary.usage = state.usage;
  }
  return summary;
}

export interface CreateManagedSessionArgs {
  provider: ManagedSession["provider"];
  providerSessionId?: string;
  launchSource: ManagedSession["launchSource"];
  cwd: string;
  rootDir: string;
  title?: string;
  preview?: string;
  capabilities?: Partial<SessionCapabilities>;
}

export interface AttachClientArgs {
  sessionId: string;
  clientId: string;
  kind: ClientKind;
  connectionId: string;
  attachMode: AttachMode;
  focus: boolean;
}

export interface PatchManagedSessionArgs {
  providerSessionId?: string;
  title?: string;
  preview?: string;
  cwd?: string;
  rootDir?: string;
}

interface SessionStoreOptions {
  onSnapshot?: (states: readonly StoredSessionState[]) => void;
}

export class SessionStore {
  private readonly sessions = new Map<string, StoredSessionState>();
  private readonly providerSessionIndex = new Map<string, string>();
  private readonly workbench: Workbench = {
    id: "default",
    sessionIds: [],
    layout: {
      panes: [],
    },
  };
  private readonly onSnapshot: ((states: readonly StoredSessionState[]) => void) | undefined;

  constructor(options: SessionStoreOptions = {}) {
    this.onSnapshot = options.onSnapshot;
  }

  listSessions(): StoredSessionState[] {
    return [...this.sessions.values()];
  }

  getSession(sessionId: string): StoredSessionState | undefined {
    return this.sessions.get(sessionId);
  }

  getWorkbench(): Workbench {
    return {
      ...this.workbench,
      sessionIds: [...this.workbench.sessionIds],
      layout: {
        ...this.workbench.layout,
        panes: [...this.workbench.layout.panes],
      },
    };
  }

  createManagedSession(args: CreateManagedSessionArgs): StoredSessionState {
    const now = new Date().toISOString();
    const session: ManagedSession = {
      id: crypto.randomUUID(),
      provider: args.provider,
      launchSource: args.launchSource,
      cwd: args.cwd,
      rootDir: args.rootDir,
      runtimeState: "starting",
      ptyId: crypto.randomUUID(),
      capabilities: {
        ...DEFAULT_CAPABILITIES,
        ...args.capabilities,
      },
      createdAt: now,
      updatedAt: now,
    };
    if (args.providerSessionId !== undefined) {
      session.providerSessionId = args.providerSessionId;
    }
    if (args.title !== undefined) {
      session.title = args.title;
    }
    if (args.preview !== undefined) {
      session.preview = args.preview;
    }

    const state: StoredSessionState = {
      session,
      clients: [],
      controlLease: {
        sessionId: session.id,
      },
      usage: {
        usedTokens: 0,
        contextWindow: 1_000_000,
        percentRemaining: 100,
      },
    };

    this.sessions.set(session.id, state);
    if (session.providerSessionId) {
      this.providerSessionIndex.set(
        this.providerKey(session.provider, session.providerSessionId),
        session.id,
      );
    }
    this.workbench.sessionIds.push(session.id);
    this.workbench.activeSessionId = session.id;
    this.snapshot();
    return state;
  }

  findManagedByProviderSession(
    provider: ManagedSession["provider"],
    providerSessionId: string,
  ): StoredSessionState | undefined {
    const sessionId = this.providerSessionIndex.get(
      this.providerKey(provider, providerSessionId),
    );
    return sessionId ? this.sessions.get(sessionId) : undefined;
  }

  attachClient(args: AttachClientArgs): StoredSessionState {
    const state = this.requireSession(args.sessionId);
    const now = new Date().toISOString();
    const existingIndex = state.clients.findIndex((item) => item.id === args.clientId);
    const nextClient: AttachedClient = {
      id: args.clientId,
      kind: args.kind,
      sessionId: args.sessionId,
      connectionId: args.connectionId,
      attachMode: args.attachMode,
      focus: args.focus,
      lastSeenAt: now,
    };

    if (existingIndex >= 0) {
      state.clients.splice(existingIndex, 1, nextClient);
    } else {
      state.clients.push(nextClient);
    }

    state.session.updatedAt = now;
    this.workbench.activeSessionId = args.sessionId;
    this.snapshot();
    return state;
  }

  detachClient(sessionId: string, clientId: string): StoredSessionState {
    const state = this.requireSession(sessionId);
    state.clients = state.clients.filter((client) => client.id !== clientId);
    if (state.controlLease.holderClientId === clientId) {
      state.controlLease = {
        sessionId,
      };
    }
    state.session.updatedAt = new Date().toISOString();
    this.snapshot();
    return state;
  }

  removeSession(sessionId: string): void {
    const state = this.requireSession(sessionId);
    this.sessions.delete(sessionId);
    if (state.session.providerSessionId) {
      this.providerSessionIndex.delete(
        this.providerKey(state.session.provider, state.session.providerSessionId),
      );
    }
    this.workbench.sessionIds = this.workbench.sessionIds.filter((id) => id !== sessionId);
    if (this.workbench.activeSessionId === sessionId) {
      const nextActive = this.workbench.sessionIds[this.workbench.sessionIds.length - 1];
      if (nextActive) {
        this.workbench.activeSessionId = nextActive;
      } else {
        delete this.workbench.activeSessionId;
      }
    }
    this.snapshot();
  }

  claimControl(sessionId: string, clientId: string): StoredSessionState {
    const state = this.requireSession(sessionId);
    const client = state.clients.find((item) => item.id === clientId);
    if (!client) {
      throw new Error(`Cannot claim control for unknown client ${clientId}`);
    }
    state.controlLease = {
      sessionId,
      holderClientId: client.id,
      holderKind: client.kind,
      grantedAt: new Date().toISOString(),
    };
    state.session.updatedAt = new Date().toISOString();
    this.snapshot();
    return state;
  }

  releaseControl(sessionId: string, clientId?: string): StoredSessionState {
    const state = this.requireSession(sessionId);
    if (clientId && state.controlLease.holderClientId !== clientId) {
      return state;
    }
    state.controlLease = { sessionId };
    state.session.updatedAt = new Date().toISOString();
    this.snapshot();
    return state;
  }

  hasInputControl(sessionId: string, clientId: string): boolean {
    const state = this.requireSession(sessionId);
    return state.controlLease.holderClientId === clientId;
  }

  setRuntimeState(
    sessionId: string,
    runtimeState: ManagedSession["runtimeState"],
  ): StoredSessionState {
    const state = this.requireSession(sessionId);
    state.session.runtimeState = runtimeState;
    state.session.updatedAt = new Date().toISOString();
    this.snapshot();
    return state;
  }

  patchManagedSession(
    sessionId: string,
    patch: PatchManagedSessionArgs,
  ): StoredSessionState {
    const state = this.requireSession(sessionId);
    const previousProviderSessionId = state.session.providerSessionId;

    if (patch.providerSessionId !== undefined) {
      state.session.providerSessionId = patch.providerSessionId;
    }
    if (patch.title !== undefined) {
      state.session.title = patch.title;
    }
    if (patch.preview !== undefined) {
      state.session.preview = patch.preview;
    }
    if (patch.cwd !== undefined) {
      state.session.cwd = patch.cwd;
    }
    if (patch.rootDir !== undefined) {
      state.session.rootDir = patch.rootDir;
    }

    const nextProviderSessionId = state.session.providerSessionId;
    if (
      previousProviderSessionId !== nextProviderSessionId &&
      previousProviderSessionId !== undefined
    ) {
      this.providerSessionIndex.delete(
        this.providerKey(state.session.provider, previousProviderSessionId),
      );
    }
    if (nextProviderSessionId !== undefined) {
      this.providerSessionIndex.set(
        this.providerKey(state.session.provider, nextProviderSessionId),
        sessionId,
      );
    }

    state.session.updatedAt = new Date().toISOString();
    this.snapshot();
    return state;
  }

  setActiveTurn(sessionId: string, turnId?: string): StoredSessionState {
    const state = this.requireSession(sessionId);
    if (turnId === undefined) {
      delete state.activeTurnId;
    } else {
      state.activeTurnId = turnId;
    }
    state.session.updatedAt = new Date().toISOString();
    this.snapshot();
    return state;
  }

  updateUsage(
    sessionId: string,
    usage: StoredSessionState["usage"],
  ): StoredSessionState {
    const state = this.requireSession(sessionId);
    if (usage === undefined) {
      delete state.usage;
    } else {
      state.usage = usage;
    }
    state.session.updatedAt = new Date().toISOString();
    this.snapshot();
    return state;
  }

  hydrate(states: readonly StoredSessionState[]): void {
    this.sessions.clear();
    this.providerSessionIndex.clear();
    this.workbench.sessionIds = [];
    delete this.workbench.activeSessionId;

    for (const state of states) {
      const nextState = cloneStoredSessionState(state);
      this.sessions.set(nextState.session.id, nextState);
      if (nextState.session.providerSessionId) {
        this.providerSessionIndex.set(
          this.providerKey(nextState.session.provider, nextState.session.providerSessionId),
          nextState.session.id,
        );
      }
      this.workbench.sessionIds.push(nextState.session.id);
      this.workbench.activeSessionId = nextState.session.id;
    }
  }

  private requireSession(sessionId: string): StoredSessionState {
    const state = this.sessions.get(sessionId);
    if (!state) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    return state;
  }

  private providerKey(provider: string, providerSessionId: string): string {
    return `${provider}:${providerSessionId}`;
  }

  private snapshot(): void {
    this.onSnapshot?.(this.listSessions());
  }
}

function cloneStoredSessionState(state: StoredSessionState): StoredSessionState {
  return {
    session: {
      ...state.session,
      capabilities: { ...state.session.capabilities },
    },
    clients: state.clients.map((client) => ({ ...client })),
    controlLease: { ...state.controlLease },
    ...(state.usage !== undefined ? { usage: { ...state.usage } } : {}),
    ...(state.activeTurnId !== undefined ? { activeTurnId: state.activeTurnId } : {}),
  };
}
