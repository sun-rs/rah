import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  GitChangedFile,
  GitFileActionRequest,
  GitFileActionResponse,
  GitHunkActionRequest,
  GitHunkActionResponse,
  ManagedSession,
  RahEvent,
  SessionFileSearchItem,
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

export function resolveCodexStoredSessionWatchRoots(): string[] {
  return [resolveCodexHome()];
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

function tryReadGitStatus(cwd: string): {
  branch?: string;
  changedFiles: string[];
  stagedFiles: GitChangedFile[];
  unstagedFiles: GitChangedFile[];
  totalStaged: number;
  totalUnstaged: number;
} {
  try {
    const scopeRoot = path.resolve(cwd);
    const gitCwd = getGitCommandCwd(cwd);
    const output = execFileSync(
      "git",
      ["-C", gitCwd, "status", "--porcelain", "--branch"],
      { encoding: "utf8" },
    );
    const lines = output.split(/\r?\n/).filter(Boolean);
    const branchLine = lines[0] ?? "";
    const branchMatch = /^## ([^.\s]+)/.exec(branchLine);
    const unstagedStats = createDiffStatsMap(parseNumStat(runGitNumstat(gitCwd, false)));
    const stagedStats = createDiffStatsMap(parseNumStat(runGitNumstat(gitCwd, true)));
    const stagedFiles: GitChangedFile[] = [];
    const unstagedFiles: GitChangedFile[] = [];
    const changedFiles = new Set<string>();

    for (const line of lines.slice(1)) {
      if (line.startsWith("?? ")) {
        const rawPath = line.slice(3).trim();
        if (!rawPath || rawPath.endsWith("/")) {
          continue;
        }
        if (!isPathWithinBase(scopeRoot, path.resolve(gitCwd, rawPath))) {
          continue;
        }
        changedFiles.add(rawPath);
        unstagedFiles.push({
          path: rawPath,
          status: "untracked",
          staged: false,
          added: 0,
          removed: 0,
        });
        continue;
      }

      const indexStatus = line[0] ?? " ";
      const worktreeStatus = line[1] ?? " ";
      const rawPath = line.slice(3).trim();
      if (!rawPath) {
        continue;
      }
      const renameMatch = /^(.*?) -> (.*)$/.exec(rawPath);
      const resolvedPath = renameMatch ? renameMatch[2]!.trim() : rawPath;
      const oldPath = renameMatch ? renameMatch[1]!.trim() : undefined;
      if (!isPathWithinBase(scopeRoot, path.resolve(gitCwd, resolvedPath))) {
        continue;
      }
      changedFiles.add(resolvedPath);

      if (indexStatus !== " " && indexStatus !== "?") {
        const stats = stagedStats[resolvedPath] ?? { added: 0, removed: 0, binary: false };
        stagedFiles.push({
          path: resolvedPath,
          ...(oldPath ? { oldPath } : {}),
          status: getGitFileStatus(indexStatus),
          staged: true,
          added: stats.added,
          removed: stats.removed,
          ...(stats.binary ? { binary: true } : {}),
        });
      }

      if (worktreeStatus !== " " && worktreeStatus !== "?") {
        const stats = unstagedStats[resolvedPath] ?? { added: 0, removed: 0, binary: false };
        unstagedFiles.push({
          path: resolvedPath,
          ...(oldPath ? { oldPath } : {}),
          status: getGitFileStatus(worktreeStatus),
          staged: false,
          added: stats.added,
          removed: stats.removed,
          ...(stats.binary ? { binary: true } : {}),
        });
      }
    }

    return {
      ...(branchMatch ? { branch: branchMatch[1] } : {}),
      changedFiles: [...changedFiles],
      stagedFiles,
      unstagedFiles,
      totalStaged: stagedFiles.length,
      totalUnstaged: unstagedFiles.length,
    };
  } catch {
    return {
      changedFiles: [],
      stagedFiles: [],
      unstagedFiles: [],
      totalStaged: 0,
      totalUnstaged: 0,
    };
  }
}

type DiffStat = {
  added: number;
  removed: number;
  binary: boolean;
};

type ParsedFileDiff = {
  headerLines: string[];
  hunks: Array<{
    headerLine: string;
    bodyLines: string[];
  }>;
};

function runGitNumstat(cwd: string, staged: boolean): string {
  try {
    return execFileSync(
      "git",
      ["-C", cwd, "diff", ...(staged ? ["--cached"] : []), "--numstat"],
      { encoding: "utf8" },
    );
  } catch {
    return "";
  }
}

function parseNumStat(numStatOutput: string): Array<{
  path: string;
  added: number;
  removed: number;
  binary: boolean;
  oldPath?: string;
}> {
  const lines = numStatOutput.split(/\r?\n/).filter(Boolean);
  return lines.flatMap((line) => {
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(line);
    if (!match) {
      return [];
    }
    const added = match[1] === "-" ? 0 : Number.parseInt(match[1]!, 10);
    const removed = match[2] === "-" ? 0 : Number.parseInt(match[2]!, 10);
    const binary = match[1] === "-" || match[2] === "-";
    const normalized = normalizeNumstatPath(match[3] ?? "");
    return [
      {
        path: normalized.newPath,
        ...(normalized.oldPath ? { oldPath: normalized.oldPath } : {}),
        added,
        removed,
        binary,
      },
    ];
  });
}

function createDiffStatsMap(entries: Array<{ path: string; added: number; removed: number; binary: boolean; oldPath?: string }>): Record<string, DiffStat> {
  const stats: Record<string, DiffStat> = {};
  for (const entry of entries) {
    const value: DiffStat = {
      added: entry.added,
      removed: entry.removed,
      binary: entry.binary,
    };
    stats[entry.path] = value;
    if (entry.oldPath && !stats[entry.oldPath]) {
      stats[entry.oldPath] = value;
    }
  }
  return stats;
}

function normalizeNumstatPath(rawPath: string): { newPath: string; oldPath?: string } {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return { newPath: trimmed };
  }
  if (trimmed.includes("{") && trimmed.includes("=>") && trimmed.includes("}")) {
    const newPath = trimmed.replace(/\{([^{}]+?)\s*=>\s*([^{}]+?)\}/g, (_, _oldPart: string, newPart: string) => newPart.trim());
    const oldPath = trimmed.replace(/\{([^{}]+?)\s*=>\s*([^{}]+?)\}/g, (_, oldPart: string) => oldPart.trim());
    return { newPath, oldPath };
  }
  if (trimmed.includes("=>")) {
    const parts = trimmed.split(/\s*=>\s*/);
    const oldPath = parts[0]?.trim();
    const newPath = parts.at(-1)?.trim();
    if (newPath) {
      return { newPath, ...(oldPath ? { oldPath } : {}) };
    }
  }
  return { newPath: trimmed };
}

function getGitFileStatus(statusChar: string): GitChangedFile["status"] {
  switch (statusChar) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
    case "C":
      return "renamed";
    case "U":
      return "conflicted";
    case "?":
      return "untracked";
    case "M":
    default:
      return "modified";
  }
}

function tryResolveGitRoot(cwd: string): string | null {
  try {
    const root = execFileSync(
      "git",
      ["-C", cwd, "rev-parse", "--show-toplevel"],
      { encoding: "utf8" },
    ).trim();
    return root ? path.resolve(root) : null;
  } catch {
    return null;
  }
}

function getGitCommandCwd(cwd: string): string {
  return tryResolveGitRoot(cwd) ?? cwd;
}

function normalizeComparablePath(value: string): string {
  const resolved = path.resolve(value);
  return resolved.startsWith("/private/var/") ? resolved.slice("/private".length) : resolved;
}

function isPathWithinBase(basePath: string, targetPath: string): boolean {
  const resolvedBase = normalizeComparablePath(basePath);
  const resolvedTarget = normalizeComparablePath(targetPath);
  const relativePath = path.relative(resolvedBase, resolvedTarget);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function tryResolveWithinBase(basePath: string, targetPath: string): string | null {
  const resolvedBase = path.resolve(basePath);
  const resolvedTarget = path.resolve(resolvedBase, targetPath);
  if (!isPathWithinBase(resolvedBase, resolvedTarget)) {
    return null;
  }
  return resolvedTarget;
}

function pathExists(targetPath: string): boolean {
  try {
    statSync(targetPath);
    return true;
  } catch {
    return false;
  }
}

function resolveWorkspacePath(cwd: string, targetPath: string): string {
  const scopeRoot = path.resolve(cwd);
  const cwdCandidate = tryResolveWithinBase(scopeRoot, targetPath);
  const gitRoot = tryResolveGitRoot(cwd);
  const gitRootCandidate =
    gitRoot && path.resolve(gitRoot) !== scopeRoot
      ? path.resolve(gitRoot, targetPath)
      : null;

  if (cwdCandidate && pathExists(cwdCandidate)) {
    return cwdCandidate;
  }
  if (gitRootCandidate && isPathWithinBase(scopeRoot, gitRootCandidate) && pathExists(gitRootCandidate)) {
    return gitRootCandidate;
  }
  if (gitRootCandidate && isPathWithinBase(scopeRoot, gitRootCandidate)) {
    return gitRootCandidate;
  }
  if (cwdCandidate) {
    return cwdCandidate;
  }
  throw new Error("Path must remain inside the workspace.");
}

function toGitPath(cwd: string, targetPath: string): string {
  const gitRoot = tryResolveGitRoot(cwd);
  const resolvedTarget = resolveWorkspacePath(cwd, targetPath);
  const relativeBase = normalizeComparablePath(gitRoot ?? cwd);
  const relativePath = path.relative(relativeBase, normalizeComparablePath(resolvedTarget));
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
  return {
    cwd,
    nodes: readWorkspaceNodes(cwd),
  };
}

export function getCodexGitStatus(cwd: string) {
  return tryReadGitStatus(cwd);
}

export function getCodexGitDiff(
  cwd: string,
  targetPath: string,
  options?: { staged?: boolean; ignoreWhitespace?: boolean },
): string {
  try {
    const gitCwd = getGitCommandCwd(cwd);
    const relativeGitPath = toGitPath(cwd, targetPath);
    const args = ["-C", gitCwd, "diff"];
    if (options?.staged) {
      args.push("--cached");
    }
    if (options?.ignoreWhitespace) {
      args.push("-w");
    }
    args.push("--", relativeGitPath);
    return execFileSync(
      "git",
      args,
      { encoding: "utf8" },
    );
  } catch {
    return "";
  }
}

function parseSingleFileDiff(diffText: string): ParsedFileDiff | null {
  const lines = diffText.split(/\r?\n/);
  const headerLines: string[] = [];
  const hunks: ParsedFileDiff["hunks"] = [];
  let currentHunk: ParsedFileDiff["hunks"][number] | null = null;

  for (const line of lines) {
    if (!line) {
      continue;
    }
    if (line.startsWith("diff --git ") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ")) {
      if (!currentHunk) {
        headerLines.push(line);
      }
      continue;
    }
    if (line.startsWith("@@ ")) {
      currentHunk = {
        headerLine: line,
        bodyLines: [],
      };
      hunks.push(currentHunk);
      continue;
    }
    if (currentHunk) {
      currentHunk.bodyLines.push(line);
    }
  }

  if (headerLines.length === 0 || hunks.length === 0) {
    return null;
  }
  return { headerLines, hunks };
}

function buildSingleHunkPatch(parsed: ParsedFileDiff, hunkIndex: number): string {
  const hunk = parsed.hunks[hunkIndex];
  if (!hunk) {
    throw new Error(`Unknown hunk index ${hunkIndex}`);
  }
  return [...parsed.headerLines, hunk.headerLine, ...hunk.bodyLines, ""].join("\n");
}

function execGitApply(
  cwd: string,
  args: string[],
  patch: string,
): void {
  execFileSync("git", ["-C", cwd, "apply", "--recount", "--whitespace=nowarn", ...args, "-"], {
    input: patch,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function execGitFile(
  cwd: string,
  args: string[],
): void {
  execFileSync("git", ["-C", cwd, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function applyCodexGitFileAction(
  cwd: string,
  request: GitFileActionRequest,
): GitFileActionResponse {
  const gitCwd = getGitCommandCwd(cwd);
  const relativeGitPath = toGitPath(cwd, request.path);
  if (request.action === "stage") {
    execGitFile(gitCwd, ["add", "--", relativeGitPath]);
  } else {
    execGitFile(gitCwd, ["restore", "--staged", "--", relativeGitPath]);
  }
  return {
    sessionId: "",
    path: request.path,
    ...(request.staged !== undefined ? { staged: request.staged } : {}),
    action: request.action,
    ok: true,
  };
}

export function applyCodexGitHunkAction(
  cwd: string,
  request: GitHunkActionRequest,
): GitHunkActionResponse {
  const gitCwd = getGitCommandCwd(cwd);
  const diff = getCodexGitDiff(cwd, request.path, {
    ...(request.staged !== undefined ? { staged: request.staged } : {}),
    ignoreWhitespace: false,
  });
  const parsed = parseSingleFileDiff(diff);
  if (!parsed) {
    throw new Error("No diff available for this file.");
  }
  const patch = buildSingleHunkPatch(parsed, request.hunkIndex);

  if (request.action === "stage") {
    if (request.staged) {
      throw new Error("Hunk is already staged.");
    }
    execGitApply(gitCwd, ["--cached"], patch);
  } else if (request.action === "unstage") {
    if (!request.staged) {
      throw new Error("Only staged hunks can be unstaged.");
    }
    execGitApply(gitCwd, ["--cached", "-R"], patch);
  } else {
    if (request.staged) {
      throw new Error("Revert is only supported for unstaged hunks.");
    }
    execGitApply(gitCwd, ["-R"], patch);
  }

  return {
    sessionId: "",
    path: request.path,
    hunkIndex: request.hunkIndex,
    ...(request.staged !== undefined ? { staged: request.staged } : {}),
    action: request.action,
    ok: true,
  };
}

export function searchWorkspaceFiles(
  cwd: string,
  query: string,
  limit = 100,
): SessionFileSearchItem[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return [];
  }
  try {
    const output = execFileSync("rg", ["--files", "."], {
      cwd,
      encoding: "utf8",
    });
    return output
      .split(/\r?\n/)
      .filter(Boolean)
      .filter((relativePath) => relativePath.toLowerCase().includes(normalizedQuery))
      .slice(0, limit)
      .map((relativePath) => ({
        path: relativePath,
        name: path.basename(relativePath),
        parentPath: path.dirname(relativePath) === "." ? "" : path.dirname(relativePath),
      }));
  } catch {
    return [];
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
