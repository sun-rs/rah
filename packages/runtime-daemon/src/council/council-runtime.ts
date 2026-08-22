import type {
  AddCouncilAgentRequest,
  AddCouncilAgentResponse,
  CouncilMessage,
  CouncilAgentTuiResponse,
  CouncilMessagesPageResponse,
  CouncilMcpRequest,
  CouncilMcpResponse,
  CouncilPostMessageRequest,
  CouncilPostMessageResponse,
  CouncilReinjectAgentsResponse,
  CouncilRemoveAgentResponse,
  CouncilSnapshot,
  CouncilSummary,
  CouncilStopAgentResponse,
  CreateCouncilRequest,
  CreateCouncilResponse,
  ListCouncilsResponse,
  SessionInputRequest,
  InterruptSessionRequest,
  SessionSummary,
  StartSessionRequest,
  StartSessionResponse,
} from "@rah/runtime-protocol";
import { isNativeLocalServerProvider } from "@rah/runtime-protocol";
import { fileURLToPath } from "node:url";
import type { StartSessionMcpOptions } from "../provider-mcp-server-spec";
import type { EventBus } from "../event-bus";
import { CouncilStore } from "./council-store";
import {
  CouncilDeliveryCoordinator,
  type CouncilDeliveryLifecycle,
} from "./council-delivery-coordinator";
import {
  councilMessageTargetAgentIds,
  councilMessageTargetsAgent,
} from "./council-message-routing";
import {
  handleCouncilMcpRequest,
  pausedCouncilMcpWaitResponse,
  type CouncilMcpWaitNew,
  type CouncilMcpWaitNewResult,
} from "./council-mcp-shim";
import {
  isAgentDeliverableCouncilMessage,
  isClientVisibleCouncilMessage,
} from "./council-message-visibility";

const DEFAULT_DAEMON_URL = "http://127.0.0.1:43111";
const COUNCIL_CLIENT_MESSAGE_WINDOW_LIMIT = 100;
type CouncilRecoveryWakeResult = "queued" | "skipped";

export type CouncilRuntimeOptions = {
  store?: CouncilStore;
  dryRun?: boolean;
  eventBus?: EventBus;
  startSession?: (request: StartSessionRequest & StartSessionMcpOptions) => Promise<StartSessionResponse>;
  sendInput?: (sessionId: string, request: SessionInputRequest) => void;
  sendStructuredInput?: (sessionId: string, request: SessionInputRequest) => void;
  interruptSession?: (sessionId: string, request: InterruptSessionRequest) => void;
  closeSession?: (sessionId: string) => Promise<void>;
  hasSession?: (sessionId: string) => boolean;
  isSessionBusy?: (sessionId: string) => boolean;
};

type CouncilMessageWaiter = {
  actorId: string;
  clientId: string;
  sinceMessageId: number;
  resolve: (message: CouncilMcpWaitNewResult) => void;
  timeout: NodeJS.Timeout;
};

type CouncilMcpClientState = {
  lastSeenMessageId: number;
  listeningAnnounced: boolean;
};

export class CouncilRuntime {
  readonly store: CouncilStore;
  private readonly dryRun: boolean;
  private readonly eventBus: EventBus | undefined;
  private readonly startSession: CouncilRuntimeOptions["startSession"];
  private readonly sendInput: CouncilRuntimeOptions["sendInput"];
  private readonly sendStructuredInput: CouncilRuntimeOptions["sendStructuredInput"];
  private readonly interruptSession: CouncilRuntimeOptions["interruptSession"];
  private readonly closeSession: CouncilRuntimeOptions["closeSession"];
  private readonly hasSession: CouncilRuntimeOptions["hasSession"];
  private readonly delivery: CouncilDeliveryCoordinator;
  private readonly messageWaiters = new Map<string, Set<CouncilMessageWaiter>>();
  private readonly mcpClientStates = new Map<string, CouncilMcpClientState>();
  private readonly pausedCouncilAgents = new Map<string, Set<string>>();
  private readonly pendingLaunchCouncils = new Set<string>();
  private readonly councilLaunchTasks = new Map<string, Set<Promise<unknown>>>();
  private readonly councilStopTasks = new Map<string, Promise<void>>();
  private readonly managedSessionCloseTasks = new Map<string, Promise<void>>();
  private readonly agentActivationCursors = new Map<string, number>();

  constructor(options: CouncilRuntimeOptions = {}) {
    this.store = options.store ?? new CouncilStore();
    this.dryRun = options.dryRun === true;
    this.eventBus = options.eventBus;
    this.startSession = options.startSession;
    this.sendInput = options.sendInput;
    this.sendStructuredInput = options.sendStructuredInput;
    this.interruptSession = options.interruptSession;
    this.closeSession = options.closeSession;
    this.hasSession = options.hasSession;
    this.delivery = new CouncilDeliveryCoordinator({
      ...(options.eventBus ? { eventBus: options.eventBus } : {}),
      sendInput: (agent, sessionId, request) => this.sendCouncilAgentInput(agent, sessionId, request),
      ...(options.isSessionBusy ? { isSessionBusy: options.isSessionBusy } : {}),
      canDeliver: (councilId, agentId, sessionId) => {
        if (this.isCouncilAgentPaused(councilId, agentId) || !this.hasManagedSession(sessionId)) {
          return false;
        }
        try {
          return councilAcceptsWrites(this.councilStateSnapshot(councilId));
        } catch {
          return false;
        }
      },
      updateStatus: (councilId, agentId, status, detail, lifecycle) => {
        this.store.setAgentStatus(councilId, agentId, status, detail);
        if (lifecycle && lifecycle !== "listening") {
          this.appendCouncilAgentStatusMessage(councilId, agentId, lifecycle);
        }
      },
      councilSnapshot: (councilId) => this.councilStateSnapshot(councilId),
    });
  }

  listCouncils(): ListCouncilsResponse {
    return {
      councils: this.store
        .listCouncils({ metadataOnly: true })
        .map((council) => this.clientCouncilSummaryFromSnapshot(
          this.projectRuntimeCouncilState(council),
        )),
    };
  }

  /**
   * Provider session identities are not guaranteed to exist in the initial
   * start response (Claude can publish one after its first lifecycle event).
   * Persist them whenever SessionStore observes the authoritative identity so
   * Council-owned provider history remains isolated after the live binding is
   * cleared or the daemon restarts.
   */
  rememberManagedSessionProviderIdentity(
    session: Pick<SessionSummary["session"], "provider" | "providerSessionId" | "origin">,
  ): void {
    const origin = session.origin;
    const providerSessionId = session.providerSessionId;
    if (origin?.kind !== "council" || !providerSessionId) {
      return;
    }
    let council: CouncilSnapshot;
    try {
      council = this.councilStateSnapshot(origin.councilId);
    } catch {
      // The Council may have been deleted while a late provider event was in
      // flight. It no longer owns a visible Council record in that case.
      return;
    }
    const agent = council.agents.find((candidate) => candidate.id === origin.agentId);
    if (
      !agent ||
      agent.provider !== session.provider ||
      agent.providerSessionIds?.includes(providerSessionId)
    ) {
      return;
    }
    this.store.updateAgent(council.id, agent.id, {
      providerSessionIds: [...new Set([
        ...(agent.providerSessionIds ?? []),
        providerSessionId,
      ])],
    });
  }

  readCouncilMessages(
    councilId: string,
    options?: { beforeMessageId?: number; limit?: number },
  ): CouncilMessagesPageResponse {
    const page = this.store.messagePage(councilId, {
      ...(options?.beforeMessageId !== undefined ? { beforeMessageId: options.beforeMessageId } : {}),
      limit: options?.limit ?? COUNCIL_CLIENT_MESSAGE_WINDOW_LIMIT,
      messageFilter: isClientVisibleCouncilMessage,
    });
    return page;
  }

  async createCouncil(request: CreateCouncilRequest): Promise<CreateCouncilResponse> {
    if (request.agents.length === 0) {
      throw new Error("Council requires at least one agent.");
    }
    const council = this.store.createCouncil({
      workspace: request.workspace,
      agents: request.agents,
      ...(request.title !== undefined ? { title: request.title } : {}),
    });
    this.store.updateCouncil(council.id, {
      status: "running",
      phase: "starting",
    });
    const startingMessage = this.store.appendMessage({
      councilId: council.id,
      actorId: "system",
      role: "system",
      text: `Council started with ${council.agents.length} agent${council.agents.length === 1 ? "" : "s"}.`,
    });
    this.publishCouncilMessage(council.id, startingMessage);
    for (const agent of council.agents) {
      this.agentActivationCursors.set(
        councilAgentDeliveryKey(council.id, agent.id),
        startingMessage.id,
      );
    }
    if (this.dryRun) {
      await this.launchAgents(council.id);
      return { council: this.clientCouncilSnapshot(council.id) };
    }
    this.scheduleCouncilAgentLaunch(council.id);
    return { council: this.clientCouncilSnapshot(council.id) };
  }

  async addAgent(councilId: string, request: AddCouncilAgentRequest): Promise<AddCouncilAgentResponse> {
    const current = this.projectRuntimeCouncilState(this.councilStateSnapshot(councilId));
    if (!councilAcceptsWrites(current)) {
      throw new Error(`Council is ${current.phase === "stopping" ? "stopping" : "stopped"} and cannot add agents.`);
    }
    const activationCursor = this.store.lastMessageId(councilId);
    const agent = this.store.addAgent(councilId, request.agent);
    try {
      await this.trackCouncilLaunch(
        councilId,
        this.launchAgent(this.councilStateSnapshot(councilId), agent, activationCursor),
      );
      const afterLaunch = this.councilStateSnapshot(councilId);
      if (councilAcceptsWrites(afterLaunch)) {
        this.store.updateCouncil(councilId, { status: "running", phase: "ready" });
      }
    } catch (error) {
      const message = errorMessage(error);
      this.store.setAgentStatus(councilId, agent.id, "failed", message);
      const failureMessage = this.store.appendMessage({
        councilId,
        actorId: "system",
        role: "system",
        text: `${agent.id} failed to start: ${message}`,
      });
      this.publishCouncilMessage(councilId, failureMessage);
    }
    const nextCouncil = this.clientCouncilSnapshot(councilId);
    return {
      council: nextCouncil,
      agent: nextCouncil.agents.find((candidate) => candidate.id === agent.id) ?? agent,
    };
  }

  postMessage(councilId: string, request: CouncilPostMessageRequest): CouncilPostMessageResponse {
    const current = this.projectRuntimeCouncilState(this.councilStateSnapshot(councilId));
    if (!councilAcceptsWrites(current)) {
      throw new Error(`Council is ${current.phase === "stopping" ? "stopping" : "stopped"} and cannot receive messages.`);
    }
    const message = this.store.appendMessage({
      councilId,
      actorId: request.actorId?.trim() || "user",
      clientId: "rah-web",
      role: request.role ?? "user",
      text: request.text,
      ...(request.replyTo !== undefined ? { replyTo: request.replyTo } : {}),
    });
    this.dispatchCouncilMessage(message);
    return {
      message,
      council: this.clientCouncilSnapshot(councilId),
    };
  }

  renameCouncil(councilId: string, title: string): CouncilSnapshot {
    const nextTitle = title.trim();
    if (!nextTitle) {
      throw new Error("Council title is required.");
    }
    this.store.updateCouncil(councilId, { title: nextTitle });
    return this.clientCouncilSnapshot(councilId);
  }

  async stopCouncil(councilId: string): Promise<void> {
    const existing = this.councilStopTasks.get(councilId);
    if (existing) {
      await existing;
      return;
    }
    const task = this.stopCouncilOnce(councilId);
    this.councilStopTasks.set(councilId, task);
    try {
      await task;
    } finally {
      if (this.councilStopTasks.get(councilId) === task) {
        this.councilStopTasks.delete(councilId);
      }
    }
  }

  private async stopCouncilOnce(councilId: string): Promise<void> {
    const current = this.councilStateSnapshot(councilId);
    if (current.status === "stopped") {
      return;
    }
    this.pendingLaunchCouncils.delete(councilId);
    this.store.beginStoppingCouncil(councilId);
    this.resolveCouncilMessageWaiters(councilId, null);
    this.clearMcpClientStates(councilId);
    this.clearPausedCouncilAgents(councilId);
    this.delivery.clearCouncil(councilId);
    this.clearAgentActivationCursors(councilId);

    const cleanupFailures: unknown[] = [];
    try {
      await this.closeCouncilAgentSessions(councilId);
    } catch (error) {
      cleanupFailures.push(error);
    }
    cleanupFailures.push(...await this.awaitCouncilLaunches(councilId));
    try {
      await this.closeCouncilAgentSessions(councilId);
    } catch (error) {
      cleanupFailures.push(error);
    }

    const remainingSessionIds = this.councilStateSnapshot(councilId).agents
      .map((agent) => agent.nativeSessionId ?? agent.terminalId)
      .filter((sessionId): sessionId is string => Boolean(sessionId));
    if (remainingSessionIds.length > 0) {
      const failureDetail = cleanupFailures.map(errorMessage).filter(Boolean).join("; ");
      const detail = `Council stop could not close managed sessions: ${remainingSessionIds.join(", ")}${
        failureDetail ? ` (${failureDetail})` : ""
      }`;
      this.store.updateCouncil(councilId, {
        status: "running",
        phase: "stopping",
        error: detail,
      });
      throw new AggregateError(cleanupFailures, detail);
    }
    this.store.stopCouncil(councilId);
  }

  async shutdown(): Promise<void> {
    const councils = this.store.listCouncils({ metadataOnly: true });
    const results = await Promise.allSettled(councils.map(async (council) => {
      this.resolveCouncilMessageWaiters(council.id, null);
      this.clearMcpClientStates(council.id);
      this.clearPausedCouncilAgents(council.id);
      if (isActiveCouncilStatus(council.status)) {
        await this.stopCouncil(council.id);
        return;
      }
      await this.closeCouncilAgentSessions(council.id);
    }));
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    try {
      await this.store.flush();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `Failed to shut down ${failures.length} Council runtime(s).`);
    }
    this.delivery.shutdown();
  }

  reconcilePersistedRuntimeState(): void {
    for (const snapshot of this.store.listCouncils({ metadataOnly: true })) {
      if (!isActiveCouncilStatus(snapshot.status)) {
        continue;
      }
      const hasLiveAgent = snapshot.agents.some((agent) => this.agentHasLiveTerminal(agent));
      if (!hasLiveAgent) {
        this.resolveCouncilMessageWaiters(snapshot.id, null);
        this.clearMcpClientStates(snapshot.id);
        this.clearPausedCouncilAgents(snapshot.id);
        this.delivery.clearCouncil(snapshot.id);
        this.clearAgentActivationCursors(snapshot.id);
        for (const agent of snapshot.agents) {
          const sessionId = agent.nativeSessionId ?? agent.terminalId;
          if (sessionId) {
            this.store.clearAgentSessionBinding(snapshot.id, agent.id, sessionId);
          }
        }
        this.store.stopCouncil(snapshot.id);
        continue;
      }
      for (const agent of snapshot.agents) {
        if (this.agentHasLiveTerminal(agent)) {
          continue;
        }
        const sessionId = agent.nativeSessionId ?? agent.terminalId;
        if (sessionId) {
          this.store.clearAgentSessionBinding(snapshot.id, agent.id, sessionId);
        }
        if (!isRecoverableCouncilAgentStatus(agent.status)) {
          continue;
        }
        this.store.updateAgent(snapshot.id, agent.id, {
          status: "stopped",
          lastStatusDetail: "terminal is not live after daemon restart",
        });
      }
    }
  }

  deleteCouncil(councilId: string): Array<{
    provider: CouncilSummary["agents"][number]["provider"];
    providerSessionId: string;
  }> {
    const projected = this.projectRuntimeCouncilState(this.councilStateSnapshot(councilId));
    if (projected.status !== "stopped") {
      throw new Error("Stop this council before deleting it.");
    }
    const providerSessions = projected.agents.flatMap((agent) =>
      (agent.providerSessionIds ?? []).map((providerSessionId) => ({
        provider: agent.provider,
        providerSessionId,
      })),
    );
    this.resolveCouncilMessageWaiters(councilId, null);
    this.clearMcpClientStates(councilId);
    this.clearPausedCouncilAgents(councilId);
    this.delivery.clearCouncil(councilId);
    this.clearAgentActivationCursors(councilId);
    this.store.deleteCouncil(councilId);
    return providerSessions;
  }

  async getAgentTui(councilId: string, agentId: string): Promise<CouncilAgentTuiResponse> {
    const snapshot = this.councilStateSnapshot(councilId);
    const agent = snapshot.agents.find((candidate) => candidate.id === agentId);
    if (!agent) {
      throw new Error(`Unknown council agent ${agentId}.`);
    }
    const terminalId = agent.nativeSessionId ?? agent.terminalId;
    if (!terminalId || this.dryRun) {
      return {
        councilId,
        agentId,
        ...(terminalId ? { terminalId, paneId: terminalId } : {}),
        screen: this.dryRun ? "[dry-run council agent TUI]" : "",
      };
    }
    if (this.hasManagedSession(terminalId)) {
      return {
        councilId,
        agentId,
        paneId: terminalId,
        terminalId,
      };
    }
    return {
      councilId,
      agentId,
      paneId: terminalId,
      screen: "This council agent terminal is not live anymore. Start a new Council to view an active terminal.",
    };
  }

  reinjectAgentPrompt(councilId: string, agentId: string): CouncilReinjectAgentsResponse {
    const wasPaused = this.isCouncilAgentPaused(councilId, agentId);
    if (wasPaused) {
      this.resumeCouncilAgent(councilId, agentId);
    }
    let injected: {
      injectedAgentIds: string[];
      skippedAgentIds: string[];
    };
    try {
      injected = this.reinjectAgentPrompts(councilId, [agentId]);
    } catch (error) {
      if (wasPaused) {
        this.pauseCouncilAgent(councilId, agentId);
      }
      throw error;
    }
    if (wasPaused && injected.skippedAgentIds.includes(agentId)) {
      this.pauseCouncilAgent(councilId, agentId);
    }
    return {
      council: this.clientCouncilSnapshot(councilId),
      injectedAgentIds: injected.injectedAgentIds,
      skippedAgentIds: injected.skippedAgentIds,
    };
  }

  removeAgentFromCouncil(councilId: string, agentId: string): CouncilRemoveAgentResponse {
    const current = this.projectRuntimeCouncilState(this.councilStateSnapshot(councilId));
    const agent = current.agents.find((candidate) => candidate.id === agentId);
    if (!agent) {
      throw new Error(`Unknown council agent ${agentId}.`);
    }
    const terminalId = agent.nativeSessionId ?? agent.terminalId;

    this.pauseCouncilAgent(councilId, agentId);
    this.cancelCouncilAgentWaiters(councilId, agentId);
    if (terminalId && this.hasManagedSession(terminalId)) {
      this.interruptSession?.(terminalId, { clientId: councilSessionClientId(councilId, agentId) });
    }
    this.store.setAgentStatus(councilId, agentId, "idle", "listening paused");
    this.appendCouncilSystemMessage({
      councilId,
      actorId: "system",
      clientId: "rah-web",
      text: `${agentId} paused council listening.`,
    });
    return { council: this.clientCouncilSnapshot(councilId) };
  }

  async stopAgentInCouncil(councilId: string, agentId: string): Promise<CouncilStopAgentResponse> {
    const current = this.projectRuntimeCouncilState(this.councilStateSnapshot(councilId));
    const agent = current.agents.find((candidate) => candidate.id === agentId);
    if (!agent) {
      throw new Error(`Unknown council agent ${agentId}.`);
    }
    this.pauseCouncilAgent(councilId, agentId);
    this.cancelCouncilAgentWaiters(councilId, agentId);
    const terminalId = agent.nativeSessionId ?? agent.terminalId;
    if (terminalId) {
      try {
        await this.closeAgentSession(terminalId);
        this.store.clearAgentSessionBinding(councilId, agentId, terminalId);
      } catch (error) {
        this.store.updateAgent(councilId, agentId, {
          status: "blocked",
          lastStatusDetail: `stop failed: ${errorMessage(error)}`,
        });
        throw error;
      }
    }
    this.delivery.unregisterAgent(councilId, agentId);
    this.store.clearAgentRuntimeState(councilId, agentId);
    this.resumeCouncilAgent(councilId, agentId);
    this.store.updateAgent(councilId, agentId, {
      status: "stopped",
      lastStatusDetail: "removed by user",
    });
    this.appendCouncilSystemMessage({
      councilId,
      actorId: "system",
      clientId: "rah-web",
      text: `${agentId} removed from council by user.`,
    });
    const afterAgentRemoval = this.councilStateSnapshot(councilId);
    const hasRemainingAgent = afterAgentRemoval.agents.some((candidate) =>
      candidate.id !== agentId &&
      candidate.status !== "stopped" &&
      candidate.status !== "failed" &&
      this.agentHasLiveTerminal(candidate)
    );
    if (!hasRemainingAgent) {
      this.resolveCouncilMessageWaiters(councilId, null);
      this.clearMcpClientStates(councilId);
      this.store.stopCouncil(councilId, "removed by user");
    }
    return { council: this.clientCouncilSnapshot(councilId) };
  }

  async callMcpTool(request: CouncilMcpRequest): Promise<CouncilMcpResponse> {
    this.markCouncilMcpReady(request.councilId, request.actorId);
    const clientId = councilMcpClientId(request);
    const projectedCouncil = this.projectRuntimeCouncilState(
      this.councilStateSnapshot(request.councilId),
    );
    if (
      !councilAcceptsWrites(projectedCouncil) &&
      !isReadOnlyCouncilMcpTool(request.tool)
    ) {
      throw new Error(
        `Council is ${projectedCouncil.phase === "stopping" ? "stopping" : "stopped"} and cannot receive MCP writes.`,
      );
    }
    const projectedAgent = projectedCouncil.agents.find((agent) => agent.id === request.actorId);
    if (
      projectedAgent &&
      (projectedAgent.status === "stopped" || projectedAgent.status === "failed") &&
      !isReadOnlyCouncilMcpTool(request.tool)
    ) {
      throw new Error(`Council agent ${request.actorId} is ${projectedAgent.status} and cannot receive MCP writes.`);
    }
    if (
      request.tool === "channel_wait_new" &&
      this.isCouncilAgentPaused(request.councilId, request.actorId)
    ) {
      return pausedCouncilMcpWaitResponse();
    }
    const effectiveRequest = this.withCouncilMcpCursor(request, clientId);
    if (request.tool === "channel_wait_new") {
      this.markCouncilWaitStarted(request.councilId, request.actorId, clientId);
      this.announceCouncilListeningOnce(request.councilId, request.actorId, clientId);
    }
    const response = await handleCouncilMcpRequest(this.store, effectiveRequest, {
      onMessage: (message) => {
        this.dispatchCouncilMessage(message);
      },
      waitNew: this.waitForCouncilMessage,
    });
    if (request.tool === "channel_state") {
      response.result = projectCouncilStateResult(response.result, projectedCouncil);
    }
    this.afterCouncilMcpResponse(effectiveRequest, clientId, response);
    if (request.tool === "channel_join") {
      this.appendCouncilSystemMessage({
        councilId: request.councilId,
        actorId: request.actorId,
        clientId,
        text: `${request.actorId} joined`,
      });
    }
    return response;
  }

  markCouncilMcpReady(councilId: string, agentId: string): void {
    const snapshot = this.councilStateSnapshot(councilId);
    if (!snapshot.agents.some((agent) => agent.id === agentId)) {
      throw new Error(`Unknown council agent ${agentId}.`);
    }
    this.delivery.markReady(councilId, agentId);
  }

  private readonly waitForCouncilMessage: CouncilMcpWaitNew = async (args) => {
    const agentIds = this.councilStateSnapshot(args.councilId).agents.map((agent) => agent.id);
    const immediate = this.store.messagesSince(args.councilId, args.sinceMessageId, {
      limit: 1,
      excludeClientId: args.clientId,
      excludeActorIdWhenClientMissing: args.actorId,
      messageFilter: (message) => isAgentDeliverableCouncilMessage(message) &&
        councilMessageTargetsAgent(message, args.actorId, agentIds),
    })[0];
    if (immediate) {
      return immediate;
    }
    return await new Promise<CouncilMcpWaitNewResult>((resolve) => {
      const waiter: CouncilMessageWaiter = {
        actorId: args.actorId,
        clientId: args.clientId,
        sinceMessageId: args.sinceMessageId,
        resolve,
        timeout: setTimeout(() => {
          const waiters = this.messageWaiters.get(args.councilId);
          waiters?.delete(waiter);
          if (waiters?.size === 0) {
            this.messageWaiters.delete(args.councilId);
          }
          resolve(null);
        }, args.timeoutMs),
      };
      let waiters = this.messageWaiters.get(args.councilId);
      if (!waiters) {
        waiters = new Set();
        this.messageWaiters.set(args.councilId, waiters);
      }
      waiters.add(waiter);
    });
  };

  private resolveCouncilMessageWaiters(
    councilId: string,
    forcedMessage: CouncilMessage | null | undefined = undefined,
    targetAgentIds: ReadonlySet<string> | null = null,
  ): Set<string> {
    const deliveredAgentIds = new Set<string>();
    const waiters = this.messageWaiters.get(councilId);
    if (!waiters) {
      return deliveredAgentIds;
    }
    for (const waiter of [...waiters]) {
      if (targetAgentIds && !targetAgentIds.has(waiter.actorId)) {
        continue;
      }
      if (forcedMessage === null) {
        clearTimeout(waiter.timeout);
        waiters.delete(waiter);
        waiter.resolve(null);
        continue;
      }
      const agentIds = this.councilStateSnapshot(councilId).agents.map((agent) => agent.id);
      const message = this.store.messagesSince(councilId, waiter.sinceMessageId, {
        limit: 1,
        excludeClientId: waiter.clientId,
        excludeActorIdWhenClientMissing: waiter.actorId,
        messageFilter: (candidate) => isAgentDeliverableCouncilMessage(candidate) &&
          councilMessageTargetsAgent(candidate, waiter.actorId, agentIds),
      })[0];
      if (!message) {
        continue;
      }
      clearTimeout(waiter.timeout);
      waiters.delete(waiter);
      waiter.resolve(message);
      deliveredAgentIds.add(waiter.actorId);
    }
    if (waiters.size === 0) {
      this.messageWaiters.delete(councilId);
    }
    return deliveredAgentIds;
  }

  private cancelCouncilAgentWaiters(councilId: string, agentId: string): boolean {
    const waiters = this.messageWaiters.get(councilId);
    if (!waiters) {
      return false;
    }
    let cancelled = false;
    for (const waiter of [...waiters]) {
      if (waiter.actorId !== agentId) {
        continue;
      }
      clearTimeout(waiter.timeout);
      waiters.delete(waiter);
      waiter.resolve({ kind: "paused" });
      cancelled = true;
    }
    if (waiters.size === 0) {
      this.messageWaiters.delete(councilId);
    }
    return cancelled;
  }

  private publishCouncilMessage(councilId: string, message: CouncilMessage): void {
    if (!isClientVisibleCouncilMessage(message)) {
      return;
    }
    this.eventBus?.publish({
      sessionId: councilId,
      type: "council.message.created",
      source: {
        provider: "system",
        channel: "system",
        authority: "authoritative",
      },
      payload: {
        council: this.clientCouncilSummary(councilId),
        message,
      },
    });
  }

  private dispatchCouncilMessage(message: CouncilMessage): void {
    this.publishCouncilMessage(message.councilId, message);
    const council = this.councilStateSnapshot(message.councilId);
    const targetAgentIds = councilMessageTargetAgentIds(
      message,
      council.agents.map((agent) => agent.id),
    );
    const hotAgentIds = this.resolveCouncilMessageWaiters(
      message.councilId,
      undefined,
      targetAgentIds,
    );
    this.delivery.routeMessage(message, hotAgentIds);
  }

  private clientCouncilSnapshot(councilId: string): CouncilSnapshot {
    return this.projectRuntimeCouncilState(
      this.store.snapshot(councilId, {
        limit: COUNCIL_CLIENT_MESSAGE_WINDOW_LIMIT,
        messageFilter: isClientVisibleCouncilMessage,
      }),
    );
  }

  private councilStateSnapshot(councilId: string): CouncilSnapshot {
    return this.store.snapshot(councilId, { metadataOnly: true });
  }

  private clientCouncilSummary(councilId: string): CouncilSummary {
    return this.clientCouncilSummaryFromSnapshot(
      this.projectRuntimeCouncilState(
        this.store.snapshot(councilId, { metadataOnly: true }),
      ),
    );
  }

  private clientCouncilSummaryFromSnapshot(snapshot: CouncilSnapshot): CouncilSummary {
    const { messages: _messages, messageWindow: _messageWindow, storage: _storage, ...summary } = snapshot;
    return summary;
  }

  private projectRuntimeCouncilState(snapshot: CouncilSnapshot): CouncilSnapshot {
    const projectedMessages = snapshot.messages.filter(isClientVisibleCouncilMessage);
    const visibleSnapshot = projectedMessages.length === snapshot.messages.length
      ? snapshot
      : { ...snapshot, messages: projectedMessages };
    if (this.dryRun || !isActiveCouncilStatus(visibleSnapshot.status)) {
      return visibleSnapshot;
    }
    if (visibleSnapshot.phase === "stopping") {
      return visibleSnapshot;
    }
    if (visibleSnapshot.phase === "starting" && this.pendingLaunchCouncils.has(visibleSnapshot.id)) {
      const projectedStartingAgents = visibleSnapshot.agents.map((agent) => {
        const terminalId = agent.nativeSessionId ?? agent.terminalId;
        if (!terminalId || !isActiveCouncilAgentStatus(agent.status) || this.agentHasLiveTerminal(agent)) {
          return agent;
        }
        return {
          ...agent,
          status: "stopped" as const,
        };
      });
      return { ...visibleSnapshot, agents: projectedStartingAgents };
    }
    const projectedAgents = visibleSnapshot.agents.map((agent) => {
      if (!isActiveCouncilAgentStatus(agent.status) || this.agentHasLiveTerminal(agent)) {
        return agent;
      }
      return {
        ...agent,
        status: "stopped" as const,
      };
    });
    if (projectedAgents.some((agent) => this.agentHasLiveTerminal(agent))) {
      return {
        ...visibleSnapshot,
        phase: deriveRunningCouncilPhase(projectedAgents),
        agents: projectedAgents,
      };
    }
    return {
      ...visibleSnapshot,
      status: "stopped",
      phase: "ended",
      agents: projectedAgents,
    };
  }

  private agentHasLiveTerminal(agent: CouncilSnapshot["agents"][number]): boolean {
    const terminalId = agent.nativeSessionId ?? agent.terminalId;
    return Boolean(terminalId && this.hasManagedSession(terminalId));
  }

  private hasManagedSession(sessionId: string): boolean {
    return this.hasSession?.(sessionId) === true;
  }

  private withCouncilMcpCursor(request: CouncilMcpRequest, clientId: string): CouncilMcpRequest {
    if (request.tool !== "channel_wait_new" && request.tool !== "channel_peek_inbox") {
      return request;
    }
    if (request.arguments?.since_id !== undefined || request.arguments?.sinceMessageId !== undefined) {
      return request;
    }
    const state = this.mcpClientState(
      request.councilId,
      clientId,
      this.delivery.deliveryCursor(request.councilId, request.actorId),
    );
    return {
      ...request,
      arguments: {
        ...(request.arguments ?? {}),
        since_id: state.lastSeenMessageId,
      },
    };
  }

  private afterCouncilMcpResponse(
    request: CouncilMcpRequest,
    clientId: string,
    response: CouncilMcpResponse,
  ): void {
    const state = this.mcpClientState(
      request.councilId,
      clientId,
      this.delivery.deliveryCursor(request.councilId, request.actorId),
    );
    if (request.tool === "channel_join") {
      const result = response.result as { last_msg_id?: unknown };
      if (typeof result.last_msg_id === "number") {
        state.lastSeenMessageId = Math.max(state.lastSeenMessageId, result.last_msg_id);
      }
      state.listeningAnnounced = false;
      return;
    }
    if (request.tool === "channel_wait_new") {
      const result = response.result as {
        msg?: { id?: unknown };
        timed_out?: unknown;
        sleeping?: unknown;
      };
      if (typeof result.msg?.id === "number") {
        state.lastSeenMessageId = Math.max(state.lastSeenMessageId, result.msg.id);
        this.delivery.acknowledgeHotMessage(request.councilId, request.actorId, result.msg.id);
      } else if (result.timed_out === true || result.sleeping === true) {
        if (!this.delivery.markSleeping(request.councilId, request.actorId)) {
          this.store.setAgentStatus(request.councilId, request.actorId, "idle", "sleeping · subscribed");
        }
      }
      return;
    }
    if (request.tool === "channel_peek_inbox") {
      const result = response.result as { messages?: Array<{ id?: unknown }> };
      const maxId = (Array.isArray(result.messages) ? result.messages : [])
        .reduce((max, message) => typeof message.id === "number" ? Math.max(max, message.id) : max, state.lastSeenMessageId);
      state.lastSeenMessageId = Math.max(state.lastSeenMessageId, maxId);
    }
  }

  private announceCouncilListeningOnce(councilId: string, actorId: string, clientId: string): void {
    const state = this.mcpClientState(
      councilId,
      clientId,
      this.delivery.deliveryCursor(councilId, actorId),
    );
    if (state.listeningAnnounced) {
      return;
    }
    state.listeningAnnounced = true;
    this.appendCouncilSystemMessage({
      councilId,
      actorId,
      clientId,
      text: `${actorId} listening`,
    });
  }

  private markCouncilWaitStarted(councilId: string, actorId: string, clientId: string): void {
    this.mcpClientState(
      councilId,
      clientId,
      this.delivery.deliveryCursor(councilId, actorId),
    );
    if (!this.delivery.markHotListening(councilId, actorId)) {
      this.store.setAgentStatus(councilId, actorId, "waiting", "hot · listening");
    }
  }

  private requestCouncilRecoveryWake(councilId: string, agentId: string, detail: string): CouncilRecoveryWakeResult {
    const snapshot = this.councilStateSnapshot(councilId);
    const agent = snapshot.agents.find((candidate) => candidate.id === agentId);
    const terminalId = agent?.nativeSessionId ?? agent?.terminalId;
    if (!agent || !terminalId) {
      return "skipped";
    }
    if (this.hasActiveCouncilWaiter(councilId, agentId)) {
      return "skipped";
    }
    if (!this.hasManagedSession(terminalId)) {
      return "skipped";
    }
    const accepted = this.delivery.requestRecovery(councilId, agentId);
    if (!accepted) {
      return "skipped";
    }
    this.store.setAgentStatus(councilId, agentId, "starting", `${detail} · queued`);
    return "queued";
  }

  private appendCouncilAgentStatusMessage(
    councilId: string,
    agentId: string,
    status: "sent" | "joined" | "listening" | CouncilDeliveryLifecycle,
  ): void {
    this.appendCouncilSystemMessage({
      councilId,
      actorId: agentId,
      clientId: "rah-runtime",
      text: `${agentId} ${status}`,
    });
  }

  private appendCouncilSystemMessage(args: {
    councilId: string;
    actorId: string;
    clientId: string;
    text: string;
  }): void {
    const message = this.store.appendMessage({
      councilId: args.councilId,
      actorId: args.actorId,
      clientId: args.clientId,
      role: "system",
      text: args.text,
    });
    this.publishCouncilMessage(args.councilId, message);
  }

  private mcpClientState(
    councilId: string,
    clientId: string,
    initialCursor?: number,
  ): CouncilMcpClientState {
    const key = councilMcpClientKey(councilId, clientId);
    let state = this.mcpClientStates.get(key);
    if (!state) {
      state = {
        lastSeenMessageId: initialCursor ?? this.store.lastMessageId(councilId),
        listeningAnnounced: false,
      };
      this.mcpClientStates.set(key, state);
    }
    return state;
  }

  private clearMcpClientStates(councilId: string): void {
    for (const key of [...this.mcpClientStates.keys()]) {
      if (key.startsWith(`${councilId}:`)) {
        this.mcpClientStates.delete(key);
      }
    }
  }

  private takeAgentActivationCursor(councilId: string, agentId: string): number {
    const key = councilAgentDeliveryKey(councilId, agentId);
    const cursor = this.agentActivationCursors.get(key) ?? this.store.lastMessageId(councilId);
    this.agentActivationCursors.delete(key);
    return cursor;
  }

  private clearAgentActivationCursors(councilId: string): void {
    const prefix = `${councilId}:`;
    for (const key of [...this.agentActivationCursors.keys()]) {
      if (key.startsWith(prefix)) {
        this.agentActivationCursors.delete(key);
      }
    }
  }

  private pauseCouncilAgent(councilId: string, agentId: string): void {
    let agentIds = this.pausedCouncilAgents.get(councilId);
    if (!agentIds) {
      agentIds = new Set();
      this.pausedCouncilAgents.set(councilId, agentIds);
    }
    agentIds.add(agentId);
    this.delivery.pauseAgent(councilId, agentId);
  }

  private resumeCouncilAgent(councilId: string, agentId: string): void {
    const agentIds = this.pausedCouncilAgents.get(councilId);
    if (!agentIds) {
      return;
    }
    agentIds.delete(agentId);
    if (agentIds.size === 0) {
      this.pausedCouncilAgents.delete(councilId);
    }
    this.delivery.resumeAgent(councilId, agentId);
  }

  private isCouncilAgentPaused(councilId: string, agentId: string): boolean {
    return this.pausedCouncilAgents.get(councilId)?.has(agentId) === true;
  }

  private clearPausedCouncilAgents(councilId: string): void {
    this.pausedCouncilAgents.delete(councilId);
  }

  private trackCouncilLaunch<T>(councilId: string, task: Promise<T>): Promise<T> {
    let tasks = this.councilLaunchTasks.get(councilId);
    if (!tasks) {
      tasks = new Set();
      this.councilLaunchTasks.set(councilId, tasks);
    }
    let tracked!: Promise<T>;
    tracked = task.finally(() => {
      const current = this.councilLaunchTasks.get(councilId);
      current?.delete(tracked);
      if (current?.size === 0) {
        this.councilLaunchTasks.delete(councilId);
      }
    });
    tasks.add(tracked);
    return tracked;
  }

  private async awaitCouncilLaunches(councilId: string): Promise<unknown[]> {
    const failures: unknown[] = [];
    while (true) {
      const tasks = [...(this.councilLaunchTasks.get(councilId) ?? [])];
      if (tasks.length === 0) {
        return failures;
      }
      const results = await Promise.allSettled(tasks);
      failures.push(...results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      ));
    }
  }

  private scheduleCouncilAgentLaunch(councilId: string): void {
    this.pendingLaunchCouncils.add(councilId);
    const launchTask = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        void this.launchAgents(councilId)
          .catch((error) => {
            const message = errorMessage(error);
            try {
              const snapshot = this.councilStateSnapshot(councilId);
              if (snapshot.phase === "stopping") {
                console.error("[rah] council launch cleanup failed while stopping", {
                  councilId,
                  error: message,
                });
                return;
              }
              this.store.failCouncil(councilId, message);
              this.appendCouncilSystemMessage({
                councilId,
                actorId: "system",
                clientId: "rah-runtime",
                text: `Council failed to start: ${message}`,
              });
            } catch {
              // The council may have been deleted while background launch was pending.
            }
          })
          .finally(() => {
            this.pendingLaunchCouncils.delete(councilId);
            resolve();
          });
      }, 0);
      timer.unref?.();
    });
    void this.trackCouncilLaunch(councilId, launchTask);
  }

  private async launchAgents(councilId: string): Promise<void> {
    let initial: CouncilSnapshot;
    try {
      initial = this.councilStateSnapshot(councilId);
    } catch {
      return;
    }
    for (const agent of initial.agents) {
      if (!this.shouldContinueLaunchingCouncil(councilId)) {
        return;
      }
      try {
        await this.launchAgent(
          this.councilStateSnapshot(councilId),
          agent,
          this.takeAgentActivationCursor(councilId, agent.id),
        );
      } catch (error) {
        const current = this.councilStateSnapshot(councilId).agents.find((candidate) => candidate.id === agent.id);
        const terminalId = current?.nativeSessionId ?? current?.terminalId;
        if (terminalId) {
          try {
            await this.closeAgentSession(terminalId);
            this.store.clearAgentSessionBinding(councilId, agent.id, terminalId);
          } catch (closeError) {
            const detail = `launch failed: ${errorMessage(error)}; cleanup failed: ${errorMessage(closeError)}`;
            this.store.updateAgent(councilId, agent.id, {
              status: "blocked",
              lastStatusDetail: detail,
            });
            this.appendCouncilSystemMessage({
              councilId,
              actorId: "system",
              clientId: "rah-runtime",
              text: `${agent.id} failed to start and its managed session could not be closed: ${errorMessage(closeError)}`,
            });
            continue;
          }
        }
        const message = errorMessage(error);
        this.store.updateAgent(councilId, agent.id, {
          status: "failed",
          lastStatusDetail: message,
        });
        this.appendCouncilSystemMessage({
          councilId,
          actorId: "system",
          clientId: "rah-runtime",
          text: `${agent.id} failed to start: ${message}`,
        });
      }
    }
    this.completeCouncilLaunch(councilId);
  }

  private shouldContinueLaunchingCouncil(councilId: string): boolean {
    try {
      const snapshot = this.councilStateSnapshot(councilId);
      return snapshot.status === "running" && snapshot.phase !== "stopping";
    } catch {
      return false;
    }
  }

  private completeCouncilLaunch(councilId: string): void {
    let snapshot: CouncilSnapshot;
    try {
      snapshot = this.councilStateSnapshot(councilId);
    } catch {
      return;
    }
    if (!isActiveCouncilStatus(snapshot.status) || snapshot.phase === "stopping") {
      return;
    }
    const hasViableAgent = snapshot.agents.some((agent) => (
      agent.status !== "failed" &&
      agent.status !== "stopped" &&
      (this.dryRun || this.agentHasLiveTerminal(agent) || Boolean(agent.nativeSessionId ?? agent.terminalId))
    ));
    if (hasViableAgent) {
      this.store.updateCouncil(councilId, { status: "running", phase: "ready" });
      return;
    }
    const message = "All council agents failed to start.";
    this.store.failCouncil(councilId, message);
    this.appendCouncilSystemMessage({
      councilId,
      actorId: "system",
      clientId: "rah-runtime",
      text: `Council failed to start: ${message}`,
    });
  }

  private async launchAgent(
    council: CouncilSnapshot,
    agent: CouncilSnapshot["agents"][number],
    activationCursor = this.store.lastMessageId(council.id),
  ): Promise<void> {
    await this.launchManagedAgent(council, agent, activationCursor);
  }

  private async launchManagedAgent(
    council: CouncilSnapshot,
    agent: CouncilSnapshot["agents"][number],
    activationCursor: number,
  ): Promise<void> {
    const liveBackend = isNativeLocalServerProvider(agent.provider) ? "native_local_server" : "tui_mux";
    if (this.dryRun) {
      const terminalId = councilAgentTerminalId(council.id, agent.id);
      this.store.updateAgent(council.id, agent.id, {
        status: "idle",
        nativeSessionId: terminalId,
        lastStatusDetail: "sleeping · subscribed",
      });
      return;
    }
    if (!this.startSession || !this.sendInput) {
      throw new Error("Council managed session runner is not configured.");
    }
    if (!this.shouldContinueLaunchingCouncil(council.id)) {
      return;
    }
    this.delivery.prepareAgent(council.id, agent.id);
    const session = await this.startSession({
      provider: agent.provider,
      cwd: council.workspace,
      liveBackend,
      title: `Council ${agent.label}`,
      origin: {
        kind: "council",
        councilId: council.id,
        councilTitle: council.title,
        agentId: agent.id,
        agentLabel: agent.label,
      },
      ...(agent.modelId ? { model: agent.modelId } : {}),
      ...(agent.optionValues !== undefined ? { optionValues: agent.optionValues } : {}),
      ...(agent.modeId ? { modeId: agent.modeId } : {}),
      extraMcpServers: [councilMcpServerSpec(council.id, agent.id)],
      attach: {
        client: {
          id: councilSessionClientId(council.id, agent.id),
          kind: "api",
          connectionId: councilSessionClientId(council.id, agent.id),
        },
        mode: "interactive",
        claimControl: true,
      },
    });
    const sessionId = session.session.session.id;
    const providerSessionId = session.session.session.providerSessionId;
    this.store.updateAgent(council.id, agent.id, {
      status: "starting",
      nativeSessionId: sessionId,
      ...(providerSessionId
        ? {
            providerSessionIds: [...new Set([
              ...(agent.providerSessionIds ?? []),
              providerSessionId,
            ])],
          }
        : {}),
      lastStatusDetail: "managed session started",
    });
    if (!this.shouldContinueLaunchingCouncil(council.id)) {
      await this.closeAgentSession(sessionId);
      this.store.clearAgentSessionBinding(council.id, agent.id, sessionId);
      return;
    }
    if (!this.shouldContinueLaunchingCouncil(council.id)) {
      await this.closeAgentSession(sessionId);
      this.store.clearAgentSessionBinding(council.id, agent.id, sessionId);
      return;
    }
    const launchedAgent = this.councilStateSnapshot(council.id).agents.find(
      (candidate) => candidate.id === agent.id,
    ) ?? agent;
    this.delivery.registerAgent({
      councilId: council.id,
      agent: launchedAgent,
      sessionId,
      ready: agent.provider !== "claude",
      cursor: activationCursor,
      backlog: this.store.messagesSince(council.id, activationCursor, {
        limit: 50,
        excludeActorIdWhenClientMissing: agent.id,
        messageFilter: isAgentDeliverableCouncilMessage,
      }),
    });
  }

  private sendCouncilAgentInput(
    agent: CouncilSnapshot["agents"][number],
    sessionId: string,
    request: SessionInputRequest,
  ): void {
    const sender = isNativeLocalServerProvider(agent.provider)
      ? this.sendStructuredInput
      : this.sendInput;
    if (!sender) {
      throw new Error(
        `Council ${agent.provider} input routing is unavailable for ${sessionId}.`,
      );
    }
    sender(sessionId, request);
  }

  private async closeCouncilAgentSessions(councilId: string): Promise<void> {
    const snapshot = this.councilStateSnapshot(councilId);
    const agentsBySession = new Map<string, string[]>();
    for (const agent of snapshot.agents) {
      const terminalId = agent.nativeSessionId ?? agent.terminalId;
      if (!terminalId) continue;
      const agentIds = agentsBySession.get(terminalId) ?? [];
      agentIds.push(agent.id);
      agentsBySession.set(terminalId, agentIds);
    }
    const results = await Promise.allSettled(
      [...agentsBySession].map(async ([terminalId, agentIds]) => {
        await this.closeAgentSession(terminalId);
        for (const agentId of agentIds) {
          this.store.clearAgentSessionBinding(councilId, agentId, terminalId);
        }
      }),
    );
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length > 0) {
      throw new AggregateError(failures, `Failed to close ${failures.length} Council managed session(s).`);
    }
  }

  private async closeAgentSession(terminalId: string): Promise<void> {
    const existing = this.managedSessionCloseTasks.get(terminalId);
    if (existing) {
      await existing;
      return;
    }
    const task = this.closeAgentSessionOnce(terminalId);
    this.managedSessionCloseTasks.set(terminalId, task);
    try {
      await task;
    } finally {
      if (this.managedSessionCloseTasks.get(terminalId) === task) {
        this.managedSessionCloseTasks.delete(terminalId);
      }
    }
  }

  private async closeAgentSessionOnce(terminalId: string): Promise<void> {
    if (this.dryRun || this.hasSession?.(terminalId) === false) {
      return;
    }
    if (!this.closeSession) {
      throw new Error(`Council managed session close is unavailable for ${terminalId}.`);
    }
    await this.closeSession(terminalId);
    if (this.hasSession?.(terminalId) === true) {
      throw new Error(`Council managed session ${terminalId} is still live after close completed.`);
    }
  }

  private reinjectAgentPrompts(councilId: string, agentIds: string[]): {
    injectedAgentIds: string[];
    skippedAgentIds: string[];
  } {
    const snapshot = this.councilStateSnapshot(councilId);
    const injectedAgentIds: string[] = [];
    const skippedAgentIds: string[] = [];
    for (const agentId of agentIds) {
      const agent = snapshot.agents.find((candidate) => candidate.id === agentId);
      const result = agent
        ? this.requestCouncilRecoveryWake(councilId, agentId, "recovery wake requested")
        : "skipped";
      if (result === "skipped") {
        skippedAgentIds.push(agentId);
        continue;
      }
      this.appendCouncilSystemMessage({
        councilId,
        actorId: "system",
        clientId: "rah-web",
        text: `recovery wake requested for ${agentId}.`,
      });
      injectedAgentIds.push(agentId);
    }
    return { injectedAgentIds, skippedAgentIds };
  }

  private hasActiveCouncilWaiter(councilId: string, agentId: string): boolean {
    const waiters = this.messageWaiters.get(councilId);
    if (!waiters) {
      return false;
    }
    return [...waiters].some((waiter) => waiter.actorId === agentId);
  }

}

function councilAgentTerminalId(councilId: string, agentId: string): string {
  return `council:${councilId}:${Buffer.from(agentId, "utf8").toString("base64url")}`;
}

function councilSessionClientId(councilId: string, agentId: string): string {
  return `rah-council:${councilId}:${agentId}`;
}

function isActiveCouncilStatus(status: CouncilSnapshot["status"]): boolean {
  return status === "running";
}

function councilAcceptsWrites(council: Pick<CouncilSnapshot, "status" | "phase">): boolean {
  return council.status === "running" && council.phase !== "stopping";
}

function deriveRunningCouncilPhase(agents: CouncilSnapshot["agents"]): CouncilSnapshot["phase"] {
  if (agents.some((agent) => agent.status === "starting")) {
    return "starting";
  }
  if (agents.some((agent) => agent.status === "thinking")) {
    return "working";
  }
  if (agents.some((agent) => agent.status === "blocked")) {
    return "waiting_permission";
  }
  return "ready";
}

function isActiveCouncilAgentStatus(status: CouncilSnapshot["agents"][number]["status"]): boolean {
  return status === "starting" || status === "waiting" || status === "thinking" || status === "idle";
}

function isRecoverableCouncilAgentStatus(status: CouncilSnapshot["agents"][number]["status"]): boolean {
  return isActiveCouncilAgentStatus(status) || status === "blocked";
}

function isReadOnlyCouncilMcpTool(tool: CouncilMcpRequest["tool"]): boolean {
  return tool === "channel_history" || tool === "channel_state" || tool === "channel_list_claims";
}


function projectCouncilStateResult(result: unknown, council: CouncilSnapshot): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return result;
  }
  return {
    ...result,
    council,
    agents: council.agents,
    active_agents: council.agents.map((agent) => ({
      actor: agent.id,
      actorId: agent.id,
      status: agent.status,
      ...(agent.lastStatusDetail ? { detail: agent.lastStatusDetail } : {}),
    })),
  };
}

function councilMcpServerSpec(councilId: string, actorId: string) {
  const rahBin = process.env.RAH_BIN_PATH ??
    fileURLToPath(new URL("../../../../bin/rah.mjs", import.meta.url));
  return {
    name: "rah_council",
    command: process.execPath,
    args: [
      rahBin,
      "council-mcp",
      "--council",
      councilId,
      "--actor",
      actorId,
      "--daemon-url",
      process.env.RAH_COUNCIL_MCP_DAEMON_URL ?? process.env.RAH_DAEMON_URL ?? DEFAULT_DAEMON_URL,
    ],
  };
}

function councilMcpClientId(request: CouncilMcpRequest): string {
  const argsClientId = typeof request.arguments?.client_id === "string"
    ? request.arguments.client_id.trim()
    : "";
  return request.clientId?.trim() || argsClientId || `actor:${request.actorId}`;
}

function councilMcpClientKey(councilId: string, clientId: string): string {
  return `${councilId}:${clientId}`;
}

function councilAgentDeliveryKey(councilId: string, agentId: string): string {
  return `${councilId}:${agentId}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
