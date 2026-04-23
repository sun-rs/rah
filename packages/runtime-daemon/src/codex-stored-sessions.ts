import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type {
  ManagedSession,
  RahEvent,
  SessionHistoryPageResponse,
  StoredSessionRef,
  AttachSessionRequest,
} from "@rah/runtime-protocol";
import type {
  FrozenHistoryBoundary,
  FrozenHistoryPageLoader,
} from "./history-snapshots";
import type { RuntimeServices } from "./provider-adapter";
import { EventBus } from "./event-bus";
import { PtyHub } from "./pty-hub";
import { applyProviderActivity } from "./provider-activity";
import {
  createCodexRolloutTranslationState,
  translateCodexRolloutLine,
} from "./codex-rollout-activity";
import { createLineHistoryWindowTranslator } from "./line-history-checkpoint";
import { createLineFrozenHistoryPageLoader } from "./line-history-pager";
import { SessionStore } from "./session-store";
import { selectSemanticRecentWindow } from "./semantic-history-window";
import { readLeadingLines, readTrailingLinesWindow } from "./file-snippets";
import {
  getCachedStoredSessionRef,
  loadStoredSessionMetadataCache,
  setCachedStoredSessionRef,
  writeStoredSessionMetadataCache,
} from "./stored-session-metadata-cache";
import {
  listCodexWrapperHomes,
  resolveCodexBaseHome,
} from "./codex-wrapper-home";
import {
  applyWorkspaceGitFileAction,
  applyWorkspaceGitHunkAction,
  getWorkspaceGitDiff,
  getWorkspaceGitStatusData,
  getWorkspaceSnapshot,
  readWorkspaceFileData,
  searchWorkspaceFilesInDirectory,
} from "./workspace-utils";

const MAX_SEARCH_DEPTH = 4;
const MAX_HEAD_LINES = 64;
const MAX_ROLLOUT_FILES = 400;
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

export function resolveCodexStoredSessionWatchRoots(): string[] {
  return [resolveCodexBaseHome()];
}

function resolveCodexSearchRoots(): string[] {
  const home = resolveCodexBaseHome();
  const roots = [path.join(home, "sessions"), path.join(home, "archived_sessions")];
  for (const wrapperHome of listCodexWrapperHomes(home)) {
    roots.push(path.join(wrapperHome, "sessions"), path.join(wrapperHome, "archived_sessions"));
  }
  return roots;
}

function readHeadLines(filePath: string, maxBytes = 512 * 1024): string[] {
  return readLeadingLines(filePath, { maxBytes, maxLines: MAX_HEAD_LINES });
}

function truncateText(value: string, maxLength = 120): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function makeCodexFrozenHistoryBoundary(
  rolloutPath: string,
  endOffset: number,
): FrozenHistoryBoundary {
  return {
    kind: "frozen",
    sourceRevision: JSON.stringify({
      provider: "codex",
      rolloutPath,
      endOffset,
    }),
  };
}

function isCodexUserBoundaryLine(line: string): boolean {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const payload =
      parsed.payload && typeof parsed.payload === "object" && !Array.isArray(parsed.payload)
        ? (parsed.payload as Record<string, unknown>)
        : null;
    return payload?.type === "message" && payload.role === "user";
  } catch {
    return false;
  }
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

function shouldInvalidateCachedCodexTitle(ref: StoredSessionRef, filePath: string): boolean {
  const basename = path.basename(filePath);
  return (
    !ref.title ||
    ref.title === basename ||
    ref.preview === basename ||
    isCodexBootstrapUserMessage(ref.title) ||
    isCodexBootstrapUserMessage(ref.preview ?? "")
  );
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
      if (cachedRef && !shouldInvalidateCachedCodexTitle(cachedRef, file)) {
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

function translateCodexRolloutWindowToHistoryEvents(args: {
  sessionId: string;
  providerSessionId: string;
  cwd: string;
  rootDir: string;
  title?: string;
  preview?: string;
  lines: string[];
}): RahEvent[] {
  const services = {
    eventBus: new EventBus(),
    ptyHub: new PtyHub(),
    sessionStore: new SessionStore(),
  };
  const temp = services.sessionStore.createManagedSession({
    provider: "codex",
    providerSessionId: args.providerSessionId,
    launchSource: "web",
    cwd: args.cwd,
    rootDir: args.rootDir,
    ...(args.title !== undefined ? { title: args.title } : {}),
    ...(args.preview !== undefined ? { preview: args.preview } : {}),
  });
  const translationState = createCodexRolloutTranslationState();
  for (const line of args.lines) {
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
        temp.session.id,
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
  return collapseDuplicateTimelineEvents(
    services.eventBus
      .list({ sessionIds: [temp.session.id] })
      .map((event) => ({
        ...event,
        id: `history:${event.id}`,
        seq: event.seq + 1_000_000_000,
        sessionId: args.sessionId,
      }))
      .sort((a, b) => a.ts.localeCompare(b.ts) || a.seq - b.seq),
  );
}

function readCodexFrozenHistoryWindow(args: {
  sessionId: string;
  record: CodexStoredSessionRecord;
  endOffset: number;
  limit: number;
}): { startOffset: number; events: RahEvent[] } {
  let lineBudget = Math.max(args.limit * 4, 200);
  let lastStartOffset = args.endOffset;
  let events: RahEvent[] = [];

  for (;;) {
    const window = readTrailingLinesWindow(args.record.rolloutPath, {
      endOffset: args.endOffset,
      maxLines: lineBudget,
      chunkBytes: 8 * 1024,
    });
    const previousStartOffset = lastStartOffset;
    events = translateCodexRolloutWindowToHistoryEvents({
      sessionId: args.sessionId,
      providerSessionId: args.record.ref.providerSessionId,
      cwd: args.record.ref.cwd ?? process.cwd(),
      rootDir: args.record.ref.rootDir ?? args.record.ref.cwd ?? process.cwd(),
      ...(args.record.ref.title !== undefined ? { title: args.record.ref.title } : {}),
      ...(args.record.ref.preview !== undefined ? { preview: args.record.ref.preview } : {}),
      lines: window.lines,
    });
    lastStartOffset = window.startOffset;
    if (
      events.length >= args.limit ||
      window.startOffset === 0 ||
      window.startOffset === previousStartOffset
    ) {
      break;
    }
    lineBudget *= 2;
    if (lineBudget >= 8192) {
      break;
    }
  }

  return {
    startOffset: lastStartOffset,
    events,
  };
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
      services.sessionStore.claimControl(
        state.session.id,
        params.attach.client.id,
        params.attach.client.kind,
      );
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

export function createCodexStoredSessionFrozenHistoryPageLoader(args: {
  sessionId: string;
  record: CodexStoredSessionRecord;
}): FrozenHistoryPageLoader {
  const snapshotEndOffset = statSync(args.record.rolloutPath).size;
  const boundary = makeCodexFrozenHistoryBoundary(args.record.rolloutPath, snapshotEndOffset);
  const translateWindow = createLineHistoryWindowTranslator({
    sessionId: args.sessionId,
    findSafeBoundaryIndex: (lines) => lines.findIndex(isCodexUserBoundaryLine),
    translateLines: (lines) =>
      translateCodexRolloutWindowToHistoryEvents({
        sessionId: args.sessionId,
        providerSessionId: args.record.ref.providerSessionId,
        cwd: args.record.ref.cwd ?? process.cwd(),
        rootDir: args.record.ref.rootDir ?? args.record.ref.cwd ?? process.cwd(),
        ...(args.record.ref.title !== undefined ? { title: args.record.ref.title } : {}),
        ...(args.record.ref.preview !== undefined ? { preview: args.record.ref.preview } : {}),
        lines: [...lines],
      }),
  });
  return createLineFrozenHistoryPageLoader({
    boundary,
    snapshotEndOffset,
    readWindow: ({ endOffset, lineBudget }) => {
      const window = readTrailingLinesWindow(args.record.rolloutPath, {
        endOffset,
        maxLines: Math.max(lineBudget, 1),
        chunkBytes: 8 * 1024,
      });
      return {
        startOffset: window.startOffset,
        events: translateWindow(window.endOffset, window.lines),
      };
    },
    selectPage: selectSemanticRecentWindow,
  });
}

export function getCodexWorkspaceSnapshot(cwd: string) {
  return getWorkspaceSnapshot(cwd);
}

export function getCodexGitStatus(cwd: string, options?: { scopeRoot?: string }) {
  return getWorkspaceGitStatusData(cwd, options);
}

export function getCodexGitDiff(
  cwd: string,
  targetPath: string,
  options?: { staged?: boolean; ignoreWhitespace?: boolean; scopeRoot?: string },
): string {
  return getWorkspaceGitDiff(cwd, targetPath, options);
}

export function applyCodexGitFileAction(
  cwd: string,
  request: Parameters<typeof applyWorkspaceGitFileAction>[1],
  options?: { scopeRoot?: string },
) {
  return applyWorkspaceGitFileAction(cwd, request, options);
}

export function applyCodexGitHunkAction(
  cwd: string,
  request: Parameters<typeof applyWorkspaceGitHunkAction>[1],
  options?: { scopeRoot?: string },
) {
  return applyWorkspaceGitHunkAction(cwd, request, options);
}

export function searchWorkspaceFiles(cwd: string, query: string, limit = 100) {
  return searchWorkspaceFilesInDirectory(cwd, query, limit);
}

export function readWorkspaceFile(
  cwd: string,
  targetPath: string,
  options?: { scopeRoot?: string },
) {
  return readWorkspaceFileData(cwd, targetPath, options);
}
