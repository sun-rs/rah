import { randomUUID } from "node:crypto";
import {
  closeSync,
  createWriteStream,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import {
  mkdir as mkdirAsync,
  open as openAsync,
  rename as renameAsync,
  rm as rmAsync,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type {
  CouncilAgent,
  CouncilAgentConfig,
  CouncilAgentStatus,
  CouncilMeta,
  CouncilMessageSummary,
  CouncilMessage,
  CouncilMessagePart,
  CouncilMessageRole,
  Council,
  CouncilSnapshot,
  CouncilMessagesPageResponse,
} from "@rah/runtime-protocol";
import { conversationStateFromLegacyCouncilStatus } from "@rah/runtime-protocol";
import { streamJsonChunks } from "../json-response-stream";
import { isClientVisibleCouncilMessage } from "./council-message-visibility";

type CouncilStoreFile = {
  councils: Council[];
  agents: CouncilAgent[];
  messages: CouncilMessage[];
  claims: CouncilFileClaim[];
  controls: CouncilControlMessage[];
  nextMessageId: number;
  nextControlId: number;
  messageMeta: Record<string, CouncilMeta>;
};

type CouncilMessageFilter = (message: CouncilMessage) => boolean;

type CouncilSnapshotOptions = {
  sinceMessageId?: number;
  limit?: number;
  messageFilter?: CouncilMessageFilter;
  metadataOnly?: boolean;
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

function quarantineCorruptStoreFile(filePath: string, error: unknown): void {
  if (!existsSync(filePath)) {
    return;
  }
  const quarantinePath = `${filePath}.corrupt-${Date.now()}`;
  try {
    renameSync(filePath, quarantinePath);
    console.warn("[rah:council-store] quarantined unreadable store file", {
      filePath,
      quarantinePath,
      error,
    });
  } catch (renameError) {
    console.warn("[rah:council-store] failed to quarantine unreadable store file", {
      filePath,
      error,
      renameError,
    });
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeMessageSummary(value: unknown): CouncilMessageSummary | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "number" ||
    !Number.isInteger(value.id) ||
    (value.role !== "user" && value.role !== "agent" && value.role !== "system") ||
    typeof value.actorId !== "string" ||
    typeof value.text !== "string" ||
    typeof value.createdAt !== "string"
  ) {
    return undefined;
  }
  return {
    id: value.id,
    role: value.role,
    actorId: value.actorId,
    text: value.text,
    createdAt: value.createdAt,
  };
}

function normalizeCouncilMeta(value: unknown): CouncilMeta | undefined {
  if (
    !isRecord(value) ||
    typeof value.messageCount !== "number" ||
    !Number.isInteger(value.messageCount) ||
    value.messageCount < 0
  ) {
    return undefined;
  }
  const firstUserMessage = normalizeMessageSummary(value.firstUserMessage);
  const firstAgentMessage = normalizeMessageSummary(value.firstAgentMessage);
  const lastContentMessage = normalizeMessageSummary(value.lastContentMessage);
  const lastMessage = normalizeMessageSummary(value.lastMessage);
  return {
    messageCount: value.messageCount,
    ...(firstUserMessage ? { firstUserMessage } : {}),
    ...(firstAgentMessage ? { firstAgentMessage } : {}),
    ...(lastContentMessage ? { lastContentMessage } : {}),
    ...(lastMessage ? { lastMessage } : {}),
  };
}

function normalizeCouncilMessageMeta(value: unknown): Record<string, CouncilMeta> {
  if (!isRecord(value)) {
    return {};
  }
  const result: Record<string, CouncilMeta> = {};
  for (const [councilId, rawMeta] of Object.entries(value)) {
    const meta = normalizeCouncilMeta(rawMeta);
    if (meta) {
      result[councilId] = meta;
    }
  }
  return result;
}

function councilActorName(agent: CouncilAgentConfig, index: number): string {
  return normalizeCouncilActorName(agent.label.trim() || agent.id?.trim() || `Agent ${index + 1}`);
}

function normalizeCouncilActorName(value: string): string {
  return value.replace(/[\\/]+/g, "-");
}

function normalizeCouncilClaimPath(workspace: string, filePath: string): string {
  const trimmed = filePath.trim();
  if (!trimmed) {
    return "";
  }
  const workspacePath = path.resolve(workspace);
  const portablePath = trimmed.replace(/\\/g, "/");
  const targetPath = path.isAbsolute(portablePath)
    ? path.resolve(portablePath)
    : path.resolve(workspacePath, portablePath);
  const relativePath = path.relative(workspacePath, targetPath);
  if (
    relativePath === "" ||
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error("Council file claim path must remain inside the council workspace.");
  }
  return path.posix.normalize(relativePath.replace(/\\/g, "/"));
}

function sameCouncilClaimPath(workspace: string, left: string, right: string): boolean {
  try {
    return normalizeCouncilClaimPath(workspace, left) === normalizeCouncilClaimPath(workspace, right);
  } catch {
    return left.trim() === right.trim();
  }
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
      messageMeta: normalizeCouncilMessageMeta(parsed.messageMeta),
    };
  } catch (error) {
    quarantineCorruptStoreFile(filePath, error);
    return {
      councils: [],
      agents: [],
      messages: [],
      claims: [],
      controls: [],
      nextMessageId: 1,
      nextControlId: 1,
      messageMeta: {},
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

function councilMessageText(message: CouncilMessage): string {
  return message.parts
    .map((part) => part.kind === "text" ? part.text : JSON.stringify(part.data) ?? String(part.data))
    .join("\n");
}

function messageSummary(message: CouncilMessage): CouncilMessageSummary {
  return {
    id: message.id,
    role: message.role,
    actorId: message.actorId,
    text: councilMessageText(message),
    createdAt: message.createdAt,
  };
}

function emptyCouncilMeta(): CouncilMeta {
  return { messageCount: 0 };
}

function councilMetaFromMessages(messages: readonly CouncilMessage[]): CouncilMeta {
  const visibleMessages = messages.filter(isClientVisibleCouncilMessage);
  const firstUserMessage = visibleMessages.find((message) => message.role === "user");
  const firstAgentMessage = visibleMessages.find((message) => message.role === "agent");
  const lastContentMessage = [...visibleMessages]
    .reverse()
    .find((message) => message.role === "user" || message.role === "agent");
  const lastMessage = visibleMessages.at(-1);
  return {
    messageCount: visibleMessages.length,
    ...(firstUserMessage ? { firstUserMessage: messageSummary(firstUserMessage) } : {}),
    ...(firstAgentMessage ? { firstAgentMessage: messageSummary(firstAgentMessage) } : {}),
    ...(lastContentMessage ? { lastContentMessage: messageSummary(lastContentMessage) } : {}),
    ...(lastMessage ? { lastMessage: messageSummary(lastMessage) } : {}),
  };
}

function appendCouncilMeta(meta: CouncilMeta, message: CouncilMessage): CouncilMeta {
  if (!isClientVisibleCouncilMessage(message)) {
    return meta;
  }
  const summary = messageSummary(message);
  return {
    ...meta,
    messageCount: meta.messageCount + 1,
    ...(!meta.firstUserMessage && message.role === "user" ? { firstUserMessage: summary } : {}),
    ...(!meta.firstAgentMessage && message.role === "agent" ? { firstAgentMessage: summary } : {}),
    ...(message.role === "user" || message.role === "agent" ? { lastContentMessage: summary } : {}),
    lastMessage: summary,
  };
}

function firstMessageIndexAtOrAfter(messages: CouncilMessage[], messageId: number): number {
  let low = 0;
  let high = messages.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (messages[mid]!.id < messageId) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

function councilMessagesDir(filePath: string): string {
  return path.join(path.dirname(filePath), "messages");
}

function councilMessageFilePath(filePath: string, councilId: string): string {
  return path.join(councilMessagesDir(filePath), `${encodeURIComponent(councilId)}.jsonl`);
}

function cloneCouncilMeta(meta: CouncilMeta): CouncilMeta {
  return {
    messageCount: meta.messageCount,
    ...(meta.firstUserMessage ? { firstUserMessage: { ...meta.firstUserMessage } } : {}),
    ...(meta.firstAgentMessage ? { firstAgentMessage: { ...meta.firstAgentMessage } } : {}),
    ...(meta.lastContentMessage ? { lastContentMessage: { ...meta.lastContentMessage } } : {}),
    ...(meta.lastMessage ? { lastMessage: { ...meta.lastMessage } } : {}),
  };
}

function cloneCouncilStoreState(state: CouncilStoreFile): CouncilStoreFile {
  return {
    councils: state.councils.map((council) => ({ ...council })),
    agents: state.agents.map((agent) => ({
      ...agent,
      ...(agent.providerSessionIds
        ? { providerSessionIds: [...agent.providerSessionIds] }
        : {}),
      ...(agent.optionValues ? { optionValues: { ...agent.optionValues } } : {}),
    })),
    messages: [],
    claims: state.claims.map((claim) => ({ ...claim })),
    controls: state.controls.map((control) => ({
      ...control,
      // Control payloads enter through the JSON protocol and are owned by the
      // store after appendControl returns. Keep the immutable reference rather
      // than performing an unbounded structuredClone on the daemon hot path.
      ...(control.data !== undefined ? { data: control.data } : {}),
    })),
    nextMessageId: state.nextMessageId,
    nextControlId: state.nextControlId,
    messageMeta: Object.fromEntries(
      Object.entries(state.messageMeta).map(([councilId, meta]) => [
        councilId,
        cloneCouncilMeta(meta),
      ]),
    ),
  };
}

function writeCouncilStoreSnapshotSync(
  filePath: string,
  state: CouncilStoreFile,
): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(
    temporaryPath,
    `${JSON.stringify({ ...state, messages: [] }, null, 2)}\n`,
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );
  renameSync(temporaryPath, filePath);
}

async function writeCouncilStoreSnapshot(
  filePath: string,
  state: CouncilStoreFile,
): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await mkdirAsync(path.dirname(filePath), { recursive: true });
  try {
    await pipeline(
      Readable.from(streamJsonChunks(state)),
      createWriteStream(temporaryPath, {
        flags: "wx",
        mode: 0o600,
      }),
    );
    await renameAsync(temporaryPath, filePath);
  } catch (error) {
    await rmAsync(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function* streamCouncilMessageBatch(
  messages: readonly CouncilMessage[],
): AsyncGenerator<Buffer> {
  for (const message of messages) {
    yield* streamJsonChunks(message);
    yield Buffer.from("\n");
  }
}

async function appendCouncilMessageBatch(
  filePath: string,
  messages: readonly CouncilMessage[],
): Promise<void> {
  if (messages.length === 0) {
    return;
  }
  await mkdirAsync(path.dirname(filePath), { recursive: true });
  await repairCouncilMessageLogTail(filePath);
  const lastPersistedMessageId = await readCouncilMessageLogLastIdAsync(filePath);
  const pendingMessages = messages.filter(
    (message) => message.id > lastPersistedMessageId,
  );
  if (pendingMessages.length === 0) {
    return;
  }
  await pipeline(
    Readable.from(streamCouncilMessageBatch(pendingMessages)),
    createWriteStream(filePath, {
      flags: "a",
      mode: 0o600,
    }),
  );
}

async function repairCouncilMessageLogTail(filePath: string): Promise<void> {
  let file;
  try {
    file = await openAsync(filePath, "r+");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  try {
    const { size } = await file.stat();
    if (size === 0) {
      return;
    }
    const finalByte = Buffer.allocUnsafe(1);
    const finalRead = await file.read(finalByte, 0, 1, size - 1);
    if (finalRead.bytesRead === 1 && finalByte[0] === 0x0a) {
      return;
    }

    const buffer = Buffer.allocUnsafe(64 * 1024);
    let end = size;
    while (end > 0) {
      const length = Math.min(buffer.byteLength, end);
      const start = end - length;
      const read = await file.read(buffer, 0, length, start);
      const newline = buffer.subarray(0, read.bytesRead).lastIndexOf(0x0a);
      if (newline >= 0) {
        await file.truncate(start + newline + 1);
        return;
      }
      end = start;
    }
    await file.truncate(0);
  } finally {
    await file.close();
  }
}

async function readCouncilMessageLogLastIdAsync(filePath: string): Promise<number> {
  let file;
  try {
    file = await openAsync(filePath, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw error;
  }
  try {
    const { size } = await file.stat();
    if (size <= 0) {
      return 0;
    }
    let windowSize = Math.min(size, 64 * 1024);
    while (windowSize <= size) {
      const buffer = Buffer.allocUnsafe(windowSize);
      const read = await file.read(buffer, 0, windowSize, size - windowSize);
      const lines = buffer.subarray(0, read.bytesRead).toString("utf8").split(/\r?\n/);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index]!.trim();
        if (!line || (windowSize < size && index === 0)) {
          continue;
        }
        try {
          const parsed = JSON.parse(line) as { id?: unknown };
          if (typeof parsed.id === "number" && Number.isInteger(parsed.id)) {
            return parsed.id;
          }
        } catch {
          // Expand the read window when the final message exceeds the current tail.
        }
      }
      if (windowSize === size) {
        return 0;
      }
      windowSize = Math.min(size, windowSize * 2);
    }
    return 0;
  } finally {
    await file.close();
  }
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
        upsertMessageById(messages, parsed);
      }
    } catch {
      // Keep the council usable even if a single log line is corrupted.
    }
  }
  messages.sort((left, right) => left.id - right.id);
  return messages;
}

function readCouncilMessageLogLastId(filePath: string): number {
  if (!existsSync(filePath)) {
    return 0;
  }
  const file = openSync(filePath, "r");
  try {
    const size = fstatSync(file).size;
    if (size <= 0) {
      return 0;
    }
    let windowSize = Math.min(size, 64 * 1024);
    while (windowSize <= size) {
      const buffer = Buffer.allocUnsafe(windowSize);
      readSync(file, buffer, 0, windowSize, size - windowSize);
      const lines = buffer.toString("utf8").split(/\r?\n/);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index]!.trim();
        if (!line || (windowSize < size && index === 0)) {
          continue;
        }
        try {
          const parsed = JSON.parse(line) as { id?: unknown };
          if (typeof parsed.id === "number" && Number.isInteger(parsed.id)) {
            return parsed.id;
          }
        } catch {
          // Expand the read window when the final message is larger than the current tail.
        }
      }
      if (windowSize === size) {
        return 0;
      }
      windowSize = Math.min(size, windowSize * 2);
    }
    return 0;
  } finally {
    closeSync(file);
  }
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
  private readonly loadedMessageCouncils = new Set<string>();
  private pendingMessageAppends: CouncilMessage[] = [];
  private readonly pendingMessageLogDeletions = new Set<string>();
  private persistenceDirty = false;
  private persistenceTask: Promise<void> | undefined;
  private persistenceError: unknown;

  constructor(private readonly filePath = defaultStoreFilePath()) {
    this.state = loadStoreFile(filePath);
    const legacyMessages = this.state.messages;
    this.state.messages = [];
    const metadataMissing = this.state.councils.some((council) => !this.state.messageMeta[council.id]);
    const messageLogLastIds = new Map(
      this.state.councils.map((council) => [
        council.id,
        readCouncilMessageLogLastId(this.messageFilePath(council.id)),
      ]),
    );
    const nextMessageIdFromLogs = Math.max(
      1,
      ...[...messageLogLastIds.values()].map((lastMessageId) => lastMessageId + 1),
    );
    const messageLogsOutpaceMetadata = nextMessageIdFromLogs > this.state.nextMessageId;
    const requiresMessageRecovery =
      metadataMissing ||
      legacyMessages.length > 0 ||
      messageLogsOutpaceMetadata;
    if (requiresMessageRecovery) {
      this.loadMessageLogsForMigration(legacyMessages);
      for (const council of this.state.councils) {
        this.state.messageMeta[council.id] = councilMetaFromMessages(
          this.messagesByCouncil.get(council.id) ?? [],
        );
      }
    }
    this.state.nextMessageId = Math.max(
      this.state.nextMessageId,
      requiresMessageRecovery ? this.maxMessageId() + 1 : 1,
      legacyMessages.reduce((max, message) => Math.max(max, message.id + 1), 1),
      nextMessageIdFromLogs,
    );
    if (legacyMessages.length > 0) {
      this.writeAllMessageLogs();
    }
    if (requiresMessageRecovery) {
      this.persistStartupMigration();
    }
    this.messagesByCouncil.clear();
    this.loadedMessageCouncils.clear();
  }

  listCouncils(options?: {
    messageLimit?: number;
    messageFilter?: CouncilMessageFilter;
    metadataOnly?: boolean;
  }): CouncilSnapshot[] {
    return [...this.state.councils]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((council) =>
        this.snapshot(
          council.id,
          options?.messageLimit !== undefined ||
            options?.messageFilter !== undefined ||
            options?.metadataOnly !== undefined
            ? {
                ...(options.messageLimit !== undefined ? { limit: options.messageLimit } : {}),
                ...(options.messageFilter !== undefined ? { messageFilter: options.messageFilter } : {}),
                ...(options.metadataOnly !== undefined ? { metadataOnly: options.metadataOnly } : {}),
              }
            : undefined,
        ),
      );
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
    this.state.messageMeta[councilId] = emptyCouncilMeta();
    this.persist();
    return this.metadataSnapshot(councilId);
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

  snapshot(councilId: string, options?: CouncilSnapshotOptions): CouncilSnapshot {
    const council = this.requireCouncil(councilId);
    if (options?.metadataOnly) {
      const meta = this.state.messageMeta[councilId] ?? emptyCouncilMeta();
      return {
        ...council,
        agents: this.state.agents
          .filter((agent) => agent.councilId === councilId)
          .map((agent) => ({ ...agent })),
        messages: [],
        meta: { ...meta },
        messageWindow: {
          total: meta.messageCount,
          loaded: 0,
          hasMoreBefore: meta.messageCount > 0,
        },
        storage: {
          storePath: this.filePath,
          messageLogPath: this.messageFilePath(councilId),
        },
      };
    }
    const since = options?.sinceMessageId ?? 0;
    const limit = options?.limit;
    const councilMessages = options?.messageFilter
      ? this.messagesForCouncil(councilId).filter(options.messageFilter)
      : this.messagesForCouncil(councilId);
    const firstUserMessage = councilMessages.find((message) => message.role === "user");
    const firstAgentMessage = councilMessages.find((message) => message.role === "agent");
    const lastContentMessage = [...councilMessages]
      .reverse()
      .find((message) => message.role === "user" || message.role === "agent");
    const startIndex = firstMessageIndexAfter(councilMessages, since);
    const firstLoadedIndex =
      limit === undefined
        ? startIndex
        : limit <= 0
          ? councilMessages.length
          : Math.max(startIndex, councilMessages.length - limit);
    const messages =
      limit === undefined
        ? councilMessages.slice(startIndex)
        : limit <= 0
          ? []
          : councilMessages.slice(firstLoadedIndex);
    return {
      ...council,
      agents: this.state.agents
        .filter((agent) => agent.councilId === councilId)
        .map((agent) => ({ ...agent })),
      messages: messages.map(cloneCouncilMessage),
      meta: {
        messageCount: councilMessages.length,
        ...(firstUserMessage
          ? { firstUserMessage: messageSummary(firstUserMessage) }
          : {}),
        ...(firstAgentMessage
          ? { firstAgentMessage: messageSummary(firstAgentMessage) }
          : {}),
        ...(lastContentMessage
          ? { lastContentMessage: messageSummary(lastContentMessage) }
          : {}),
        ...(councilMessages.at(-1) ? { lastMessage: messageSummary(councilMessages.at(-1)!) } : {}),
      },
      messageWindow: {
        total: councilMessages.length,
        loaded: messages.length,
        hasMoreBefore: firstLoadedIndex > 0,
        ...(firstLoadedIndex > 0 && messages[0]
          ? { nextBeforeMessageId: messages[0].id }
          : {}),
      },
      storage: {
        storePath: this.filePath,
        messageLogPath: this.messageFilePath(councilId),
      },
    };
  }

  messagePage(
    councilId: string,
    options?: {
      beforeMessageId?: number;
      limit?: number;
      messageFilter?: CouncilMessageFilter;
    },
  ): CouncilMessagesPageResponse {
    this.requireCouncil(councilId);
    const limit = Math.max(1, options?.limit ?? 100);
    const councilMessages = options?.messageFilter
      ? this.messagesForCouncil(councilId).filter(options.messageFilter)
      : this.messagesForCouncil(councilId);
    const endIndex =
      options?.beforeMessageId === undefined
        ? councilMessages.length
        : firstMessageIndexAtOrAfter(councilMessages, options.beforeMessageId);
    const boundedEndIndex = Math.max(0, Math.min(endIndex, councilMessages.length));
    const startIndex = Math.max(0, boundedEndIndex - limit);
    const messages = councilMessages.slice(startIndex, boundedEndIndex);
    return {
      councilId,
      messages: messages.map(cloneCouncilMessage),
      total: councilMessages.length,
      hasMoreBefore: startIndex > 0,
      ...(startIndex > 0 && messages[0]
        ? { nextBeforeMessageId: messages[0].id }
        : {}),
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
    this.state.messageMeta[message.councilId] = appendCouncilMeta(
      this.state.messageMeta[message.councilId] ?? emptyCouncilMeta(),
      message,
    );
    council.updatedAt = timestamp;
    this.persist(message);
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
      messageFilter?: (message: CouncilMessage) => boolean;
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
      if (options?.messageFilter && !options.messageFilter(message)) {
        continue;
      }
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
    return this.metadataSnapshot(councilId);
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
    return this.metadataSnapshot(councilId);
  }

  beginStoppingCouncil(councilId: string): CouncilSnapshot {
    const council = this.requireCouncil(councilId);
    council.status = "running";
    council.phase = "stopping";
    delete council.error;
    council.updatedAt = nowIso();
    this.persist();
    return this.metadataSnapshot(councilId);
  }

  updateAgent(
    councilId: string,
    agentId: string,
    patch: Partial<Pick<
      CouncilAgent,
      "status" | "terminalId" | "nativeSessionId" | "providerSessionIds" | "lastStatusDetail"
    >>,
  ): CouncilSnapshot {
    const agent = this.requireAgent(councilId, agentId);
    Object.assign(agent, patch, { updatedAt: nowIso() });
    this.requireCouncil(councilId).updatedAt = agent.updatedAt;
    this.persist();
    return this.metadataSnapshot(councilId);
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
    return this.metadataSnapshot(councilId);
  }

  clearAgentSessionBinding(
    councilId: string,
    agentId: string,
    expectedSessionId: string,
  ): CouncilSnapshot {
    const agent = this.requireAgent(councilId, agentId);
    const currentSessionId = agent.nativeSessionId ?? agent.terminalId;
    if (currentSessionId !== expectedSessionId) {
      return this.metadataSnapshot(councilId);
    }
    delete agent.nativeSessionId;
    delete agent.terminalId;
    agent.updatedAt = nowIso();
    this.requireCouncil(councilId).updatedAt = agent.updatedAt;
    this.persist();
    return this.metadataSnapshot(councilId);
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
    const council = this.requireCouncil(councilId);
    const normalizedPath = normalizeCouncilClaimPath(council.workspace, filePath);
    if (!normalizedPath) {
      throw new Error("channel_claim_file requires path.");
    }
    this.pruneExpiredClaims(councilId);
    const existing = this.state.claims.find(
      (claim) =>
        claim.councilId === councilId &&
        sameCouncilClaimPath(council.workspace, claim.path, normalizedPath),
    );
    if (existing && existing.actorId !== actorId) {
      throw new Error(`file_conflict: ${normalizedPath} is already claimed by ${existing.actorId}.`);
    }
    const timestamp = nowIso();
    if (existing) {
      existing.path = normalizedPath;
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
    const council = this.requireCouncil(councilId);
    const normalizedPath = normalizeCouncilClaimPath(council.workspace, filePath);
    const before = this.state.claims.length;
    this.state.claims = this.state.claims.filter(
      (claim) =>
        !(
          claim.councilId === councilId &&
          sameCouncilClaimPath(council.workspace, claim.path, normalizedPath) &&
          claim.actorId === actorId
        ),
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

  stopCouncil(councilId: string, agentStatusDetail = "Council stopped"): CouncilSnapshot {
    const timestamp = nowIso();
    const council = this.requireCouncil(councilId);
    council.status = "stopped";
    council.phase = "ended";
    delete council.error;
    council.updatedAt = timestamp;
    for (const agent of this.state.agents.filter((candidate) => candidate.councilId === councilId)) {
      agent.status = "stopped";
      agent.lastStatusDetail = agentStatusDetail;
      agent.updatedAt = timestamp;
    }
    this.state.claims = this.state.claims.filter((claim) => claim.councilId !== councilId);
    this.state.controls = this.state.controls.filter((control) => control.councilId !== councilId);
    this.persist();
    return this.metadataSnapshot(councilId);
  }

  deleteCouncil(councilId: string): void {
    this.requireCouncil(councilId);
    this.state.councils = this.state.councils.filter((council) => council.id !== councilId);
    this.state.agents = this.state.agents.filter((agent) => agent.councilId !== councilId);
    this.messagesByCouncil.delete(councilId);
    this.loadedMessageCouncils.delete(councilId);
    delete this.state.messageMeta[councilId];
    this.pendingMessageAppends = this.pendingMessageAppends.filter(
      (message) => message.councilId !== councilId,
    );
    this.pendingMessageLogDeletions.add(councilId);
    this.state.claims = this.state.claims.filter((claim) => claim.councilId !== councilId);
    this.state.controls = this.state.controls.filter((control) => control.councilId !== councilId);
    this.persist();
  }

  /**
   * Waits until all Council mutations accepted by the in-memory store are
   * durably reflected in the message journals and atomic metadata snapshot.
   * Normal shutdown must call this method so the write-behind queue never
   * turns process exit into an implicit data-loss boundary.
   */
  async flush(): Promise<void> {
    while (true) {
      const task = this.persistenceTask;
      if (task) {
        await task.catch(() => {});
        continue;
      }
      if (this.persistenceError) {
        throw this.persistenceError;
      }
      if (!this.hasPendingPersistence()) {
        return;
      }
      this.schedulePersistence();
    }
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

  private persist(message?: CouncilMessage): void {
    if (message) {
      this.pendingMessageAppends.push(cloneCouncilMessage(message));
    }
    this.persistenceDirty = true;
    this.schedulePersistence();
  }

  private persistStartupMigration(): void {
    writeCouncilStoreSnapshotSync(this.filePath, this.state);
  }

  private hasPendingPersistence(): boolean {
    return (
      this.persistenceDirty ||
      this.pendingMessageAppends.length > 0 ||
      this.pendingMessageLogDeletions.size > 0
    );
  }

  private schedulePersistence(): void {
    if (this.persistenceTask || !this.hasPendingPersistence()) {
      return;
    }
    this.persistenceError = undefined;
    const task = this.runPersistenceTask();
    this.persistenceTask = task;
    void task.catch(() => {
      // flush() exposes the recorded failure to normal shutdown. Attaching a
      // rejection handler here prevents a background durability failure from
      // becoming an unhandled-rejection process crash before shutdown.
    });
  }

  private async runPersistenceTask(): Promise<void> {
    try {
      await this.drainPersistence();
    } catch (error) {
      this.persistenceError = error;
      console.error("[rah:council-store] asynchronous persistence failed", {
        filePath: this.filePath,
        error,
      });
      throw error;
    } finally {
      this.persistenceTask = undefined;
      if (!this.persistenceError && this.hasPendingPersistence()) {
        this.schedulePersistence();
      }
    }
  }

  private async drainPersistence(): Promise<void> {
    await yieldToEventLoop();
    while (this.hasPendingPersistence()) {
      const messageAppends = this.pendingMessageAppends;
      this.pendingMessageAppends = [];
      const messageLogDeletions = [...this.pendingMessageLogDeletions];
      this.pendingMessageLogDeletions.clear();
      const shouldWriteSnapshot = this.persistenceDirty;
      this.persistenceDirty = false;
      const snapshot = shouldWriteSnapshot
        ? cloneCouncilStoreState(this.state)
        : undefined;

      try {
        const messagesByCouncil = new Map<string, CouncilMessage[]>();
        for (const message of messageAppends) {
          const messages = messagesByCouncil.get(message.councilId) ?? [];
          messages.push(message);
          messagesByCouncil.set(message.councilId, messages);
        }
        for (const [councilId, messages] of messagesByCouncil) {
          await appendCouncilMessageBatch(this.messageFilePath(councilId), messages);
        }
        if (snapshot) {
          await writeCouncilStoreSnapshot(this.filePath, snapshot);
        }
        for (const councilId of messageLogDeletions) {
          await rmAsync(this.messageFilePath(councilId), { force: true });
        }
      } catch (error) {
        this.pendingMessageAppends = [
          ...messageAppends,
          ...this.pendingMessageAppends,
        ];
        if (snapshot) {
          this.persistenceDirty = true;
        }
        for (const councilId of messageLogDeletions) {
          this.pendingMessageLogDeletions.add(councilId);
        }
        throw error;
      }

      await yieldToEventLoop();
    }
  }

  private messagesForCouncil(councilId: string): CouncilMessage[] {
    if (!this.loadedMessageCouncils.has(councilId)) {
      this.messagesByCouncil.set(councilId, readCouncilMessageLog(this.messageFilePath(councilId)));
      this.loadedMessageCouncils.add(councilId);
    }
    return this.messagesByCouncil.get(councilId)!;
  }

  private metadataSnapshot(councilId: string): CouncilSnapshot {
    return this.snapshot(councilId, { metadataOnly: true });
  }

  private messageFilePath(councilId: string): string {
    return councilMessageFilePath(this.filePath, councilId);
  }

  private loadMessageLogsForMigration(legacyMessages: CouncilMessage[]): void {
    const knownCouncilIds = new Set(this.state.councils.map((council) => council.id));
    for (const council of this.state.councils) {
      const messages = readCouncilMessageLog(this.messageFilePath(council.id));
      this.messagesByCouncil.set(council.id, messages);
      this.loadedMessageCouncils.add(council.id);
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

  private maxMessageId(): number {
    let max = 0;
    for (const messages of this.messagesByCouncil.values()) {
      max = Math.max(max, messages.at(-1)?.id ?? 0);
    }
    return max;
  }
}
