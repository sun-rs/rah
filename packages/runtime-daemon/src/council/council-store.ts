import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  CouncilAgent,
  CouncilAgentConfig,
  CouncilAgentStatus,
  CouncilMessage,
  CouncilMessagePart,
  CouncilMessageRole,
  CouncilRoom,
  CouncilRoomSnapshot,
  CouncilRoomStatus,
} from "@rah/runtime-protocol";

type CouncilStoreFile = {
  rooms: CouncilRoom[];
  agents: CouncilAgent[];
  messages: CouncilMessage[];
  nextMessageId: number;
};

function resolveRahHome(): string {
  return process.env.RAH_HOME ?? path.join(os.homedir(), ".rah");
}

function defaultStoreFilePath(): string {
  return path.join(resolveRahHome(), "council", "rooms.json");
}

function nowIso(): string {
  return new Date().toISOString();
}

function slugActorId(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || `agent-${randomUUID().slice(0, 8)}`;
}

function loadStoreFile(filePath: string): CouncilStoreFile {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<CouncilStoreFile>;
    return {
      rooms: Array.isArray(parsed.rooms) ? parsed.rooms as CouncilRoom[] : [],
      agents: Array.isArray(parsed.agents) ? parsed.agents as CouncilAgent[] : [],
      messages: Array.isArray(parsed.messages) ? parsed.messages as CouncilMessage[] : [],
      nextMessageId:
        typeof parsed.nextMessageId === "number" && Number.isInteger(parsed.nextMessageId)
          ? parsed.nextMessageId
          : 1,
    };
  } catch {
    return {
      rooms: [],
      agents: [],
      messages: [],
      nextMessageId: 1,
    };
  }
}

function textPart(text: string): CouncilMessagePart {
  return { kind: "text", text };
}

export class CouncilStore {
  private state: CouncilStoreFile;

  constructor(private readonly filePath = defaultStoreFilePath()) {
    this.state = loadStoreFile(filePath);
  }

  listRooms(): CouncilRoomSnapshot[] {
    return [...this.state.rooms]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((room) => this.snapshot(room.id));
  }

  createRoom(args: {
    title?: string;
    workspace: string;
    agents: CouncilAgentConfig[];
    zellijSessionName?: string;
  }): CouncilRoomSnapshot {
    const timestamp = nowIso();
    const roomId = randomUUID();
    const room: CouncilRoom = {
      id: roomId,
      title: args.title?.trim() || "Council",
      workspace: args.workspace,
      status: "starting",
      ...(args.zellijSessionName ? { zellijSessionName: args.zellijSessionName } : {}),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const usedAgentIds = new Set<string>();
    const agents = args.agents.map((agent, index): CouncilAgent => {
      const baseId = slugActorId(agent.id ?? agent.label ?? `agent-${index + 1}`);
      let id = baseId;
      let suffix = 2;
      while (usedAgentIds.has(id)) {
        id = `${baseId}-${suffix}`;
        suffix += 1;
      }
      usedAgentIds.add(id);
      return {
        ...agent,
        id,
        roomId,
        label: agent.label.trim() || id,
        status: "starting",
        updatedAt: timestamp,
      };
    });
    this.state.rooms.push(room);
    this.state.agents.push(...agents);
    this.persist();
    return this.snapshot(roomId);
  }

  snapshot(roomId: string, options?: { sinceMessageId?: number; limit?: number }): CouncilRoomSnapshot {
    const room = this.requireRoom(roomId);
    const since = options?.sinceMessageId ?? 0;
    const limit = options?.limit ?? 200;
    const messages = this.state.messages
      .filter((message) => message.roomId === roomId && message.id > since)
      .sort((a, b) => a.id - b.id)
      .slice(-limit);
    return {
      room: { ...room },
      agents: this.state.agents
        .filter((agent) => agent.roomId === roomId)
        .map((agent) => ({ ...agent })),
      messages: messages.map((message) => ({ ...message, parts: [...message.parts] })),
    };
  }

  appendMessage(args: {
    roomId: string;
    actorId: string;
    role: CouncilMessageRole;
    text: string;
    replyTo?: number;
  }): CouncilMessage {
    const room = this.requireRoom(args.roomId);
    const trimmed = args.text.trim();
    if (!trimmed) {
      throw new Error("Council message text is required.");
    }
    const timestamp = nowIso();
    const message: CouncilMessage = {
      id: this.state.nextMessageId,
      roomId: room.id,
      actorId: args.actorId,
      role: args.role,
      parts: [textPart(args.text)],
      ...(args.replyTo !== undefined ? { replyTo: args.replyTo } : {}),
      createdAt: timestamp,
    };
    this.state.nextMessageId += 1;
    this.state.messages.push(message);
    room.updatedAt = timestamp;
    this.persist();
    return { ...message, parts: [...message.parts] };
  }

  updateRoom(roomId: string, patch: Partial<Pick<CouncilRoom, "status" | "zellijSessionName" | "error">>): CouncilRoomSnapshot {
    const room = this.requireRoom(roomId);
    Object.assign(room, patch, { updatedAt: nowIso() });
    this.persist();
    return this.snapshot(roomId);
  }

  failRoom(roomId: string, error: string): CouncilRoomSnapshot {
    const timestamp = nowIso();
    const room = this.requireRoom(roomId);
    room.status = "failed";
    room.error = error;
    room.updatedAt = timestamp;
    for (const agent of this.state.agents.filter((candidate) => candidate.roomId === roomId)) {
      if (agent.status !== "stopped") {
        agent.status = "failed";
        agent.lastStatusDetail = error;
        agent.updatedAt = timestamp;
      }
    }
    this.persist();
    return this.snapshot(roomId);
  }

  updateAgent(
    roomId: string,
    agentId: string,
    patch: Partial<Pick<CouncilAgent, "status" | "zellijPaneId" | "nativeSessionId" | "lastStatusDetail">>,
  ): CouncilRoomSnapshot {
    const agent = this.requireAgent(roomId, agentId);
    Object.assign(agent, patch, { updatedAt: nowIso() });
    this.requireRoom(roomId).updatedAt = agent.updatedAt;
    this.persist();
    return this.snapshot(roomId);
  }

  setAgentStatus(roomId: string, agentId: string, status: CouncilAgentStatus, detail?: string): CouncilRoomSnapshot {
    return this.updateAgent(roomId, agentId, {
      status,
      ...(detail !== undefined ? { lastStatusDetail: detail } : {}),
    });
  }

  stopRoom(roomId: string): CouncilRoomSnapshot {
    const timestamp = nowIso();
    const room = this.requireRoom(roomId);
    room.status = "stopped";
    room.updatedAt = timestamp;
    for (const agent of this.state.agents.filter((candidate) => candidate.roomId === roomId)) {
      agent.status = "stopped";
      agent.updatedAt = timestamp;
    }
    this.persist();
    return this.snapshot(roomId);
  }

  requireAgent(roomId: string, agentId: string): CouncilAgent {
    const agent = this.state.agents.find(
      (candidate) => candidate.roomId === roomId && candidate.id === agentId,
    );
    if (!agent) {
      throw new Error(`Unknown council agent ${agentId}.`);
    }
    return agent;
  }

  private requireRoom(roomId: string): CouncilRoom {
    const room = this.state.rooms.find((candidate) => candidate.id === roomId);
    if (!room) {
      throw new Error(`Unknown council room ${roomId}.`);
    }
    return room;
  }

  private persist(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
    renameSync(tmpPath, this.filePath);
  }
}
