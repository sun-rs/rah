import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ManagedSession,
  RahEvent,
  SessionHistoryPageResponse,
  StoredSessionRef,
  AttachSessionRequest,
} from "@rah/runtime-protocol";
import type { RuntimeServices } from "./provider-adapter";
import { EventBus } from "./event-bus";
import { PtyHub } from "./pty-hub";
import { applyProviderActivity } from "./provider-activity";
import {
  createCodexRolloutTranslationState,
  translateCodexRolloutLine,
} from "./codex-rollout-activity";
import { SessionStore } from "./session-store";
import { readLeadingLines } from "./file-snippets";
import {
  getCachedStoredSessionRef,
  loadStoredSessionMetadataCache,
  setCachedStoredSessionRef,
  writeStoredSessionMetadataCache,
} from "./stored-session-metadata-cache";

const MAX_SEARCH_DEPTH = 4;
const MAX_HEAD_LINES = 64;
const MAX_ROLLOUT_FILES = 400;
const MAX_READABLE_FILE_BYTES = 1_000_000;
const REHYDRATED_CAPABILITIES = {
  livePermissions: false,
  steerInput: false,
  queuedInput: false,
  modelSwitch: false,
  planMode: false,
  subagents: false,
} as const;
const SYSTEM_SOURCE = {
  provider: "system" as const,
  channel: "system" as const,
  authority: "authoritative" as const,
};

export interface CodexStoredSessionRecord {
  ref: StoredSessionRef;
  rolloutPath: string;
}

function resolveCodexHome(): string {
  return process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
}

function resolveCodexSearchRoots(): string[] {
  const home = resolveCodexHome();
  return [path.join(home, "sessions"), path.join(home, "archived_sessions")];
}

function readHeadLines(filePath: string, maxBytes = 64 * 1024): string[] {
  return readLeadingLines(filePath, { maxBytes, maxLines: MAX_HEAD_LINES });
}

function truncateText(value: string, maxLength = 120): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function isCodexBootstrapUserMessage(text: string): boolean {
  return (
    text.includes("<environment_context>") ||
    text.includes("# AGENTS.md instructions") ||
    text.includes("<INSTRUCTIONS>") ||
    text.includes("<permissions instructions>") ||
    text.includes("<skills_instructions>")
  );
}

function listRolloutFiles(root: string): string[] {
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  const files: string[] = [];
  while (queue.length > 0 && files.length < MAX_ROLLOUT_FILES) {
    const current = queue.pop()!;
    let entries: string[] = [];
    try {
      entries = readdirSync(current.dir);
    } catch {
      continue;
    }
    for (const entryName of entries) {
      const fullPath = path.join(current.dir, entryName);
      let stats;
      try {
        stats = statSync(fullPath);
      } catch {
        continue;
      }
      if (stats.isFile()) {
        if (entryName.startsWith("rollout-") && entryName.endsWith(".jsonl")) {
          files.push(fullPath);
        }
        continue;
      }
      if (stats.isDirectory() && current.depth < MAX_SEARCH_DEPTH) {
        queue.push({ dir: fullPath, depth: current.depth + 1 });
      }
    }
  }
  return files;
}

function parseStoredSessionRecord(filePath: string): CodexStoredSessionRecord | null {
  const head = readHeadLines(filePath);
  let sessionId: string | null = null;
  let cwd: string | undefined;
  let createdAt: string | undefined;
  let firstUserMessage: string | null = null;

  for (const line of head) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      continue;
    }
    const record = parsed as Record<string, unknown>;
    if (record.type === "session_meta") {
      const payload =
        record.payload && typeof record.payload === "object" && !Array.isArray(record.payload)
          ? (record.payload as Record<string, unknown>)
          : null;
      if (!payload) {
        continue;
      }
      if (typeof payload.id === "string") {
        sessionId = payload.id;
      }
      if (typeof payload.cwd === "string") {
        cwd = payload.cwd;
      }
      if (typeof payload.timestamp === "string") {
        createdAt = payload.timestamp;
      }
      continue;
    }

    const payload =
      record.payload && typeof record.payload === "object" && !Array.isArray(record.payload)
        ? (record.payload as Record<string, unknown>)
        : null;
    if (
      record.type === "response_item" &&
      payload?.type === "message" &&
      payload.role === "user" &&
      Array.isArray(payload.content)
    ) {
      const text = payload.content
        .filter((item) => item && typeof item === "object" && !Array.isArray(item))
        .map((item) => item as Record<string, unknown>)
        .filter((item) => item.type === "input_text" && typeof item.text === "string")
        .map((item) => item.text as string)
        .join("\n")
        .trim();
      if (text) {
        if (isCodexBootstrapUserMessage(text)) {
          continue;
        }
        firstUserMessage = text;
        break;
      }
    }
  }

  if (!sessionId) {
    const match = /([0-9a-f]{8}-[0-9a-f-]{27,})/i.exec(path.basename(filePath));
    if (match) {
      sessionId = match[1]!;
    }
  }
  if (!sessionId) {
    return null;
  }

  const stat = statSync(filePath);
  const preview = firstUserMessage ? truncateText(firstUserMessage) : path.basename(filePath);
  return {
    ref: {
      provider: "codex",
      providerSessionId: sessionId,
      ...(cwd ? { cwd } : {}),
      ...(cwd ? { rootDir: cwd } : {}),
      title: truncateText(preview, 72),
      preview,
      updatedAt: stat.mtime.toISOString(),
      source: "provider_history",
    },
    rolloutPath: filePath,
  };
}

export function discoverCodexStoredSessions(): CodexStoredSessionRecord[] {
  const cache = loadStoredSessionMetadataCache("codex");
  const records = new Map<string, CodexStoredSessionRecord>();
  for (const root of resolveCodexSearchRoots()) {
    for (const file of listRolloutFiles(root)) {
      const stats = statSync(file);
      const cachedRef = getCachedStoredSessionRef({
        cache,
        filePath: file,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
      });
      if (cachedRef) {
        records.set(cachedRef.providerSessionId, {
          ref: cachedRef,
          rolloutPath: file,
        });
        continue;
      }
      const parsed = parseStoredSessionRecord(file);
      if (!parsed) {
        continue;
      }
      setCachedStoredSessionRef({
        cache,
        filePath: file,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        ref: parsed.ref,
      });
      records.set(parsed.ref.providerSessionId, parsed);
    }
  }
  writeStoredSessionMetadataCache(
    "codex",
    new Map(
      [...records.values()].map((record) => {
        const stats = statSync(record.rolloutPath);
        return [
          record.rolloutPath,
          {
            ref: record.ref,
            size: stats.size,
            mtimeMs: stats.mtimeMs,
          },
        ] as const;
      }),
    ),
  );
  return [...records.values()].sort((a, b) =>
    (b.ref.updatedAt ?? "").localeCompare(a.ref.updatedAt ?? ""),
  );
}

function tryReadGitStatus(cwd: string): { branch?: string; changedFiles: string[] } {
  try {
    const output = execFileSync(
      "git",
      ["-C", cwd, "status", "--porcelain", "--branch"],
      { encoding: "utf8" },
    );
    const lines = output.split(/\r?\n/).filter(Boolean);
    const branchLine = lines[0] ?? "";
    const branchMatch = /^## ([^.\s]+)/.exec(branchLine);
    return {
      ...(branchMatch ? { branch: branchMatch[1] } : {}),
      changedFiles: lines
        .slice(1)
        .map((line) => line.slice(3).trim())
        .filter(Boolean),
    };
  } catch {
    return { changedFiles: [] };
  }
}

function resolveWorkspacePath(cwd: string, targetPath: string): string {
  const resolvedWorkspace = path.resolve(cwd);
  const resolvedTarget = path.resolve(resolvedWorkspace, targetPath);
  const relativePath = path.relative(resolvedWorkspace, resolvedTarget);
  if (
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error("Path must remain inside the workspace.");
  }
  return resolvedTarget;
}

function toGitPath(cwd: string, targetPath: string): string {
  const resolvedTarget = resolveWorkspacePath(cwd, targetPath);
  const relativePath = path.relative(cwd, resolvedTarget);
  return relativePath || path.basename(resolvedTarget);
}

function isLikelyBinary(buffer: Buffer): boolean {
  if (buffer.length === 0) {
    return false;
  }
  let nonPrintableCount = 0;
  for (const byte of buffer) {
    if (byte === 0) {
      return true;
    }
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) {
      nonPrintableCount += 1;
    }
  }
  return nonPrintableCount / buffer.length > 0.1;
}

function readWorkspaceNodes(cwd: string) {
  try {
    return readdirSync(cwd, { withFileTypes: true })
      .slice(0, 200)
      .map((entry) => ({
        path: path.join(cwd, entry.name),
        name: entry.name,
        kind: entry.isDirectory() ? ("directory" as const) : ("file" as const),
      }));
  } catch {
    return [];
  }
}

function sameTimelineText(
  left: RahEvent | undefined,
  right: RahEvent,
): boolean {
  if (left?.type !== "timeline.item.added" || right.type !== "timeline.item.added") {
    return false;
  }
  const leftItem = left.payload.item;
  const rightItem = right.payload.item;
  if (leftItem.kind !== rightItem.kind) {
    return false;
  }
  if (
    leftItem.kind === "user_message" ||
    leftItem.kind === "assistant_message" ||
    leftItem.kind === "reasoning"
  ) {
    return leftItem.text === (rightItem as typeof leftItem).text;
  }
  return false;
}

function collapseDuplicateTimelineEvents(events: RahEvent[]): RahEvent[] {
  const next: RahEvent[] = [];
  for (const event of events) {
    const previous = next.at(-1);
    if (sameTimelineText(previous, event)) {
      continue;
    }
    next.push(event);
  }
  return next;
}

function publishSessionBootstrap(
  services: RuntimeServices,
  sessionId: string,
  session: ManagedSession,
) {
  services.eventBus.publish({
    sessionId,
    type: "session.created",
    source: SYSTEM_SOURCE,
    payload: { session },
  });
  services.eventBus.publish({
    sessionId,
    type: "session.started",
    source: SYSTEM_SOURCE,
    payload: { session },
  });
}

export function replayCodexStoredSessionRollout(params: {
  services: RuntimeServices;
  sessionId: string;
  record: CodexStoredSessionRecord;
  bannerText?: string;
}) {
  const { services, sessionId, record, bannerText } = params;
  if (bannerText !== undefined) {
    services.ptyHub.appendOutput(sessionId, bannerText);
  }

  const translationState = createCodexRolloutTranslationState();
  const lines = readFileSync(record.rolloutPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const translated = translateCodexRolloutLine(parsed, translationState);
    for (const item of translated) {
      applyProviderActivity(
        services,
        sessionId,
        {
          provider: "codex",
          ...(item.channel !== undefined ? { channel: item.channel } : {}),
          ...(item.authority !== undefined ? { authority: item.authority } : {}),
          ...(item.raw !== undefined ? { raw: item.raw } : {}),
          ...(item.ts !== undefined ? { ts: item.ts } : {}),
        },
        item.activity,
      );
    }
  }
}

export function resumeCodexStoredSession(params: {
  services: RuntimeServices;
  record: CodexStoredSessionRecord;
  attach?: AttachSessionRequest;
}): { sessionId: string } {
  const { services, record } = params;
  const state = services.sessionStore.createManagedSession({
    provider: "codex",
    providerSessionId: record.ref.providerSessionId,
    launchSource: "web",
    cwd: record.ref.cwd ?? process.cwd(),
    rootDir: record.ref.rootDir ?? record.ref.cwd ?? process.cwd(),
    ...(record.ref.title ? { title: record.ref.title } : {}),
    ...(record.ref.preview ? { preview: record.ref.preview } : {}),
    capabilities: REHYDRATED_CAPABILITIES,
  });
  services.ptyHub.ensureSession(state.session.id);
  services.sessionStore.setRuntimeState(state.session.id, "idle");
  const session = services.sessionStore.getSession(state.session.id)!;
  publishSessionBootstrap(services, state.session.id, session.session);
  if (params.attach) {
    services.sessionStore.attachClient({
      sessionId: state.session.id,
      clientId: params.attach.client.id,
      kind: params.attach.client.kind,
      connectionId: params.attach.client.connectionId,
      attachMode: params.attach.mode,
      focus: true,
    });
    services.eventBus.publish({
      sessionId: state.session.id,
      type: "session.attached",
      source: SYSTEM_SOURCE,
      payload: {
        clientId: params.attach.client.id,
        clientKind: params.attach.client.kind,
      },
    });
    if (params.attach.claimControl) {
      services.sessionStore.claimControl(state.session.id, params.attach.client.id);
      services.eventBus.publish({
        sessionId: state.session.id,
        type: "control.claimed",
        source: SYSTEM_SOURCE,
        payload: {
          clientId: params.attach.client.id,
          clientKind: params.attach.client.kind,
        },
      });
    }
  }
  replayCodexStoredSessionRollout({
    services,
    sessionId: state.session.id,
    record,
    bannerText: `Rehydrated Codex rollout ${record.ref.providerSessionId}\r\n$ `,
  });

  return { sessionId: state.session.id };
}

export function getCodexStoredSessionHistoryPage(params: {
  sessionId: string;
  record: CodexStoredSessionRecord;
  beforeTs?: string;
  limit?: number;
}): SessionHistoryPageResponse {
  const services = {
    eventBus: new EventBus(),
    ptyHub: new PtyHub(),
    sessionStore: new SessionStore(),
  };
  const temp = services.sessionStore.createManagedSession({
    provider: "codex",
    providerSessionId: params.record.ref.providerSessionId,
    launchSource: "web",
    cwd: params.record.ref.cwd ?? process.cwd(),
    rootDir: params.record.ref.rootDir ?? params.record.ref.cwd ?? process.cwd(),
    ...(params.record.ref.title !== undefined ? { title: params.record.ref.title } : {}),
    ...(params.record.ref.preview !== undefined ? { preview: params.record.ref.preview } : {}),
  });

  replayCodexStoredSessionRollout({
    services,
    sessionId: temp.session.id,
    record: params.record,
  });

  const all: RahEvent[] = services.eventBus
    .list({ sessionIds: [temp.session.id] })
    .filter((event) => (params.beforeTs ? event.ts < params.beforeTs : true))
    .map((event) => ({
      ...event,
      id: `history:${event.id}`,
      seq: event.seq + 1_000_000_000,
      sessionId: params.sessionId,
    }))
    .sort((a, b) => a.ts.localeCompare(b.ts) || a.seq - b.seq);
  const collapsed = collapseDuplicateTimelineEvents(all);

  const limit = Math.max(1, params.limit ?? 1000);
  const start = Math.max(0, collapsed.length - limit);
  const events = collapsed.slice(start);
  return {
    sessionId: params.sessionId,
    events,
    ...(start > 0 && events[0] ? { nextBeforeTs: events[0].ts } : {}),
  };
}

export function getCodexWorkspaceSnapshot(cwd: string) {
  return {
    cwd,
    nodes: readWorkspaceNodes(cwd),
  };
}

export function getCodexGitStatus(cwd: string) {
  return tryReadGitStatus(cwd);
}

export function getCodexGitDiff(cwd: string, targetPath: string): string {
  try {
    return execFileSync(
      "git",
      ["-C", cwd, "diff", "--", toGitPath(cwd, targetPath)],
      { encoding: "utf8" },
    );
  } catch {
    return "";
  }
}

export function readWorkspaceFile(cwd: string, targetPath: string) {
  const resolvedPath = resolveWorkspacePath(cwd, targetPath);
  const stats = statSync(resolvedPath);
  if (!stats.isFile()) {
    throw new Error("Path is not a file.");
  }
  const buffer = readFileSync(resolvedPath);
  const truncated = buffer.byteLength > MAX_READABLE_FILE_BYTES;
  const contentBuffer = truncated
    ? buffer.subarray(0, MAX_READABLE_FILE_BYTES)
    : buffer;
  const binary = isLikelyBinary(contentBuffer);
  return {
    path: resolvedPath,
    content: binary ? "" : contentBuffer.toString("utf8"),
    binary,
    ...(truncated ? { truncated: true } : {}),
  };
}
