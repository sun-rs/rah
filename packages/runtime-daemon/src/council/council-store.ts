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
  Council,
  CouncilSnapshot,
} from "@rah/runtime-protocol";
import { conversationStateFromLegacyCouncilStatus } from "@rah/runtime-protocol";

type CouncilStoreFile = {
  councils: Council[];
  agents: CouncilAgent[];
  messages: CouncilMessage[];
  claims: CouncilFileClaim[];
  controls: CouncilControlMessage[];
  nextMessageId: number;
  nextControlId: number;
};

export type CouncilFileClaim = {
  councilId: string;
  path: string;
  actorId: string;
  claimedAt: string;
};

export type CouncilControlMessage = {
  id: number;
  councilId: string;
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
  return path.join(resolveRahHome(), "council", "councils.json");
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

function nextDefaultCouncilTitle(councils: Council[]): string {
  let maxCouncilNumber = 0;
  for (const council of councils) {
    const match = /^Council-(\d+)$/.exec(council.title.trim());
    if (!match) continue;
    maxCouncilNumber = Math.max(maxCouncilNumber, Number.parseInt(match[1]!, 10));
  }
  return `Council-${String(maxCouncilNumber + 1).padStart(4, "0")}`;
}

function loadStoreFile(filePath: string): CouncilStoreFile {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<CouncilStoreFile>;
    const councils = Array.isArray(parsed.councils)
      ? (parsed.councils as Council[]).map(normalizePersistedCouncil)
      : [];
    return {
      councils,
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
      councils: [],
      agents: [],
      messages: [],
      claims: [],
      controls: [],
      nextMessageId: 1,
      nextControlId: 1,
    };
  }
}

function normalizePersistedCouncil(council: Council): Council {
  const rawStatus = (council as { status?: string }).status;
  const rawPhase = (council as { phase?: Council["phase"] }).phase;
  if (rawStatus === "running" || rawStatus === "stopped") {
    return {
      ...council,
      status: rawStatus,
      phase: rawPhase ?? (rawStatus === "running" ? "ready" : "ended"),
    };
  }
  const legacy = conversationStateFromLegacyCouncilStatus(rawStatus);
  return {
    ...council,
    status: legacy.status,
    phase: rawPhase ?? legacy.phase,
  };
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

function councilMessageFilePath(filePath: string, councilId: string): string {
  return path.join(councilMessagesDir(filePath), `${encodeURIComponent(councilId)}.jsonl`);
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
        typeof parsed.councilId === "string" &&
        typeof parsed.actorId === "string" &&
        Array.isArray(parsed.parts)
      ) {
        messages.push(parsed);
      }
    } catch {
      // Keep the council usable even if a single log line is corrupted.
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
  private readonly messagesByCouncil = new Map<string, CouncilMessage[]>();

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

  listCouncils(): CouncilSnapshot[] {
    return [...this.state.councils]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((council) => this.snapshot(council.id));
  }

  createCouncil(args: {
    title?: string;
    workspace: string;
    agents: CouncilAgentConfig[];
    muxSessionName?: string;
  }): CouncilSnapshot {
    const timestamp = nowIso();
    const councilId = randomUUID();
    const council: Council = {
      id: councilId,
      title: args.title?.trim() || nextDefaultCouncilTitle(this.state.councils),
      workspace: args.workspace,
      status: "running",
      phase: "starting",
      ...(args.muxSessionName ? { muxSessionName: args.muxSessionName } : {}),
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
        councilId,
        label: id,
        status: "starting",
        updatedAt: timestamp,
      };
    });
    this.state.councils.push(council);
    this.state.agents.push(...agents);
    this.persist();
    return this.snapshot(councilId);
  }

  addAgent(councilId: string, agent: CouncilAgentConfig): CouncilAgent {
    const council = this.requireCouncil(councilId);
    const timestamp = nowIso();
    const existingAgents = this.state.agents.filter((candidate) => candidate.councilId === councilId);
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
      councilId,
      label: id,
      status: "starting",
      updatedAt: timestamp,
    };
    this.state.agents.push(nextAgent);
    council.updatedAt = timestamp;
    this.persist();
    return { ...nextAgent };
  }

  snapshot(councilId: string, options?: { sinceMessageId?: number; limit?: number }): CouncilSnapshot {
    const council = this.requireCouncil(councilId);
    const since = options?.sinceMessageId ?? 0;
    const limit = options?.limit;
    const councilMessages = this.messagesForCouncil(councilId);
    const startIndex = firstMessageIndexAfter(councilMessages, since);
    const messages =
      limit === undefined
        ? councilMessages.slice(startIndex)
        : limit <= 0
          ? []
          : councilMessages.slice(startIndex).slice(-limit);
    return {
      ...council,
      agents: this.state.agents
        .filter((agent) => agent.councilId === councilId)
        .map((agent) => ({ ...agent })),
      messages: messages.map(cloneCouncilMessage),
      storage: {
        storePath: this.filePath,
        messageLogPath: this.messageFilePath(councilId),
      },
    };
  }

  appendMessage(args: {
    councilId: string;
    actorId: string;
    clientId?: string;
    role: CouncilMessageRole;
    text: string;
    replyTo?: number;
  }): CouncilMessage {
    const council = this.requireCouncil(args.councilId);
    const trimmed = args.text.trim();
    if (!trimmed) {
      throw new Error("Council message text is required.");
    }
    const timestamp = nowIso();
    const message: CouncilMessage = {
      id: this.state.nextMessageId,
      councilId: council.id,
      actorId: args.actorId,
      ...(args.clientId ? { clientId: args.clientId } : {}),
      role: args.role,
      parts: [textPart(args.text)],
      ...(args.replyTo !== undefined ? { replyTo: args.replyTo } : {}),
      createdAt: timestamp,
    };
    this.state.nextMessageId += 1;
    this.messagesForCouncil(message.councilId).push(message);
    this.appendMessageToLog(message);
    council.updatedAt = timestamp;
    this.persist();
    return cloneCouncilMessage(message);
  }

  lastMessageId(councilId: string): number {
    this.requireCouncil(councilId);
    return this.messagesForCouncil(councilId).at(-1)?.id ?? 0;
  }

  recentMessages(councilId: string, limit = 50): CouncilMessage[] {
    this.requireCouncil(councilId);
    if (limit <= 0) {
      return [];
    }
    return this.messagesForCouncil(councilId).slice(-limit).map(cloneCouncilMessage);
  }

  messagesSince(
    councilId: string,
    sinceMessageId: number,
    options?: {
      limit?: number;
      excludeClientId?: string;
      excludeActorIdWhenClientMissing?: string;
    },
  ): CouncilMessage[] {
    this.requireCouncil(councilId);
    const limit = options?.limit ?? 50;
    if (limit <= 0) {
      return [];
    }
    const councilMessages = this.messagesForCouncil(councilId);
    const startIndex = firstMessageIndexAfter(councilMessages, sinceMessageId);
    const results: CouncilMessage[] = [];
    for (let index = startIndex; index < councilMessages.length; index += 1) {
      const message = councilMessages[index]!;
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

  updateCouncil(
    councilId: string,
    patch: Partial<Pick<Council, "title" | "status" | "phase" | "muxSessionName" | "error">>,
  ): CouncilSnapshot {
    const council = this.requireCouncil(councilId);
    Object.assign(council, patch, { updatedAt: nowIso() });
    this.persist();
    return this.snapshot(councilId);
  }

  failCouncil(councilId: string, error: string): CouncilSnapshot {
    const timestamp = nowIso();
    const council = this.requireCouncil(councilId);
    council.status = "stopped";
    council.phase = "failed";
    council.error = error;
    council.updatedAt = timestamp;
    for (const agent of this.state.agents.filter((candidate) => candidate.councilId === councilId)) {
      if (agent.status !== "stopped") {
        agent.status = "failed";
        agent.lastStatusDetail = error;
        agent.updatedAt = timestamp;
      }
    }
    this.persist();
    return this.snapshot(councilId);
  }

  updateAgent(
    councilId: string,
    agentId: string,
    patch: Partial<Pick<CouncilAgent, "status" | "terminalId" | "nativeSessionId" | "lastStatusDetail">>,
  ): CouncilSnapshot {
    const agent = this.requireAgent(councilId, agentId);
    Object.assign(agent, patch, { updatedAt: nowIso() });
    this.requireCouncil(councilId).updatedAt = agent.updatedAt;
    this.persist();
    return this.snapshot(councilId);
  }

  setAgentStatus(councilId: string, agentId: string, status: CouncilAgentStatus, detail?: string): CouncilSnapshot {
    return this.updateAgent(councilId, agentId, {
      status,
      ...(detail !== undefined ? { lastStatusDetail: detail } : {}),
    });
  }

  clearAgentRuntimeState(councilId: string, agentId: string): CouncilSnapshot {
    this.requireAgent(councilId, agentId);
    this.state.claims = this.state.claims.filter(
      (claim) => !(claim.councilId === councilId && claim.actorId === agentId),
    );
    this.state.controls = this.state.controls.filter(
      (control) => !(
        control.councilId === councilId &&
        (control.fromActorId === agentId || control.targetActorId === agentId)
      ),
    );
    this.persist();
    return this.snapshot(councilId);
  }

  councilState(councilId: string): {
    council: Council;
    agents: CouncilAgent[];
    lastMessageId: number;
    claims: CouncilFileClaim[];
    controls: CouncilControlMessage[];
  } {
    const snapshot = this.snapshot(councilId, { limit: 0 });
    const { agents, messages, storage, ...council } = snapshot;
    this.pruneExpiredClaims(councilId);
    return {
      council,
      agents,
      lastMessageId: this.lastMessageId(councilId),
      claims: this.listClaims(councilId),
      controls: this.state.controls
        .filter((control) => control.councilId === councilId)
        .map((control) => ({ ...control })),
    };
  }

  claimFile(councilId: string, actorId: string, filePath: string): CouncilFileClaim {
    this.requireAgent(councilId, actorId);
    const normalizedPath = filePath.trim();
    if (!normalizedPath) {
      throw new Error("channel_claim_file requires path.");
    }
    this.pruneExpiredClaims(councilId);
    const existing = this.state.claims.find(
      (claim) => claim.councilId === councilId && claim.path === normalizedPath,
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
      councilId,
      path: normalizedPath,
      actorId,
      claimedAt: timestamp,
    };
    this.state.claims.push(claim);
    this.persist();
    return { ...claim };
  }

  releaseFile(councilId: string, actorId: string, filePath: string): boolean {
    this.requireAgent(councilId, actorId);
    const normalizedPath = filePath.trim();
    const before = this.state.claims.length;
    this.state.claims = this.state.claims.filter(
      (claim) => !(claim.councilId === councilId && claim.path === normalizedPath && claim.actorId === actorId),
    );
    if (this.state.claims.length !== before) {
      this.persist();
      return true;
    }
    return false;
  }

  listClaims(councilId: string): CouncilFileClaim[] {
    this.requireCouncil(councilId);
    this.pruneExpiredClaims(councilId);
    return this.state.claims
      .filter((claim) => claim.councilId === councilId)
      .map((claim) => ({ ...claim }));
  }

  appendControl(args: {
    councilId: string;
    fromActorId: string;
    targetActorId: string;
    action: string;
    taskId?: string;
    data?: unknown;
  }): CouncilControlMessage {
    this.requireAgent(args.councilId, args.fromActorId);
    this.requireAgent(args.councilId, args.targetActorId);
    const action = args.action.trim();
    if (!action) {
      throw new Error("channel_send_control requires action.");
    }
    const control: CouncilControlMessage = {
      id: this.state.nextControlId,
      councilId: args.councilId,
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

  takeControls(councilId: string, actorId: string): CouncilControlMessage[] {
    this.requireAgent(councilId, actorId);
    const controls = this.state.controls
      .filter((control) => control.councilId === councilId && control.targetActorId === actorId)
      .map((control) => ({ ...control }));
    if (controls.length === 0) {
      return [];
    }
    const ids = new Set(controls.map((control) => control.id));
    this.state.controls = this.state.controls.filter((control) => !ids.has(control.id));
    this.persist();
    return controls;
  }

  stopCouncil(councilId: string): CouncilSnapshot {
    const timestamp = nowIso();
    const council = this.requireCouncil(councilId);
    council.status = "stopped";
    council.phase = "ended";
    council.updatedAt = timestamp;
    for (const agent of this.state.agents.filter((candidate) => candidate.councilId === councilId)) {
      agent.status = "stopped";
      agent.updatedAt = timestamp;
    }
    this.state.claims = this.state.claims.filter((claim) => claim.councilId !== councilId);
    this.state.controls = this.state.controls.filter((control) => control.councilId !== councilId);
    this.persist();
    return this.snapshot(councilId);
  }

  deleteCouncil(councilId: string): void {
    this.requireCouncil(councilId);
    this.state.councils = this.state.councils.filter((council) => council.id !== councilId);
    this.state.agents = this.state.agents.filter((agent) => agent.councilId !== councilId);
    this.messagesByCouncil.delete(councilId);
    rmSync(this.messageFilePath(councilId), { force: true });
    this.state.claims = this.state.claims.filter((claim) => claim.councilId !== councilId);
    this.state.controls = this.state.controls.filter((control) => control.councilId !== councilId);
    this.persist();
  }

  requireAgent(councilId: string, agentId: string): CouncilAgent {
    const agent = this.state.agents.find(
      (candidate) => candidate.councilId === councilId && candidate.id === agentId,
    );
    if (!agent) {
      throw new Error(`Unknown council agent ${agentId}.`);
    }
    return agent;
  }

  private requireCouncil(councilId: string): Council {
    const council = this.state.councils.find((candidate) => candidate.id === councilId);
    if (!council) {
      throw new Error(`Unknown council ${councilId}.`);
    }
    return council;
  }

  private pruneExpiredClaims(councilId: string): void {
    const now = Date.now();
    const before = this.state.claims.length;
    this.state.claims = this.state.claims.filter((claim) => {
      if (claim.councilId !== councilId) {
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

  private messagesForCouncil(councilId: string): CouncilMessage[] {
    let messages = this.messagesByCouncil.get(councilId);
    if (!messages) {
      messages = [];
      this.messagesByCouncil.set(councilId, messages);
    }
    return messages;
  }

  private messageFilePath(councilId: string): string {
    return councilMessageFilePath(this.filePath, councilId);
  }

  private loadMessageLogs(legacyMessages: CouncilMessage[]): void {
    const knownCouncilIds = new Set(this.state.councils.map((council) => council.id));
    for (const council of this.state.councils) {
      const messages = readCouncilMessageLog(this.messageFilePath(council.id));
      if (messages.length > 0) {
        this.messagesByCouncil.set(council.id, messages);
      }
    }
    for (const message of legacyMessages) {
      if (!knownCouncilIds.has(message.councilId)) {
        continue;
      }
      upsertMessageById(this.messagesForCouncil(message.councilId), message);
    }
    for (const [councilId, messages] of this.messagesByCouncil) {
      if (!knownCouncilIds.has(councilId)) {
        this.messagesByCouncil.delete(councilId);
        continue;
      }
      messages.sort((a, b) => a.id - b.id);
    }
  }

  private writeAllMessageLogs(): void {
    mkdirSync(councilMessagesDir(this.filePath), { recursive: true });
    for (const [councilId, messages] of this.messagesByCouncil) {
      const tmpPath = `${this.messageFilePath(councilId)}.${process.pid}.${Date.now()}.tmp`;
      const body = messages.map((message) => JSON.stringify(message)).join("\n");
      writeFileSync(tmpPath, body ? `${body}\n` : "", "utf8");
      renameSync(tmpPath, this.messageFilePath(councilId));
    }
  }

  private appendMessageToLog(message: CouncilMessage): void {
    mkdirSync(councilMessagesDir(this.filePath), { recursive: true });
    appendFileSync(this.messageFilePath(message.councilId), `${JSON.stringify(message)}\n`, "utf8");
  }

  private maxMessageId(): number {
    let max = 0;
    for (const messages of this.messagesByCouncil.values()) {
      max = Math.max(max, messages.at(-1)?.id ?? 0);
    }
    return max;
  }
}
