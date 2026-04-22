import type {
  AttachSessionRequest,
  AttachSessionResponse,
  ClaimControlRequest,
  CloseSessionRequest,
  ContextUsage,
  ControlLease,
  DebugScenarioDescriptor,
  DebugReplayScript,
  EventSubscriptionRequest,
  GitDiffResponse,
  GitStatusResponse,
  InterruptSessionRequest,
  ListSessionsResponse,
  RahEvent,
  ReleaseControlRequest,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SessionFileResponse,
  SessionInputRequest,
  SessionSummary,
  StartSessionRequest,
  StartSessionResponse,
  StoredSessionRef,
  WorkspaceSnapshotResponse,
} from "@rah/runtime-protocol";
import { EventBus } from "./event-bus";
import { PtyHub } from "./pty-hub";
import { SessionStore } from "./session-store";
import { DEBUG_SCENARIOS, type DebugScenario } from "./debug-scenarios";
import { readWorkspaceFile } from "./codex-stored-sessions";

type PendingTurn = {
  sessionId: string;
  turnId: string;
  timers: NodeJS.Timeout[];
};

const DEBUG_SOURCE = {
  provider: "system" as const,
  channel: "system" as const,
  authority: "authoritative" as const,
};

function sanitizeRootDir(cwd: string): string {
  return cwd;
}

function withOptionalTurnId<T extends object>(
  value: T,
  turnId?: string,
): T & { turnId?: string } {
  if (turnId === undefined) {
    return value as T & { turnId?: string };
  }
  return {
    ...value,
    turnId,
  };
}

/**
 * Debug-only engine used to exercise the canonical protocol before any real
 * provider adapter exists.
 */
export class DebugEngine {
  readonly eventBus: EventBus;
  readonly ptyHub: PtyHub;
  readonly sessionStore: SessionStore;
  private readonly storedSessions: StoredSessionRef[];
  private readonly pendingTurns = new Map<string, PendingTurn>();
  private readonly scenarioTimers = new Map<string, NodeJS.Timeout[]>();

  constructor(deps?: {
    eventBus?: EventBus;
    ptyHub?: PtyHub;
    sessionStore?: SessionStore;
    storedSessions?: StoredSessionRef[];
  }) {
    this.eventBus = deps?.eventBus ?? new EventBus();
    this.ptyHub = deps?.ptyHub ?? new PtyHub();
    this.sessionStore = deps?.sessionStore ?? new SessionStore();
    this.storedSessions = deps?.storedSessions ?? [];
  }

  listSessions(): ListSessionsResponse {
    return {
      sessions: this.sessionStore.listSessions().map((state) => this.toSummary(state)),
      storedSessions: [...this.storedSessions],
      recentSessions: [],
      workspaceDirs: [],
    };
  }

  listScenarios(): DebugScenarioDescriptor[] {
    return DEBUG_SCENARIOS.map(
      ({ id, label, description, provider, cwd, rootDir, title, preview }) => {
        const descriptor: DebugScenarioDescriptor = {
          id,
          label,
          description,
          provider,
          cwd,
          rootDir,
          title,
        };
        if (preview !== undefined) {
          descriptor.preview = preview;
        }
        return descriptor;
      },
    );
  }

  startSession(request: StartSessionRequest): StartSessionResponse {
    const createArgs: Parameters<SessionStore["createManagedSession"]>[0] = {
      provider: request.provider,
      launchSource: "web",
      cwd: request.cwd,
      rootDir: sanitizeRootDir(request.cwd),
      capabilities: {
        steerInput: true,
      },
    };
    if (request.title !== undefined) {
      createArgs.title = request.title;
    }
    if (request.initialPrompt !== undefined) {
      createArgs.preview = request.initialPrompt;
    }
    const state = this.sessionStore.createManagedSession(createArgs);
    this.ptyHub.ensureSession(state.session.id);
    this.writeBanner(state.session.id, state.session.provider, state.session.cwd);

    this.eventBus.publish({
      sessionId: state.session.id,
      type: "session.created",
      source: DEBUG_SOURCE,
      payload: { session: state.session },
    });

    this.sessionStore.setRuntimeState(state.session.id, "running");
    this.eventBus.publish({
      sessionId: state.session.id,
      type: "session.started",
      source: DEBUG_SOURCE,
      payload: { session: this.sessionStore.getSession(state.session.id)!.session },
    });

    if (request.attach) {
      this.attachSession(state.session.id, request.attach);
      if (request.attach.claimControl) {
        this.claimControl(state.session.id, { client: request.attach.client });
      }
    }

    return { session: this.toSummary(this.sessionStore.getSession(state.session.id)!) };
  }

  startScenario(args: {
    scenarioId: string;
    attach?: AttachSessionRequest;
  }): StartSessionResponse {
    const scenario = DEBUG_SCENARIOS.find((candidate) => candidate.id === args.scenarioId);
    if (!scenario) {
      throw new Error(`Unknown debug scenario ${args.scenarioId}`);
    }

    const state = this.createScenarioSessionState(scenario);

    this.ptyHub.ensureSession(state.session.id);
    this.writeBanner(state.session.id, state.session.provider, state.session.cwd);
    this.eventBus.publish({
      sessionId: state.session.id,
      type: "session.created",
      source: DEBUG_SOURCE,
      payload: { session: state.session },
    });
    this.sessionStore.setRuntimeState(state.session.id, "running");
    this.eventBus.publish({
      sessionId: state.session.id,
      type: "session.started",
      source: DEBUG_SOURCE,
      payload: { session: this.sessionStore.getSession(state.session.id)!.session },
    });

    if (args.attach) {
      this.attachSession(state.session.id, args.attach);
      if (args.attach.claimControl) {
        this.claimControl(state.session.id, { client: args.attach.client });
      }
    }

    this.scheduleScenario(state.session.id, scenario);
    return { session: this.toSummary(this.sessionStore.getSession(state.session.id)!) };
  }

  buildScenarioReplayScript(scenarioId: string): DebugReplayScript {
    const scenario = DEBUG_SCENARIOS.find((candidate) => candidate.id === scenarioId);
    if (!scenario) {
      throw new Error(`Unknown debug scenario ${scenarioId}`);
    }

    const sessionId = crypto.randomUUID();
    const script = this.createScenarioSessionState(scenario).session;

    const controlLease: ControlLease = {
      sessionId,
    };
    void controlLease;

    return {
      session: {
        ...script,
        id: sessionId,
        ptyId: crypto.randomUUID(),
        runtimeState: "running",
      },
      events: this.materializeScenarioEvents(sessionId, scenario),
    };
  }

  resumeSession(request: ResumeSessionRequest): ResumeSessionResponse {
    const existing = this.sessionStore.findManagedByProviderSession(
      request.provider,
      request.providerSessionId,
    );
    if (existing) {
      throw new Error(
        `Provider session ${request.provider}:${request.providerSessionId} is already running; attach instead of resume.`,
      );
    }

    const stored = this.storedSessions
      .find(
        (item) =>
          item.provider === request.provider &&
          item.providerSessionId === request.providerSessionId,
      );

    const cwd = request.cwd ?? stored?.cwd;
    if (!cwd) {
      throw new Error("Resume requires cwd when no stored session metadata is available.");
    }

    const createArgs: Parameters<SessionStore["createManagedSession"]>[0] = {
      provider: request.provider,
      providerSessionId: request.providerSessionId,
      launchSource: "web",
      cwd,
      rootDir: stored?.rootDir ?? sanitizeRootDir(cwd),
      capabilities: {
        steerInput: true,
      },
    };
    if (stored?.title !== undefined) {
      createArgs.title = stored.title;
    }
    if (stored?.preview !== undefined) {
      createArgs.preview = stored.preview;
    }
    const state = this.sessionStore.createManagedSession(createArgs);

    this.ptyHub.ensureSession(state.session.id);
    this.writeBanner(state.session.id, state.session.provider, state.session.cwd);
    this.ptyHub.appendOutput(
      state.session.id,
      `Rehydrated provider session ${request.providerSessionId}\r\n$ `,
    );

    this.eventBus.publish({
      sessionId: state.session.id,
      type: "session.created",
      source: DEBUG_SOURCE,
      payload: { session: state.session },
    });

    this.sessionStore.setRuntimeState(state.session.id, "running");
    this.eventBus.publish({
      sessionId: state.session.id,
      type: "session.started",
      source: DEBUG_SOURCE,
      payload: { session: this.sessionStore.getSession(state.session.id)!.session },
    });

    if (request.attach) {
      this.attachSession(state.session.id, request.attach);
      if (request.attach.claimControl) {
        this.claimControl(state.session.id, { client: request.attach.client });
      }
    }

    return { session: this.toSummary(this.sessionStore.getSession(state.session.id)!) };
  }

  attachSession(
    sessionId: string,
    request: AttachSessionRequest,
  ): AttachSessionResponse {
    const state = this.sessionStore.attachClient({
      sessionId,
      clientId: request.client.id,
      kind: request.client.kind,
      connectionId: request.client.connectionId,
      attachMode: request.mode,
      focus: true,
    });

    this.eventBus.publish({
      sessionId,
      type: "session.attached",
      source: DEBUG_SOURCE,
      payload: {
        clientId: request.client.id,
        clientKind: request.client.kind,
      },
    });

    if (request.claimControl) {
      this.claimControl(sessionId, { client: request.client });
    }

    return { session: this.toSummary(state) };
  }

  claimControl(sessionId: string, request: ClaimControlRequest): SessionSummary {
    const state = this.sessionStore.attachClient({
      sessionId,
      clientId: request.client.id,
      kind: request.client.kind,
      connectionId: request.client.connectionId,
      attachMode: "interactive",
      focus: true,
    });
    this.sessionStore.claimControl(sessionId, request.client.id);
    this.eventBus.publish({
      sessionId,
      type: "control.claimed",
      source: DEBUG_SOURCE,
      payload: {
        clientId: request.client.id,
        clientKind: request.client.kind,
      },
    });
    return this.toSummary(this.sessionStore.getSession(state.session.id)!);
  }

  releaseControl(sessionId: string, request: ReleaseControlRequest): SessionSummary {
    this.sessionStore.releaseControl(sessionId, request.clientId);
    this.eventBus.publish({
      sessionId,
      type: "control.released",
      source: DEBUG_SOURCE,
      payload: {
        clientId: request.clientId,
      },
    });
    return this.toSummary(this.sessionStore.getSession(sessionId)!);
  }

  sendInput(sessionId: string, request: SessionInputRequest): void {
    if (!this.sessionStore.hasInputControl(sessionId, request.clientId)) {
      throw new Error(`Client ${request.clientId} does not hold input control for ${sessionId}.`);
    }
    const turnId = crypto.randomUUID();
    this.abortPendingTurn(sessionId, "superseded");
    this.sessionStore.setActiveTurn(sessionId, turnId);
    this.sessionStore.setRuntimeState(sessionId, "running");

    this.ptyHub.appendOutput(sessionId, `${request.text}\r\n`);

    this.eventBus.publish({
      sessionId,
      turnId,
      type: "turn.started",
      source: DEBUG_SOURCE,
      payload: {},
    });
    this.eventBus.publish({
      sessionId,
      turnId,
      type: "timeline.item.added",
      source: DEBUG_SOURCE,
      payload: {
        item: {
          kind: "user_message",
          text: request.text,
        },
      },
    });

    const timers: NodeJS.Timeout[] = [];
    timers.push(
      setTimeout(() => {
        this.ptyHub.appendOutput(sessionId, "Analyzing request...\r\n");
        this.eventBus.publish({
          sessionId,
          turnId,
          type: "timeline.item.added",
          source: {
            provider: "custom",
            channel: "structured_live",
            authority: "derived",
          },
          payload: {
            item: {
              kind: "reasoning",
              text: "Planning next action from debug engine.",
            },
          },
        });
      }, 120),
    );

    const toolCallId = crypto.randomUUID();
    timers.push(
      setTimeout(() => {
        this.eventBus.publish({
          sessionId,
          turnId,
          type: "tool.call.started",
          source: {
            provider: "custom",
            channel: "structured_live",
            authority: "derived",
          },
          payload: {
            toolCall: {
              id: toolCallId,
              family: "shell",
              providerToolName: "debug.shell",
              title: "List workspace files",
              input: {
                command: "rg --files",
              },
              detail: {
                artifacts: [
                  {
                    kind: "command",
                    command: "rg --files",
                    cwd: this.sessionStore.getSession(sessionId)!.session.cwd,
                  },
                ],
              },
            },
          },
        });
        this.ptyHub.appendOutput(
          sessionId,
          "$ rg --files\r\nREADME.md\r\nsrc/index.ts\r\nsrc/app.tsx\r\n",
        );
      }, 260),
    );

    timers.push(
      setTimeout(() => {
        this.eventBus.publish({
          sessionId,
          turnId,
          type: "tool.call.completed",
          source: {
            provider: "custom",
            channel: "structured_live",
            authority: "derived",
          },
          payload: {
            toolCall: {
              id: toolCallId,
              family: "shell",
              providerToolName: "debug.shell",
              title: "List workspace files",
              summary: "Found 3 files.",
              result: {
                exitCode: 0,
              },
              detail: {
                artifacts: [
                  {
                    kind: "text",
                    label: "stdout",
                    text: "README.md\nsrc/index.ts\nsrc/app.tsx",
                  },
                ],
              },
            },
          },
        });
      }, 420),
    );

    timers.push(
      setTimeout(() => {
        this.ptyHub.appendOutput(
          sessionId,
          "Prepared a debug response using the canonical event pipeline.\r\n$ ",
        );
        this.eventBus.publish({
          sessionId,
          turnId,
          type: "timeline.item.added",
          source: {
            provider: "custom",
            channel: "structured_live",
            authority: "derived",
          },
          payload: {
            item: {
              kind: "assistant_message",
              text: "Debug response completed. The session remained runtime-owned and attachable.",
            },
          },
        });

        const usage: ContextUsage = {
          usedTokens: 12_480,
          contextWindow: 1_000_000,
          percentRemaining: 99,
        };
        this.sessionStore.updateUsage(sessionId, usage);
        this.eventBus.publish({
          sessionId,
          turnId,
          type: "usage.updated",
          source: {
            provider: "custom",
            channel: "structured_live",
            authority: "derived",
          },
          payload: { usage },
        });
        this.eventBus.publish({
          sessionId,
          turnId,
          type: "context.updated",
          source: {
            provider: "custom",
            channel: "structured_live",
            authority: "derived",
          },
          payload: { usage },
        });
        this.eventBus.publish({
          sessionId,
          turnId,
          type: "turn.completed",
          source: DEBUG_SOURCE,
          payload: { usage },
        });
        this.eventBus.publish({
          sessionId,
          type: "attention.required",
          source: DEBUG_SOURCE,
          payload: {
            item: {
              id: crypto.randomUUID(),
              sessionId,
              level: "info",
              reason: "turn_finished",
              title: "Turn finished",
              body: "Debug session completed a turn.",
              dedupeKey: `${sessionId}:${turnId}:turn_finished`,
              createdAt: new Date().toISOString(),
            },
          },
        });
        this.sessionStore.setActiveTurn(sessionId, undefined);
        this.sessionStore.setRuntimeState(sessionId, "idle");
        this.pendingTurns.delete(sessionId);
      }, 680),
    );

    this.pendingTurns.set(sessionId, {
      sessionId,
      turnId,
      timers,
    });
  }

  interruptSession(sessionId: string, request: InterruptSessionRequest): SessionSummary {
    if (!this.sessionStore.hasInputControl(sessionId, request.clientId)) {
      throw new Error(`Client ${request.clientId} does not hold input control for ${sessionId}.`);
    }
    this.abortPendingTurn(sessionId, "interrupted");
    return this.toSummary(this.sessionStore.getSession(sessionId)!);
  }

  closeSession(sessionId: string, request: CloseSessionRequest): void {
    const state = this.sessionStore.getSession(sessionId);
    if (!state) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    if (!state.clients.some((client) => client.id === request.clientId)) {
      throw new Error(`Client ${request.clientId} is not attached to ${sessionId}.`);
    }
    this.abortPendingTurn(sessionId, "closed");
    const timers = this.scenarioTimers.get(sessionId);
    if (timers) {
      for (const timer of timers) {
        clearTimeout(timer);
      }
      this.scenarioTimers.delete(sessionId);
    }
  }

  destroySession(sessionId: string): void {
    this.abortPendingTurn(sessionId, "closed");
    const timers = this.scenarioTimers.get(sessionId);
    if (timers) {
      for (const timer of timers) {
        clearTimeout(timer);
      }
      this.scenarioTimers.delete(sessionId);
    }
  }

  onPtyInput(sessionId: string, clientId: string, data: string): void {
    if (!this.sessionStore.hasInputControl(sessionId, clientId)) {
      throw new Error(`Client ${clientId} does not hold input control for ${sessionId}.`);
    }
    this.ptyHub.appendOutput(sessionId, data);
  }

  onPtyResize(sessionId: string, clientId: string, cols: number, rows: number): void {
    if (!this.sessionStore.hasInputControl(sessionId, clientId)) {
      throw new Error(`Client ${clientId} does not hold input control for ${sessionId}.`);
    }
    this.eventBus.publish({
      sessionId,
      type: "terminal.output",
      source: {
        provider: "system",
        channel: "pty",
        authority: "authoritative",
      },
      payload: {
        data: `[pty resized to ${cols}x${rows}]`,
      },
    });
  }

  getSessionSummary(sessionId: string): SessionSummary {
    return this.toSummary(this.sessionStore.getSession(sessionId)!);
  }

  getWorkspaceSnapshot(sessionId: string): WorkspaceSnapshotResponse {
    const session = this.sessionStore.getSession(sessionId)?.session;
    if (!session) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    return {
      sessionId,
      cwd: session.cwd,
      nodes: [
        { path: `${session.cwd}/README.md`, name: "README.md", kind: "file" },
        { path: `${session.cwd}/src`, name: "src", kind: "directory" },
        { path: `${session.cwd}/src/index.ts`, name: "index.ts", kind: "file" },
      ],
    };
  }

  getGitStatus(sessionId: string): GitStatusResponse {
    const session = this.sessionStore.getSession(sessionId)?.session;
    if (!session) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    return {
      sessionId,
      branch: "main",
      changedFiles: ["src/index.ts"],
    };
  }

  getGitDiff(sessionId: string, path: string): GitDiffResponse {
    return {
      sessionId,
      path,
      diff: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@\n-console.log("before");\n+console.log("after");\n`,
    };
  }

  readSessionFile(sessionId: string, path: string): SessionFileResponse {
    const session = this.sessionStore.getSession(sessionId)?.session;
    if (!session) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    const normalizedPath = path.replace(/\\/g, "/");
    if (normalizedPath.endsWith("/README.md") || normalizedPath === "README.md") {
      return {
        sessionId,
        path,
        content: "# Debug workspace\n\nThis is a synthetic file preview for the debug adapter.\n",
        binary: false,
      };
    }
    if (normalizedPath.endsWith("/src/index.ts") || normalizedPath === "src/index.ts") {
      return {
        sessionId,
        path,
        content: 'console.log("after");\n',
        binary: false,
      };
    }
    return {
      sessionId,
      ...readWorkspaceFile(session.cwd, path),
    };
  }

  getContextUsage(sessionId: string): ContextUsage | undefined {
    return this.sessionStore.getSession(sessionId)?.usage;
  }

  listEvents(filter: EventSubscriptionRequest): RahEvent[] {
    return this.eventBus.list(filter);
  }

  private toSummary(state: ReturnType<SessionStore["getSession"]> extends infer T
    ? Exclude<T, undefined>
    : never): SessionSummary {
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

  private abortPendingTurn(sessionId: string, reason: string): void {
    const pending = this.pendingTurns.get(sessionId);
    if (!pending) {
      return;
    }
    for (const timer of pending.timers) {
      clearTimeout(timer);
    }
    this.pendingTurns.delete(sessionId);
    this.ptyHub.appendOutput(sessionId, "^C\r\n$ ");
    this.eventBus.publish({
      sessionId,
      turnId: pending.turnId,
      type: "turn.canceled",
      source: DEBUG_SOURCE,
      payload: { reason },
    });
    this.sessionStore.setActiveTurn(sessionId, undefined);
    this.sessionStore.setRuntimeState(sessionId, "idle");
  }

  private scheduleScenario(sessionId: string, scenario: DebugScenario): void {
    const timers: NodeJS.Timeout[] = [];
    for (const step of scenario.steps) {
      const timer = setTimeout(() => {
        this.applyScenarioStep(sessionId, step);
      }, step.delayMs);
      timers.push(timer);
    }
    this.scenarioTimers.set(sessionId, timers);
  }

  private createScenarioSessionState(scenario: DebugScenario) {
    const createArgs: Parameters<SessionStore["createManagedSession"]>[0] = {
      provider: scenario.provider,
      launchSource: "web",
      cwd: scenario.cwd,
      rootDir: scenario.rootDir,
      title: scenario.title,
      capabilities: {
        steerInput: true,
      },
    };
    if (scenario.preview !== undefined) {
      createArgs.preview = scenario.preview;
    }
    return this.sessionStore.createManagedSession(createArgs);
  }

  private applyScenarioStep(sessionId: string, step: DebugScenario["steps"][number]): void {
    switch (step.kind) {
      case "pty":
        this.ptyHub.appendOutput(sessionId, step.data);
        return;
      case "turn_started":
        this.sessionStore.setActiveTurn(sessionId, step.turnId);
        this.sessionStore.setRuntimeState(sessionId, "running");
        this.eventBus.publish(
          withOptionalTurnId(
            {
              sessionId,
              type: "turn.started",
              source: DEBUG_SOURCE,
              payload: {},
            },
            step.turnId,
          ),
        );
        return;
      case "turn_completed":
        this.sessionStore.setActiveTurn(sessionId, undefined);
        this.sessionStore.setRuntimeState(sessionId, "idle");
        if (step.usage) {
          this.sessionStore.updateUsage(sessionId, step.usage);
        }
        this.eventBus.publish(
          withOptionalTurnId(
            {
              sessionId,
              type: "turn.completed",
              source: DEBUG_SOURCE,
              payload: step.usage ? { usage: step.usage } : {},
            },
            step.turnId,
          ),
        );
        return;
      case "turn_failed":
        this.sessionStore.setActiveTurn(sessionId, undefined);
        this.sessionStore.setRuntimeState(sessionId, "failed");
        this.eventBus.publish(
          withOptionalTurnId(
            {
              sessionId,
              type: "turn.failed",
              source: DEBUG_SOURCE,
              payload: { error: step.error, ...(step.code ? { code: step.code } : {}) },
            },
            step.turnId,
          ),
        );
        return;
      case "turn_canceled":
        this.sessionStore.setActiveTurn(sessionId, undefined);
        this.sessionStore.setRuntimeState(sessionId, "idle");
        this.eventBus.publish(
          withOptionalTurnId(
            {
              sessionId,
              type: "turn.canceled",
              source: DEBUG_SOURCE,
              payload: { reason: step.reason },
            },
            step.turnId,
          ),
        );
        return;
      case "timeline":
        this.eventBus.publish(
          withOptionalTurnId(
            {
              sessionId,
              type: "timeline.item.added",
              source: {
                provider: "custom",
                channel: "structured_live",
                authority: "derived",
              },
              payload: { item: step.item },
            },
            step.turnId,
          ),
        );
        return;
      case "message_part_added":
        this.eventBus.publish(
          withOptionalTurnId(
            {
              sessionId,
              type: "message.part.added",
              source: { provider: "custom", channel: "structured_live", authority: "derived" },
              payload: { part: step.part },
            },
            step.turnId,
          ),
        );
        return;
      case "message_part_delta":
        this.eventBus.publish(
          withOptionalTurnId(
            {
              sessionId,
              type: "message.part.delta",
              source: { provider: "custom", channel: "structured_live", authority: "derived" },
              payload: { part: step.part },
            },
            step.turnId,
          ),
        );
        return;
      case "message_part_updated":
        this.eventBus.publish(
          withOptionalTurnId(
            {
              sessionId,
              type: "message.part.updated",
              source: { provider: "custom", channel: "structured_live", authority: "derived" },
              payload: { part: step.part },
            },
            step.turnId,
          ),
        );
        return;
      case "message_part_removed":
        this.eventBus.publish(
          withOptionalTurnId(
            {
              sessionId,
              type: "message.part.removed",
              source: { provider: "custom", channel: "structured_live", authority: "derived" },
              payload: { messageId: step.messageId, partId: step.partId },
            },
            step.turnId,
          ),
        );
        return;
      case "tool_started":
        this.eventBus.publish(
          withOptionalTurnId(
            {
              sessionId,
              type: "tool.call.started",
              source: {
                provider: "custom",
                channel: "structured_live",
                authority: "derived",
              },
              payload: { toolCall: step.toolCall },
            },
            step.turnId,
          ),
        );
        return;
      case "tool_delta":
        this.eventBus.publish(
          withOptionalTurnId(
            {
              sessionId,
              type: "tool.call.delta",
              source: { provider: "custom", channel: "structured_live", authority: "derived" },
              payload: { toolCallId: step.toolCallId, detail: step.detail },
            },
            step.turnId,
          ),
        );
        return;
      case "tool_completed":
        this.eventBus.publish(
          withOptionalTurnId(
            {
              sessionId,
              type: "tool.call.completed",
              source: {
                provider: "custom",
                channel: "structured_live",
                authority: "derived",
              },
              payload: { toolCall: step.toolCall },
            },
            step.turnId,
          ),
        );
        return;
      case "tool_failed":
        this.eventBus.publish(
          withOptionalTurnId(
            {
              sessionId,
              type: "tool.call.failed",
              source: {
                provider: "custom",
                channel: "structured_live",
                authority: "derived",
              },
              payload: { toolCallId: step.toolCallId, error: step.error },
            },
            step.turnId,
          ),
        );
        return;
      case "observation_started":
        this.eventBus.publish(
          withOptionalTurnId(
            {
              sessionId,
              type: "observation.started",
              source: { provider: "custom", channel: "structured_live", authority: "derived" },
              payload: { observation: step.observation },
            },
            step.turnId,
          ),
        );
        return;
      case "observation_updated":
        this.eventBus.publish(
          withOptionalTurnId(
            {
              sessionId,
              type: "observation.updated",
              source: { provider: "custom", channel: "structured_live", authority: "derived" },
              payload: { observation: step.observation },
            },
            step.turnId,
          ),
        );
        return;
      case "observation_completed":
        this.eventBus.publish(
          withOptionalTurnId(
            {
              sessionId,
              type: "observation.completed",
              source: { provider: "custom", channel: "structured_live", authority: "derived" },
              payload: { observation: step.observation },
            },
            step.turnId,
          ),
        );
        return;
      case "observation_failed":
        this.eventBus.publish(
          withOptionalTurnId(
            {
              sessionId,
              type: "observation.failed",
              source: { provider: "custom", channel: "structured_live", authority: "derived" },
              payload: {
                observation: step.observation,
                ...(step.error !== undefined ? { error: step.error } : {}),
              },
            },
            step.turnId,
          ),
        );
        return;
      case "permission_requested":
        this.sessionStore.setRuntimeState(sessionId, "waiting_permission");
        this.eventBus.publish(
          withOptionalTurnId(
            {
              sessionId,
              type: "permission.requested",
              source: {
                provider: "custom",
                channel: "structured_live",
                authority: "derived",
              },
              payload: { request: step.request },
            },
            step.turnId,
          ),
        );
        return;
      case "permission_resolved":
        this.sessionStore.setRuntimeState(sessionId, "running");
        this.eventBus.publish(
          withOptionalTurnId(
            {
              sessionId,
              type: "permission.resolved",
              source: {
                provider: "custom",
                channel: "structured_live",
                authority: "derived",
              },
              payload: { resolution: step.resolution },
            },
            step.turnId,
          ),
        );
        return;
      case "usage":
        this.sessionStore.updateUsage(sessionId, step.usage);
        this.eventBus.publish(
          withOptionalTurnId(
            {
              sessionId,
              type: "usage.updated",
              source: {
                provider: "custom",
                channel: "structured_live",
                authority: "derived",
              },
              payload: { usage: step.usage },
            },
            step.turnId,
          ),
        );
        this.eventBus.publish(
          withOptionalTurnId(
            {
              sessionId,
              type: "context.updated",
              source: {
                provider: "custom",
                channel: "structured_live",
                authority: "derived",
              },
              payload: { usage: step.usage },
            },
            step.turnId,
          ),
        );
        return;
      case "operation_started":
        this.eventBus.publish(
          withOptionalTurnId(
            {
              sessionId,
              type: "operation.started",
              source: { provider: "custom", channel: "structured_live", authority: "derived" },
              payload: { operation: step.operation },
            },
            step.turnId,
          ),
        );
        return;
      case "operation_resolved":
        this.eventBus.publish(
          withOptionalTurnId(
            {
              sessionId,
              type: "operation.resolved",
              source: { provider: "custom", channel: "structured_live", authority: "derived" },
              payload: { operation: step.operation },
            },
            step.turnId,
          ),
        );
        return;
      case "operation_requested":
        this.eventBus.publish(
          withOptionalTurnId(
            {
              sessionId,
              type: "operation.requested",
              source: { provider: "custom", channel: "structured_live", authority: "derived" },
              payload: { operation: step.operation },
            },
            step.turnId,
          ),
        );
        return;
      case "runtime_status":
        this.eventBus.publish(
          withOptionalTurnId(
            {
              sessionId,
              type: "runtime.status",
              source: { provider: "custom", channel: "structured_live", authority: "derived" },
              payload: {
                status: step.status,
                ...(step.detail !== undefined ? { detail: step.detail } : {}),
                ...(step.retryCount !== undefined ? { retryCount: step.retryCount } : {}),
              },
            },
            step.turnId,
          ),
        );
        return;
      case "notification":
        this.eventBus.publish(
          withOptionalTurnId(
            {
              sessionId,
              type: "notification.emitted",
              source: { provider: "custom", channel: "structured_live", authority: "derived" },
              payload: {
                level: step.level,
                title: step.title,
                body: step.body,
                ...(step.url !== undefined ? { url: step.url } : {}),
              },
            },
            step.turnId,
          ),
        );
        return;
      case "attention_cleared":
        this.eventBus.publish(
          withOptionalTurnId(
            {
              sessionId,
              type: "attention.cleared",
              source: DEBUG_SOURCE,
              payload: { id: step.id },
            },
            step.turnId,
          ),
        );
        return;
      case "attention":
        this.eventBus.publish({
          sessionId,
          type: "attention.required",
          source: DEBUG_SOURCE,
          payload: {
            item: {
              id: crypto.randomUUID(),
              sessionId,
              level: step.level ?? "info",
              reason: step.reason,
              title: step.title,
              body: step.body,
              dedupeKey: step.dedupeKey,
              createdAt: new Date().toISOString(),
            },
          },
        });
        return;
    }
  }

  private materializeScenarioEvents(sessionId: string, scenario: DebugScenario) {
    const bus = new EventBus();
    const session = this.createScenarioSessionState(scenario).session;
    void session;
    for (const step of scenario.steps) {
      const ts = new Date(Date.now() + step.delayMs).toISOString();
      switch (step.kind) {
        case "turn_started":
          bus.publish(
            withOptionalTurnId(
              { sessionId, type: "turn.started", source: DEBUG_SOURCE, payload: {}, ts },
              step.turnId,
            ),
          );
          break;
        case "turn_completed":
          bus.publish(
            withOptionalTurnId(
              {
                sessionId,
                type: "turn.completed",
                source: DEBUG_SOURCE,
                payload: step.usage ? { usage: step.usage } : {},
                ts,
              },
              step.turnId,
            ),
          );
          break;
        case "turn_failed":
          bus.publish(
            withOptionalTurnId(
              {
                sessionId,
                type: "turn.failed",
                source: DEBUG_SOURCE,
                payload: { error: step.error, ...(step.code ? { code: step.code } : {}) },
                ts,
              },
              step.turnId,
            ),
          );
          break;
        case "turn_canceled":
          bus.publish(
            withOptionalTurnId(
              {
                sessionId,
                type: "turn.canceled",
                source: DEBUG_SOURCE,
                payload: { reason: step.reason },
                ts,
              },
              step.turnId,
            ),
          );
          break;
        case "timeline":
          bus.publish(
            withOptionalTurnId(
              {
                sessionId,
                type: "timeline.item.added",
                source: {
                  provider: "custom",
                  channel: "structured_live",
                  authority: "derived",
                },
                payload: { item: step.item },
                ts,
              },
              step.turnId,
            ),
          );
          break;
        case "message_part_added":
          bus.publish(
            withOptionalTurnId(
              {
                sessionId,
                type: "message.part.added",
                source: { provider: "custom", channel: "structured_live", authority: "derived" },
                payload: { part: step.part },
                ts,
              },
              step.turnId,
            ),
          );
          break;
        case "message_part_delta":
          bus.publish(
            withOptionalTurnId(
              {
                sessionId,
                type: "message.part.delta",
                source: { provider: "custom", channel: "structured_live", authority: "derived" },
                payload: { part: step.part },
                ts,
              },
              step.turnId,
            ),
          );
          break;
        case "message_part_updated":
          bus.publish(
            withOptionalTurnId(
              {
                sessionId,
                type: "message.part.updated",
                source: { provider: "custom", channel: "structured_live", authority: "derived" },
                payload: { part: step.part },
                ts,
              },
              step.turnId,
            ),
          );
          break;
        case "message_part_removed":
          bus.publish(
            withOptionalTurnId(
              {
                sessionId,
                type: "message.part.removed",
                source: { provider: "custom", channel: "structured_live", authority: "derived" },
                payload: { messageId: step.messageId, partId: step.partId },
                ts,
              },
              step.turnId,
            ),
          );
          break;
        case "tool_started":
          bus.publish(
            withOptionalTurnId(
              {
                sessionId,
                type: "tool.call.started",
                source: {
                  provider: "custom",
                  channel: "structured_live",
                  authority: "derived",
                },
                payload: { toolCall: step.toolCall },
                ts,
              },
              step.turnId,
            ),
          );
          break;
        case "tool_delta":
          bus.publish(
            withOptionalTurnId(
              {
                sessionId,
                type: "tool.call.delta",
                source: { provider: "custom", channel: "structured_live", authority: "derived" },
                payload: { toolCallId: step.toolCallId, detail: step.detail },
                ts,
              },
              step.turnId,
            ),
          );
          break;
        case "tool_completed":
          bus.publish(
            withOptionalTurnId(
              {
                sessionId,
                type: "tool.call.completed",
                source: {
                  provider: "custom",
                  channel: "structured_live",
                  authority: "derived",
                },
                payload: { toolCall: step.toolCall },
                ts,
              },
              step.turnId,
            ),
          );
          break;
        case "tool_failed":
          bus.publish(
            withOptionalTurnId(
              {
                sessionId,
                type: "tool.call.failed",
                source: {
                  provider: "custom",
                  channel: "structured_live",
                  authority: "derived",
                },
                payload: { toolCallId: step.toolCallId, error: step.error },
                ts,
              },
              step.turnId,
            ),
          );
          break;
        case "observation_started":
          bus.publish(
            withOptionalTurnId(
              {
                sessionId,
                type: "observation.started",
                source: { provider: "custom", channel: "structured_live", authority: "derived" },
                payload: { observation: step.observation },
                ts,
              },
              step.turnId,
            ),
          );
          break;
        case "observation_updated":
          bus.publish(
            withOptionalTurnId(
              {
                sessionId,
                type: "observation.updated",
                source: { provider: "custom", channel: "structured_live", authority: "derived" },
                payload: { observation: step.observation },
                ts,
              },
              step.turnId,
            ),
          );
          break;
        case "observation_completed":
          bus.publish(
            withOptionalTurnId(
              {
                sessionId,
                type: "observation.completed",
                source: { provider: "custom", channel: "structured_live", authority: "derived" },
                payload: { observation: step.observation },
                ts,
              },
              step.turnId,
            ),
          );
          break;
        case "observation_failed":
          bus.publish(
            withOptionalTurnId(
              {
                sessionId,
                type: "observation.failed",
                source: { provider: "custom", channel: "structured_live", authority: "derived" },
                payload: {
                  observation: step.observation,
                  ...(step.error !== undefined ? { error: step.error } : {}),
                },
                ts,
              },
              step.turnId,
            ),
          );
          break;
        case "permission_requested":
          bus.publish(
            withOptionalTurnId(
              {
                sessionId,
                type: "permission.requested",
                source: {
                  provider: "custom",
                  channel: "structured_live",
                  authority: "derived",
                },
                payload: { request: step.request },
                ts,
              },
              step.turnId,
            ),
          );
          break;
        case "permission_resolved":
          bus.publish(
            withOptionalTurnId(
              {
                sessionId,
                type: "permission.resolved",
                source: {
                  provider: "custom",
                  channel: "structured_live",
                  authority: "derived",
                },
                payload: { resolution: step.resolution },
                ts,
              },
              step.turnId,
            ),
          );
          break;
        case "usage":
          bus.publish(
            withOptionalTurnId(
              {
                sessionId,
                type: "usage.updated",
                source: {
                  provider: "custom",
                  channel: "structured_live",
                  authority: "derived",
                },
                payload: { usage: step.usage },
                ts,
              },
              step.turnId,
            ),
          );
          bus.publish(
            withOptionalTurnId(
              {
                sessionId,
                type: "context.updated",
                source: {
                  provider: "custom",
                  channel: "structured_live",
                  authority: "derived",
                },
                payload: { usage: step.usage },
                ts,
              },
              step.turnId,
            ),
          );
          break;
        case "operation_started":
          bus.publish(
            withOptionalTurnId(
              {
                sessionId,
                type: "operation.started",
                source: { provider: "custom", channel: "structured_live", authority: "derived" },
                payload: { operation: step.operation },
                ts,
              },
              step.turnId,
            ),
          );
          break;
        case "operation_resolved":
          bus.publish(
            withOptionalTurnId(
              {
                sessionId,
                type: "operation.resolved",
                source: { provider: "custom", channel: "structured_live", authority: "derived" },
                payload: { operation: step.operation },
                ts,
              },
              step.turnId,
            ),
          );
          break;
        case "operation_requested":
          bus.publish(
            withOptionalTurnId(
              {
                sessionId,
                type: "operation.requested",
                source: { provider: "custom", channel: "structured_live", authority: "derived" },
                payload: { operation: step.operation },
                ts,
              },
              step.turnId,
            ),
          );
          break;
        case "runtime_status":
          bus.publish(
            withOptionalTurnId(
              {
                sessionId,
                type: "runtime.status",
                source: { provider: "custom", channel: "structured_live", authority: "derived" },
                payload: {
                  status: step.status,
                  ...(step.detail !== undefined ? { detail: step.detail } : {}),
                  ...(step.retryCount !== undefined ? { retryCount: step.retryCount } : {}),
                },
                ts,
              },
              step.turnId,
            ),
          );
          break;
        case "notification":
          bus.publish(
            withOptionalTurnId(
              {
                sessionId,
                type: "notification.emitted",
                source: { provider: "custom", channel: "structured_live", authority: "derived" },
                payload: {
                  level: step.level,
                  title: step.title,
                  body: step.body,
                  ...(step.url !== undefined ? { url: step.url } : {}),
                },
                ts,
              },
              step.turnId,
            ),
          );
          break;
        case "attention_cleared":
          bus.publish(
            withOptionalTurnId(
              {
                sessionId,
                type: "attention.cleared",
                source: DEBUG_SOURCE,
                payload: { id: step.id },
                ts,
              },
              step.turnId,
            ),
          );
          break;
        case "attention":
          bus.publish({
            sessionId,
            type: "attention.required",
            source: DEBUG_SOURCE,
            payload: {
              item: {
                id: crypto.randomUUID(),
                sessionId,
                level: step.level ?? "info",
                reason: step.reason,
                title: step.title,
                body: step.body,
                dedupeKey: step.dedupeKey,
                createdAt: ts,
              },
            },
            ts,
          });
          break;
        case "pty":
          break;
      }
    }
    return bus.list();
  }

  private writeBanner(sessionId: string, provider: string, cwd: string): void {
    this.ptyHub.appendOutput(
      sessionId,
      `rah debug runtime attached to ${provider} in ${cwd}\r\n$ `,
    );
  }
}
