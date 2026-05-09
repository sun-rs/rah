import type {
  CouncilMessage,
  CouncilAgentTuiResponse,
  CouncilMcpRequest,
  CouncilMcpResponse,
  CouncilPostMessageRequest,
  CouncilPostMessageResponse,
  CouncilRoomSnapshot,
  CreateCouncilRoomRequest,
  CreateCouncilRoomResponse,
  ListCouncilRoomsResponse,
} from "@rah/runtime-protocol";
import { fileURLToPath } from "node:url";
import type { MuxRuntime } from "../mux-runtime";
import { nativeTuiStartLaunchSpec } from "../native-tui-launch-spec";
import {
  createZellijSessionNameForRahSession,
  ZellijCommandError,
  ZellijMuxBackend,
} from "../zellij-mux-backend";
import type { EventBus } from "../event-bus";
import { CouncilStore } from "./council-store";
import { handleCouncilMcpRequest } from "./council-mcp-shim";

const DEFAULT_DAEMON_URL = "http://127.0.0.1:43111";

export type CouncilRuntimeOptions = {
  store?: CouncilStore;
  mux?: MuxRuntime;
  dryRun?: boolean;
  eventBus?: EventBus;
};

export class CouncilRuntime {
  readonly store: CouncilStore;
  private readonly mux: MuxRuntime;
  private readonly dryRun: boolean;
  private readonly eventBus: EventBus | undefined;

  constructor(options: CouncilRuntimeOptions = {}) {
    this.store = options.store ?? new CouncilStore();
    this.mux = options.mux ?? new ZellijMuxBackend();
    this.dryRun = options.dryRun === true;
    this.eventBus = options.eventBus;
  }

  listRooms(): ListCouncilRoomsResponse {
    return { rooms: this.store.listRooms() };
  }

  async createRoom(request: CreateCouncilRoomRequest): Promise<CreateCouncilRoomResponse> {
    if (request.agents.length === 0) {
      throw new Error("Council requires at least one agent.");
    }
    const room = this.store.createRoom({
      workspace: request.workspace,
      agents: request.agents,
      ...(request.title !== undefined ? { title: request.title } : {}),
    });
    const zellijSessionName = createZellijSessionNameForRahSession(room.room.id, "rah-council");
    this.store.updateRoom(room.room.id, {
      zellijSessionName,
      status: "starting",
    });
    try {
      await this.launchAgents(this.store.snapshot(room.room.id), zellijSessionName);
      const started = this.store.updateRoom(room.room.id, { status: "running" });
      const message = this.store.appendMessage({
        roomId: room.room.id,
        actorId: "system",
        role: "system",
        text: `Council started with ${started.agents.length} agent${started.agents.length === 1 ? "" : "s"}.`,
      });
      this.publishCouncilMessage(room.room.id, message);
      return { room: this.store.snapshot(room.room.id) };
    } catch (error) {
      const message = errorMessage(error);
      if (!this.dryRun) {
        await this.mux.killSession(zellijSessionName).catch(() => undefined);
      }
      this.store.failRoom(room.room.id, message);
      const failureMessage = this.store.appendMessage({
        roomId: room.room.id,
        actorId: "system",
        role: "system",
        text: `Council failed to start: ${message}`,
      });
      this.publishCouncilMessage(room.room.id, failureMessage);
      return { room: this.store.snapshot(room.room.id) };
    }
  }

  postMessage(roomId: string, request: CouncilPostMessageRequest): CouncilPostMessageResponse {
    const message = this.store.appendMessage({
      roomId,
      actorId: request.actorId?.trim() || "user",
      role: request.role ?? "user",
      text: request.text,
      ...(request.replyTo !== undefined ? { replyTo: request.replyTo } : {}),
    });
    this.publishCouncilMessage(roomId, message);
    return {
      message,
      room: this.store.snapshot(roomId),
    };
  }

  async archiveRoom(roomId: string): Promise<void> {
    const room = this.store.snapshot(roomId).room;
    if (room.zellijSessionName) {
      try {
        await this.mux.killSession(room.zellijSessionName);
      } catch (error) {
        if (!isZellijSessionMissingError(error)) {
          const message = `Failed to archive council zellij session: ${errorMessage(error)}`;
          this.store.failRoom(roomId, message);
          throw new Error(message);
        }
      }
    }
    this.store.stopRoom(roomId);
  }

  async getAgentTui(roomId: string, agentId: string): Promise<CouncilAgentTuiResponse> {
    const snapshot = this.store.snapshot(roomId);
    const agent = snapshot.agents.find((candidate) => candidate.id === agentId);
    if (!agent) {
      throw new Error(`Unknown council agent ${agentId}.`);
    }
    if (!snapshot.room.zellijSessionName || !agent.zellijPaneId || this.dryRun) {
      return {
        roomId,
        agentId,
        ...(snapshot.room.zellijSessionName ? { zellijSessionName: snapshot.room.zellijSessionName } : {}),
        ...(agent.zellijPaneId ? { paneId: agent.zellijPaneId } : {}),
        screen: this.dryRun ? "[dry-run council agent TUI]" : "",
      };
    }
    return {
      roomId,
      agentId,
      zellijSessionName: snapshot.room.zellijSessionName,
      paneId: agent.zellijPaneId,
      screen: await this.mux.dumpScreen(snapshot.room.zellijSessionName, agent.zellijPaneId, {
        ansi: true,
        full: true,
      }),
    };
  }

  callMcpTool(request: CouncilMcpRequest): CouncilMcpResponse {
    const response = handleCouncilMcpRequest(this.store, request);
    if (request.tool === "channel_post" && isCouncilMessage(response.result)) {
      this.publishCouncilMessage(request.roomId, response.result);
    }
    return response;
  }

  private publishCouncilMessage(roomId: string, message: CouncilMessage): void {
    this.eventBus?.publish({
      sessionId: roomId,
      type: "council.message.created",
      source: {
        provider: "system",
        channel: "system",
        authority: "authoritative",
      },
      payload: {
        room: this.store.snapshot(roomId),
        message,
      },
    });
  }

  private async launchAgents(room: CouncilRoomSnapshot, zellijSessionName: string): Promise<void> {
    let replaceDefaultPane = true;
    for (const agent of room.agents) {
      const launch = await nativeTuiStartLaunchSpec({
        provider: agent.provider,
        cwd: room.room.workspace,
        ...(agent.modelId ? { model: agent.modelId } : {}),
        ...(typeof agent.reasoningId === "string" ? { reasoningId: agent.reasoningId } : {}),
        ...(agent.optionValues !== undefined ? { optionValues: agent.optionValues } : {}),
        ...(agent.modeId ? { modeId: agent.modeId } : {}),
        extraMcpServers: [councilMcpServerSpec(room.room.id, agent.id)],
        initialPrompt: councilBootstrapPrompt(room, agent.id),
        title: `Council ${agent.label}`,
      });
      if (this.dryRun) {
        this.store.updateAgent(room.room.id, agent.id, {
          status: "idle",
          zellijPaneId: `dry-run-${agent.id}`,
        });
        continue;
      }
      const created = await this.mux.createProviderPane({
        sessionName: zellijSessionName,
        cwd: launch.cwd,
        command: launch.command,
        args: launch.args,
        env: {
          ...(launch.env ?? {}),
          RAH_COUNCIL_ROOM_ID: room.room.id,
          RAH_COUNCIL_ACTOR_ID: agent.id,
          RAH_COUNCIL_ACTOR_LABEL: agent.label,
        },
        title: agent.id,
        replaceDefaultPane,
      });
      replaceDefaultPane = false;
      this.store.updateAgent(room.room.id, agent.id, {
        status: "starting",
        zellijPaneId: created.paneId,
      });
    }
  }
}

function councilMcpServerSpec(roomId: string, actorId: string) {
  const rahBin = process.env.RAH_BIN_PATH ??
    fileURLToPath(new URL("../../../../bin/rah.mjs", import.meta.url));
  return {
    name: "rah_council",
    command: process.execPath,
    args: [
      rahBin,
      "council-mcp",
      "--room",
      roomId,
      "--actor",
      actorId,
      "--daemon-url",
      process.env.RAH_COUNCIL_MCP_DAEMON_URL ?? process.env.RAH_DAEMON_URL ?? DEFAULT_DAEMON_URL,
    ],
  };
}

function councilBootstrapPrompt(room: CouncilRoomSnapshot, actorId: string): string {
  const agent = room.agents.find((candidate) => candidate.id === actorId);
  const role = agent?.role?.trim();
  return [
    `You are ${agent?.label ?? actorId} in RAH Council room "${room.room.title}".`,
    role ? `Your role: ${role}.` : null,
    "Use the rah_council MCP tools to coordinate:",
    "- call channel_join first;",
    "- use channel_history/channel_wait_new to read messages;",
    "- use channel_post to send concise messages back to the shared room;",
    "- use channel_set_status when waiting, thinking, blocked, or idle.",
    "Do not treat the terminal transcript as the council chat source of truth; the shared room log is authoritative.",
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function isCouncilMessage(value: unknown): value is CouncilMessage {
  return Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { id?: unknown }).id === "number" &&
    typeof (value as { roomId?: unknown }).roomId === "string" &&
    typeof (value as { actorId?: unknown }).actorId === "string";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isZellijSessionMissingError(error: unknown): boolean {
  if (!(error instanceof ZellijCommandError)) {
    return false;
  }
  const detail = `${error.stdout}\n${error.stderr}\n${error.message}`;
  return /No session named|Session '[^']+' not found|There is no active session|session may have exited/i.test(detail);
}
