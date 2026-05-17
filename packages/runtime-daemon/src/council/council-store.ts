import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  claims: CouncilFileClaim[];
  controls: CouncilControlMessage[];
  nextMessageId: number;
  nextControlId: number;
};

export type CouncilFileClaim = {
  roomId: string;
  path: string;
  actorId: string;
  claimedAt: string;
};

export type CouncilControlMessage = {
  id: number;
  roomId: string;
  fromActorId: string;
  targetActorId: string;
  action: string;
  taskId?: string;
  data?: unknown;
  createdAt: string;
};

const CLAIM_TTL_MS = 10 * 60 * 1000;

function resolveRahHome(): string {
  return process.env.RAH_HOME ?? path.join(os.homedir(), ".rah");
}

function defaultStoreFilePath(): string {
  return path.join(resolveRahHome(), "council", "rooms.json");
}

function nowIso(): string {
  return new Date().toISOString();
}

function councilActorName(agent: CouncilAgentConfig, index: number): string {
  return normalizeCouncilActorName(agent.label.trim() || agent.id?.trim() || `Agent ${index + 1}`);
}

function normalizeCouncilActorName(value: string): string {
  return value.replace(/[\\/]+/g, "-");
}

function nextDefaultRoomTitle(rooms: CouncilRoom[]): string {
  let maxRoomNumber = 0;
  for (const room of rooms) {
    const match = /^Room-(\d+)$/.exec(room.title.trim());
    if (!match) continue;
    maxRoomNumber = Math.max(maxRoomNumber, Number.parseInt(match[1]!, 10));
  }
  return `Room-${String(maxRoomNumber + 1).padStart(4, "0")}`;
}

function loadStoreFile(filePath: string): CouncilStoreFile {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<CouncilStoreFile>;
    return {
      rooms: Array.isArray(parsed.rooms) ? parsed.rooms as CouncilRoom[] : [],
      agents: Array.isArray(parsed.agents) ? parsed.agents as CouncilAgent[] : [],
      messages: Array.isArray(parsed.messages) ? parsed.messages as CouncilMessage[] : [],
      claims: Array.isArray(parsed.claims) ? parsed.claims as CouncilFileClaim[] : [],
      controls: Array.isArray(parsed.controls) ? parsed.controls as CouncilControlMessage[] : [],
      nextMessageId:
        typeof parsed.nextMessageId === "number" && Number.isInteger(parsed.nextMessageId)
          ? parsed.nextMessageId
          : 1,
      nextControlId:
        typeof parsed.nextControlId === "number" && Number.isInteger(parsed.nextControlId)
          ? parsed.nextControlId
          : 1,
    };
  } catch {
    return {
      rooms: [],
      agents: [],
      messages: [],
      claims: [],
      controls: [],
      nextMessageId: 1,
      nextControlId: 1,
    };
  }
}

function textPart(text: string): CouncilMessagePart {
  return { kind: "text", text };
}

function cloneCouncilMessage(message: CouncilMessage): CouncilMessage {
  return { ...message, parts: [...message.parts] };
}

function councilMessagesDir(filePath: string): string {
  return path.join(path.dirname(filePath), "messages");
}

function councilMessageFilePath(filePath: string, roomId: string): string {
  return path.join(councilMessagesDir(filePath), `${encodeURIComponent(roomId)}.jsonl`);
}

function readCouncilMessageLog(filePath: string): CouncilMessage[] {
  if (!existsSync(filePath)) {
    return [];
  }
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  const messages: CouncilMessage[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as CouncilMessage;
      if (
        typeof parsed.id === "number" &&
        typeof parsed.roomId === "string" &&
        typeof parsed.actorId === "string" &&
        Array.isArray(parsed.parts)
      ) {
        messages.push(parsed);
      }
    } catch {
      // Keep the room usable even if a single log line is corrupted.
    }
  }
  return messages;
}

function upsertMessageById(messages: CouncilMessage[], message: CouncilMessage): void {
  const existingIndex = messages.findIndex((candidate) => candidate.id === message.id);
  if (existingIndex >= 0) {
    messages[existingIndex] = message;
    return;
  }
  messages.push(message);
}

function firstMessageIndexAfter(messages: CouncilMessage[], messageId: number): number {
  let low = 0;
  let high = messages.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (messages[mid]!.id <= messageId) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

export class CouncilStore {
  private state: CouncilStoreFile;
  private readonly messagesByRoom = new Map<string, CouncilMessage[]>();

  constructor(private readonly filePath = defaultStoreFilePath()) {
    this.state = loadStoreFile(filePath);
    const legacyMessages = this.state.messages;
    this.state.messages = [];
    this.loadMessageLogs(legacyMessages);
    this.state.nextMessageId = Math.max(this.state.nextMessageId, this.maxMessageId() + 1);
    if (legacyMessages.length > 0) {
      this.writeAllMessageLogs();
      this.persist();
    }
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
      title: args.title?.trim() || nextDefaultRoomTitle(this.state.rooms),
      workspace: args.workspace,
      status: "starting",
      ...(args.zellijSessionName ? { zellijSessionName: args.zellijSessionName } : {}),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const usedAgentIds = new Set<string>();
    const agents = args.agents.map((agent, index): CouncilAgent => {
      const baseId = councilActorName(agent, index);
      let id = baseId;
      let suffix = 2;
      while (usedAgentIds.has(id)) {
        id = `${baseId} ${suffix}`;
        suffix += 1;
      }
      usedAgentIds.add(id);
      return {
        ...agent,
        id,
        roomId,
        label: id,
        status: "starting",
        updatedAt: timestamp,
      };
    });
    this.state.rooms.push(room);
    this.state.agents.push(...agents);
    this.persist();
    return this.snapshot(roomId);
  }

  addAgent(roomId: string, agent: CouncilAgentConfig): CouncilAgent {
    const room = this.requireRoom(roomId);
    const timestamp = nowIso();
    const existingAgents = this.state.agents.filter((candidate) => candidate.roomId === roomId);
    const usedAgentIds = new Set(existingAgents.map((candidate) => candidate.id));
    const baseId = councilActorName(agent, existingAgents.length);
    let id = baseId;
    let suffix = 2;
    while (usedAgentIds.has(id)) {
      id = `${baseId} ${suffix}`;
      suffix += 1;
    }
    const nextAgent: CouncilAgent = {
      ...agent,
      id,
      roomId,
      label: id,
      status: "starting",
      updatedAt: timestamp,
    };
    this.state.agents.push(nextAgent);
    room.updatedAt = timestamp;
    this.persist();
    return { ...nextAgent };
  }

  snapshot(roomId: string, options?: { sinceMessageId?: number; limit?: number }): CouncilRoomSnapshot {
    const room = this.requireRoom(roomId);
    const since = options?.sinceMessageId ?? 0;
    const limit = options?.limit ?? 200;
    const roomMessages = this.messagesForRoom(roomId);
    const startIndex = firstMessageIndexAfter(roomMessages, since);
    const messages = limit <= 0 ? [] : roomMessages.slice(startIndex).slice(-limit);
    return {
      room: { ...room },
      agents: this.state.agents
        .filter((agent) => agent.roomId === roomId)
        .map((agent) => ({ ...agent })),
      messages: messages.map(cloneCouncilMessage),
      storage: {
        storePath: this.filePath,
        messageLogPath: this.messageFilePath(roomId),
      },
    };
  }

  appendMessage(args: {
    roomId: string;
    actorId: string;
    clientId?: string;
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
      ...(args.clientId ? { clientId: args.clientId } : {}),
      role: args.role,
      parts: [textPart(args.text)],
      ...(args.replyTo !== undefined ? { replyTo: args.replyTo } : {}),
      createdAt: timestamp,
    };
    this.state.nextMessageId += 1;
    this.messagesForRoom(message.roomId).push(message);
    this.appendMessageToLog(message);
    room.updatedAt = timestamp;
    this.persist();
    return cloneCouncilMessage(message);
  }

  lastMessageId(roomId: string): number {
    this.requireRoom(roomId);
    return this.messagesForRoom(roomId).at(-1)?.id ?? 0;
  }

  recentMessages(roomId: string, limit = 50): CouncilMessage[] {
    this.requireRoom(roomId);
    if (limit <= 0) {
      return [];
    }
    return this.messagesForRoom(roomId).slice(-limit).map(cloneCouncilMessage);
  }

  messagesSince(
    roomId: string,
    sinceMessageId: number,
    options?: {
      limit?: number;
      excludeClientId?: string;
      excludeActorIdWhenClientMissing?: string;
    },
  ): CouncilMessage[] {
    this.requireRoom(roomId);
    const limit = options?.limit ?? 50;
    if (limit <= 0) {
      return [];
    }
    const roomMessages = this.messagesForRoom(roomId);
    const startIndex = firstMessageIndexAfter(roomMessages, sinceMessageId);
    const results: CouncilMessage[] = [];
    for (let index = startIndex; index < roomMessages.length; index += 1) {
      const message = roomMessages[index]!;
      if (options?.excludeClientId && message.clientId === options.excludeClientId) {
        continue;
      }
      if (
        options?.excludeActorIdWhenClientMissing &&
        !message.clientId &&
        message.actorId === options.excludeActorIdWhenClientMissing
      ) {
        continue;
      }
      results.push(cloneCouncilMessage(message));
      if (results.length >= limit) {
        break;
      }
    }
    return results;
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

  clearAgentRuntimeState(roomId: string, agentId: string): CouncilRoomSnapshot {
    this.requireAgent(roomId, agentId);
    this.state.claims = this.state.claims.filter(
      (claim) => !(claim.roomId === roomId && claim.actorId === agentId),
    );
    this.state.controls = this.state.controls.filter(
      (control) => !(
        control.roomId === roomId &&
        (control.fromActorId === agentId || control.targetActorId === agentId)
      ),
    );
    this.persist();
    return this.snapshot(roomId);
  }

  roomState(roomId: string): {
    room: CouncilRoom;
    agents: CouncilAgent[];
    lastMessageId: number;
    claims: CouncilFileClaim[];
    controls: CouncilControlMessage[];
  } {
    const snapshot = this.snapshot(roomId, { limit: 0 });
    this.pruneExpiredClaims(roomId);
    return {
      room: snapshot.room,
      agents: snapshot.agents,
      lastMessageId: this.lastMessageId(roomId),
      claims: this.listClaims(roomId),
      controls: this.state.controls
        .filter((control) => control.roomId === roomId)
        .map((control) => ({ ...control })),
    };
  }

  claimFile(roomId: string, actorId: string, filePath: string): CouncilFileClaim {
    this.requireAgent(roomId, actorId);
    const normalizedPath = filePath.trim();
    if (!normalizedPath) {
      throw new Error("channel_claim_file requires path.");
    }
    this.pruneExpiredClaims(roomId);
    const existing = this.state.claims.find(
      (claim) => claim.roomId === roomId && claim.path === normalizedPath,
    );
    if (existing && existing.actorId !== actorId) {
      throw new Error(`file_conflict: ${normalizedPath} is already claimed by ${existing.actorId}.`);
    }
    const timestamp = nowIso();
    if (existing) {
      existing.claimedAt = timestamp;
      this.persist();
      return { ...existing };
    }
    const claim: CouncilFileClaim = {
      roomId,
      path: normalizedPath,
      actorId,
      claimedAt: timestamp,
    };
    this.state.claims.push(claim);
    this.persist();
    return { ...claim };
  }

  releaseFile(roomId: string, actorId: string, filePath: string): boolean {
    this.requireAgent(roomId, actorId);
    const normalizedPath = filePath.trim();
    const before = this.state.claims.length;
    this.state.claims = this.state.claims.filter(
      (claim) => !(claim.roomId === roomId && claim.path === normalizedPath && claim.actorId === actorId),
    );
    if (this.state.claims.length !== before) {
      this.persist();
      return true;
    }
    return false;
  }

  listClaims(roomId: string): CouncilFileClaim[] {
    this.requireRoom(roomId);
    this.pruneExpiredClaims(roomId);
    return this.state.claims
      .filter((claim) => claim.roomId === roomId)
      .map((claim) => ({ ...claim }));
  }

  appendControl(args: {
    roomId: string;
    fromActorId: string;
    targetActorId: string;
    action: string;
    taskId?: string;
    data?: unknown;
  }): CouncilControlMessage {
    this.requireAgent(args.roomId, args.fromActorId);
    this.requireAgent(args.roomId, args.targetActorId);
    const action = args.action.trim();
    if (!action) {
      throw new Error("channel_send_control requires action.");
    }
    const control: CouncilControlMessage = {
      id: this.state.nextControlId,
      roomId: args.roomId,
      fromActorId: args.fromActorId,
      targetActorId: args.targetActorId,
      action,
      ...(args.taskId ? { taskId: args.taskId } : {}),
      ...(args.data !== undefined ? { data: args.data } : {}),
      createdAt: nowIso(),
    };
    this.state.nextControlId += 1;
    this.state.controls.push(control);
    this.persist();
    return { ...control };
  }

  takeControls(roomId: string, actorId: string): CouncilControlMessage[] {
    this.requireAgent(roomId, actorId);
    const controls = this.state.controls
      .filter((control) => control.roomId === roomId && control.targetActorId === actorId)
      .map((control) => ({ ...control }));
    if (controls.length === 0) {
      return [];
    }
    const ids = new Set(controls.map((control) => control.id));
    this.state.controls = this.state.controls.filter((control) => !ids.has(control.id));
    this.persist();
    return controls;
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
    this.state.claims = this.state.claims.filter((claim) => claim.roomId !== roomId);
    this.state.controls = this.state.controls.filter((control) => control.roomId !== roomId);
    this.persist();
    return this.snapshot(roomId);
  }

  deleteRoom(roomId: string): void {
    this.requireRoom(roomId);
    this.state.rooms = this.state.rooms.filter((room) => room.id !== roomId);
    this.state.agents = this.state.agents.filter((agent) => agent.roomId !== roomId);
    this.messagesByRoom.delete(roomId);
    rmSync(this.messageFilePath(roomId), { force: true });
    this.state.claims = this.state.claims.filter((claim) => claim.roomId !== roomId);
    this.state.controls = this.state.controls.filter((control) => control.roomId !== roomId);
    this.persist();
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

  private pruneExpiredClaims(roomId: string): void {
    const now = Date.now();
    const before = this.state.claims.length;
    this.state.claims = this.state.claims.filter((claim) => {
      if (claim.roomId !== roomId) {
        return true;
      }
      const claimedAt = Date.parse(claim.claimedAt);
      return Number.isFinite(claimedAt) && now - claimedAt <= CLAIM_TTL_MS;
    });
    if (this.state.claims.length !== before) {
      this.persist();
    }
  }

  private persist(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify({ ...this.state, messages: [] }, null, 2)}\n`, "utf8");
    renameSync(tmpPath, this.filePath);
  }

  private messagesForRoom(roomId: string): CouncilMessage[] {
    let messages = this.messagesByRoom.get(roomId);
    if (!messages) {
      messages = [];
      this.messagesByRoom.set(roomId, messages);
    }
    return messages;
  }

  private messageFilePath(roomId: string): string {
    return councilMessageFilePath(this.filePath, roomId);
  }

  private loadMessageLogs(legacyMessages: CouncilMessage[]): void {
    const knownRoomIds = new Set(this.state.rooms.map((room) => room.id));
    for (const room of this.state.rooms) {
      const messages = readCouncilMessageLog(this.messageFilePath(room.id));
      if (messages.length > 0) {
        this.messagesByRoom.set(room.id, messages);
      }
    }
    for (const message of legacyMessages) {
      if (!knownRoomIds.has(message.roomId)) {
        continue;
      }
      upsertMessageById(this.messagesForRoom(message.roomId), message);
    }
    for (const [roomId, messages] of this.messagesByRoom) {
      if (!knownRoomIds.has(roomId)) {
        this.messagesByRoom.delete(roomId);
        continue;
      }
      messages.sort((a, b) => a.id - b.id);
    }
  }

  private writeAllMessageLogs(): void {
    mkdirSync(councilMessagesDir(this.filePath), { recursive: true });
    for (const [roomId, messages] of this.messagesByRoom) {
      const tmpPath = `${this.messageFilePath(roomId)}.${process.pid}.${Date.now()}.tmp`;
      const body = messages.map((message) => JSON.stringify(message)).join("\n");
      writeFileSync(tmpPath, body ? `${body}\n` : "", "utf8");
      renameSync(tmpPath, this.messageFilePath(roomId));
    }
  }

  private appendMessageToLog(message: CouncilMessage): void {
    mkdirSync(councilMessagesDir(this.filePath), { recursive: true });
    appendFileSync(this.messageFilePath(message.roomId), `${JSON.stringify(message)}\n`, "utf8");
  }

  private maxMessageId(): number {
    let max = 0;
    for (const messages of this.messagesByRoom.values()) {
      max = Math.max(max, messages.at(-1)?.id ?? 0);
    }
    return max;
  }
}
