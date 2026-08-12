import { readdirSync, readFileSync, statSync } from "node:fs";
import {
  open as openFile,
  readdir as readdirAsync,
  stat as statAsync,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { StoredSessionRef } from "@rah/runtime-protocol";
import { readLeadingLines } from "./file-snippets";
import {
  getCachedStoredSessionHistoryMeta,
  getCachedStoredSessionRef,
  loadStoredSessionMetadataCache,
  setCachedStoredSessionRef,
  writeStoredSessionMetadataCache,
} from "./stored-session-metadata-cache";
import { withHistoryFileMeta } from "./stored-session-history-meta";
export type { CodexStoredSessionRecord } from "./codex-stored-session-types";
import type { CodexStoredSessionRecord } from "./codex-stored-session-types";
export {
  createCodexStoredSessionFrozenHistoryPageLoader,
  getCodexStoredSessionHistoryPage,
  replayCodexStoredSessionRollout,
  resumeCodexStoredSession,
} from "./codex-stored-session-history";
import {
  applyWorkspaceGitFileActionAsync,
  applyWorkspaceGitHunkActionAsync,
  getWorkspaceGitDiffAsync,
  getWorkspaceGitStatusDataAsync,
  getWorkspaceSnapshot,
  readWorkspaceFileDataAsync,
  searchWorkspaceFilesInDirectoryAsync,
} from "./workspace-utils";

const MAX_SEARCH_DEPTH = 4;
const MAX_HEAD_LINES = 64;
export const CODEX_STORED_SESSION_CACHE_VERSION = 5;

export type CodexStoredSessionCatalogScan = {
  records: CodexStoredSessionRecord[];
  complete: boolean;
};

type CodexCatalogScanState = {
  complete: boolean;
};

type CodexStoredSessionParseResult =
  | { kind: "record"; record: CodexStoredSessionRecord }
  | {
      kind: "ignored";
      reason: "internal_subagent" | "no_user_turn";
    }
  | { kind: "invalid" };

function resolveCodexBaseHome(): string {
  return process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
}

export function resolveCodexStoredSessionWatchRoots(): string[] {
  return resolveCodexSearchRoots();
}

function resolveCodexSearchRoots(): string[] {
  const home = resolveCodexBaseHome();
  return [path.join(home, "sessions"), path.join(home, "archived_sessions")];
}

function resolveCodexHomes(): string[] {
  return [resolveCodexBaseHome()];
}

function isPathInsideDirectory(candidatePath: string, directory: string): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(candidatePath));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function isCodexStoredSessionArchivedPath(filePath: string): boolean {
  return resolveCodexHomes().some((home) =>
    isPathInsideDirectory(filePath, path.join(home, "archived_sessions")),
  );
}

function withCodexArchivedProviderState(ref: StoredSessionRef, archived: boolean): StoredSessionRef {
  const current = ref.providerState ?? {};
  if (archived) {
    if (current.archived === true) {
      return ref;
    }
    return {
      ...ref,
      providerState: {
        ...current,
        archived: true,
      },
    };
  }
  if (current.archived !== true) {
    return ref;
  }
  const { archived: _archived, archivedAt: _archivedAt, ...rest } = current;
  void _archived;
  void _archivedAt;
  const { providerState: _providerState, ...withoutProviderState } = ref;
  void _providerState;
  return {
    ...withoutProviderState,
    ...(Object.keys(rest).length > 0 ? { providerState: rest } : {}),
  };
}

function readHeadLines(filePath: string, maxBytes = 512 * 1024): string[] {
  return readLeadingLines(filePath, { maxBytes, maxLines: MAX_HEAD_LINES });
}

async function readHeadLinesAsync(
  filePath: string,
  maxBytes = 512 * 1024,
): Promise<string[]> {
  const handle = await openFile(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer
      .subarray(0, bytesRead)
      .toString("utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, MAX_HEAD_LINES);
  } finally {
    await handle.close();
  }
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

function isCodexSubagentSource(value: unknown): boolean {
  if (typeof value === "string") {
    return value.toLowerCase().includes("subagent");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return Object.keys(value).some((key) =>
    key.toLowerCase().includes("subagent"),
  );
}

function isCodexInternalSubagentSession(payload: Record<string, unknown>): boolean {
  return (
    isCodexSubagentSource(payload.thread_source) ||
    isCodexSubagentSource(payload.source)
  );
}

function listRolloutFiles(
  root: string,
  options?: {
    requiredRoot?: boolean;
    scanState?: CodexCatalogScanState;
  },
): string[] {
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  const files: string[] = [];
  while (queue.length > 0) {
    const current = queue.pop()!;
    let entries;
    try {
      entries = readdirSync(current.dir, { withFileTypes: true });
    } catch {
      if (
        options?.scanState &&
        (current.depth > 0 || options.requiredRoot === true)
      ) {
        options.scanState.complete = false;
      }
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current.dir, entry.name);
      if (entry.isFile()) {
        if (entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
          files.push(fullPath);
        }
        continue;
      }
      if (entry.isDirectory() && current.depth < MAX_SEARCH_DEPTH) {
        queue.push({ dir: fullPath, depth: current.depth + 1 });
      }
    }
  }
  // Rollout paths contain YYYY/MM/DD and an ISO-like timestamp in the file
  // name. Sorting the complete path therefore selects the newest files
  // deterministically instead of depending on filesystem readdir order.
  return files.sort((left, right) => right.localeCompare(left));
}

function parseStoredSessionHead(options: {
  filePath: string;
  head: readonly string[];
  size: number;
  mtime: Date;
  archived: boolean;
  requireUserTurn?: boolean;
}): CodexStoredSessionParseResult {
  const { filePath, head, size, mtime, archived } = options;
  let sessionId: string | null = null;
  let cwd: string | undefined;
  let createdAt: string | undefined;
  let firstUserMessage: string | null = null;
  let hasUserTurn = false;

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
      // A forked rollout starts with metadata for the child thread and can then
      // contain copied parent session_meta records. The first valid record owns
      // the file; later records are transcript history, never catalog identity.
      if (sessionId !== null) {
        continue;
      }
      const payload =
        record.payload && typeof record.payload === "object" && !Array.isArray(record.payload)
          ? (record.payload as Record<string, unknown>)
          : null;
      if (!payload || typeof payload.id !== "string" || !payload.id.trim()) {
        continue;
      }
      // Codex persists internal multi-agent workers as independent rollout
      // files so their execution can be recovered and inspected from the
      // parent task. They are not user-owned tasks and Codex Desktop does not
      // publish them in its task library. Keep the rollout on disk, but stop
      // it at the provider catalog boundary so every RAH surface shares the
      // same visible-session identity model.
      if (isCodexInternalSubagentSession(payload)) {
        return { kind: "ignored", reason: "internal_subagent" };
      }
      // Every user-owned Codex Desktop root is part of the provider catalog,
      // including roots whose provider originator is "codex_work_desktop".
      // `originator` identifies the creating surface, not whether the user
      // owns the thread. Internal subagents were rejected above using their
      // explicit source metadata.
      sessionId = payload.id;
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
      record.type === "event_msg" &&
      payload?.type === "user_message" &&
      typeof payload.message === "string"
    ) {
      const text = payload.message.trim();
      if (text && !isCodexBootstrapUserMessage(text)) {
        // Older Codex rollouts persisted the canonical prompt as an
        // event_msg rather than a response_item. It is still a real user
        // turn and must keep that historical Session visible.
        hasUserTurn = true;
        firstUserMessage = text;
        break;
      }
    }
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
        hasUserTurn = true;
        firstUserMessage = text;
        break;
      }
      if (
        payload.content.some(
          (item) =>
            item !== null &&
            typeof item === "object" &&
            !Array.isArray(item) &&
            (item as Record<string, unknown>).type !== "input_text",
        )
      ) {
        // Image/file-only prompts are still real user turns even when there is
        // no text available for the catalog preview.
        hasUserTurn = true;
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
    return { kind: "invalid" };
  }
  // Codex creates the rollout and title-index row before the first prompt is
  // durably accepted. A launch failure can therefore leave a metadata-only
  // file that looks named but has no conversation. Codex Desktop does not
  // publish these shells as tasks, so reject them at the provider boundary.
  if (!hasUserTurn && options.requireUserTurn !== false) {
    return { kind: "ignored", reason: "no_user_turn" };
  }

  const preview = firstUserMessage ? truncateText(firstUserMessage) : "Untitled";
  return {
    kind: "record",
    record: {
      ref: {
        provider: "codex",
        providerSessionId: sessionId,
        ...(cwd ? { cwd } : {}),
        ...(cwd ? { rootDir: cwd } : {}),
        title: truncateText(preview, 72),
        preview,
        ...(createdAt ? { createdAt } : {}),
        updatedAt: mtime.toISOString(),
        historyMeta: { bytes: size },
        ...(archived ? { providerState: { archived: true } } : {}),
        source: "provider_history",
        removalDisposition: "trash",
      },
      rolloutPath: filePath,
      archived,
    },
  };
}

function parseStoredSessionRecord(filePath: string): CodexStoredSessionParseResult {
  const stats = statSync(filePath);
  return parseStoredSessionHead({
    filePath,
    head: readHeadLines(filePath),
    size: stats.size,
    mtime: stats.mtime,
    archived: isCodexStoredSessionArchivedPath(filePath),
  });
}

function codexDateSegmentsNear(timestampMs: number): string[] {
  const anchor = Number.isFinite(timestampMs) ? timestampMs : Date.now();
  const segments = new Set<string>();
  const pad = (value: number) => String(value).padStart(2, "0");
  for (const dayOffset of [-1, 0, 1]) {
    const date = new Date(anchor + dayOffset * 24 * 60 * 60 * 1_000);
    segments.add(
      path.join(
        String(date.getFullYear()),
        pad(date.getMonth() + 1),
        pad(date.getDate()),
      ),
    );
    segments.add(
      path.join(
        String(date.getUTCFullYear()),
        pad(date.getUTCMonth() + 1),
        pad(date.getUTCDate()),
      ),
    );
  }
  return [...segments];
}

/**
 * Resolve a newly launched Codex task without scanning the provider's complete
 * history tree.
 *
 * Codex embeds the provider session UUID in the rollout filename and stores
 * new rollouts below a YYYY/MM/DD directory. Looking only in the local/UTC
 * startup-day window turns live attachment into a bounded lookup independent
 * of the size of ~/.codex/sessions. Older resumed tasks are expected to
 * already be present in the persisted catalog; a miss here may still request
 * the low-priority full reconciliation path.
 */
export async function resolveCodexStoredSessionRecordNearStartup(options: {
  providerSessionId: string;
  startupTimestampMs: number;
  codexHome?: string;
}): Promise<CodexStoredSessionRecord | undefined> {
  const providerSessionId = options.providerSessionId.trim();
  if (!providerSessionId) {
    return undefined;
  }
  const codexHome =
    options.codexHome?.trim() || process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const suffix = `-${providerSessionId}.jsonl`;
  const candidates: CodexStoredSessionRecord[] = [];

  for (const rootName of ["sessions", "archived_sessions"] as const) {
    const archived = rootName === "archived_sessions";
    for (const dateSegment of codexDateSegmentsNear(options.startupTimestampMs)) {
      const directory = path.join(codexHome, rootName, dateSegment);
      let entries;
      try {
        entries = await readdirAsync(directory, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (
          !entry.isFile() ||
          !entry.name.startsWith("rollout-") ||
          !entry.name.endsWith(suffix)
        ) {
          continue;
        }
        const filePath = path.join(directory, entry.name);
        try {
          const [head, stats] = await Promise.all([
            readHeadLinesAsync(filePath),
            statAsync(filePath),
          ]);
          const parsed = parseStoredSessionHead({
            filePath,
            head,
            size: stats.size,
            mtime: stats.mtime,
            archived,
            // Native TUI startup must bind the provider identity before the
            // first prompt is accepted. This bounded lookup is not a catalog
            // visibility decision; the full catalog still requires a user
            // turn and will discard a launch shell after the live runtime is
            // gone.
            requireUserTurn: false,
          });
          if (
            parsed.kind === "record" &&
            parsed.record.ref.providerSessionId === providerSessionId
          ) {
            candidates.push(parsed.record);
          }
        } catch {
          // Codex may still be creating the rollout. The native mirror retries
          // this bounded lookup, so a transient partial file is not terminal.
        }
      }
    }
  }

  return candidates.reduce<CodexStoredSessionRecord | undefined>(
    (preferred, candidate) =>
      preferCodexStoredSessionRecord(preferred, candidate),
    undefined,
  );
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

function loadCodexThreadTitleIndex(): Map<string, string> {
  const titles = new Map<string, string>();
  for (const home of resolveCodexHomes()) {
    const indexPath = path.join(home, "session_index.jsonl");
    let content: string;
    try {
      content = readFileSync(indexPath, "utf8");
    } catch {
      continue;
    }
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        if (
          typeof parsed.id === "string" &&
          typeof parsed.thread_name === "string" &&
          parsed.thread_name.trim()
        ) {
          titles.set(parsed.id, parsed.thread_name.trim());
        }
      } catch {
        continue;
      }
    }
  }
  return titles;
}

function preferCodexStoredSessionRecord(
  current: CodexStoredSessionRecord | undefined,
  next: CodexStoredSessionRecord,
): CodexStoredSessionRecord {
  if (!current) {
    return next;
  }
  if (current.archived !== next.archived) {
    return next.archived ? current : next;
  }
  const currentUpdatedAt = Date.parse(current.ref.updatedAt ?? "");
  const nextUpdatedAt = Date.parse(next.ref.updatedAt ?? "");
  if (Number.isFinite(currentUpdatedAt) && Number.isFinite(nextUpdatedAt)) {
    return nextUpdatedAt > currentUpdatedAt ? next : current;
  }
  return (next.ref.updatedAt ?? "").localeCompare(current.ref.updatedAt ?? "") > 0 ? next : current;
}

function setPreferredCodexStoredSessionRecord(
  records: Map<string, CodexStoredSessionRecord>,
  record: CodexStoredSessionRecord,
): void {
  records.set(
    record.ref.providerSessionId,
    preferCodexStoredSessionRecord(records.get(record.ref.providerSessionId), record),
  );
}

function discoverCodexStoredSessionsImpl(
  scanState?: CodexCatalogScanState,
): CodexStoredSessionRecord[] {
  const cache = loadStoredSessionMetadataCache("codex");
  const renamedTitles = loadCodexThreadTitleIndex();
  const records = new Map<string, CodexStoredSessionRecord>();
  const roots = resolveCodexSearchRoots();
  for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
    const root = roots[rootIndex]!;
    for (const file of listRolloutFiles(root, {
      // The active sessions directory is the authoritative Codex history
      // root. archived_sessions is optional until Codex creates it.
      requiredRoot: rootIndex === 0,
      ...(scanState ? { scanState } : {}),
    })) {
      const stats = statSync(file);
      const archived = isCodexStoredSessionArchivedPath(file);
      const cachedHistoryMeta = getCachedStoredSessionHistoryMeta({
        cache,
        filePath: file,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
      });
      const cachedRef = getCachedStoredSessionRef({
        cache,
        filePath: file,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        version: CODEX_STORED_SESSION_CACHE_VERSION,
      });
      if (cachedRef && !shouldInvalidateCachedCodexTitle(cachedRef, file)) {
        const createdAtResult = !cachedRef.createdAt
          ? parseStoredSessionRecord(file)
          : null;
        const createdAtRecord =
          createdAtResult?.kind === "record" ? createdAtResult.record : null;
        const renamedTitle = renamedTitles.get(cachedRef.providerSessionId);
        const baseRef =
          renamedTitle && renamedTitle !== cachedRef.title
            ? {
                ...cachedRef,
                title: renamedTitle,
                ...(createdAtRecord?.ref.createdAt
                  ? { createdAt: createdAtRecord.ref.createdAt }
                  : {}),
              }
            : createdAtRecord?.ref.createdAt
              ? {
                  ...cachedRef,
                  createdAt: createdAtRecord.ref.createdAt,
                }
              : cachedRef;
        const refWithHistoryMeta = cachedHistoryMeta
          ? { ...baseRef, historyMeta: cachedHistoryMeta }
          : withHistoryFileMeta(baseRef, file, stats);
        const nextRef = withCodexArchivedProviderState(refWithHistoryMeta, archived);
        if (nextRef !== cachedRef) {
          setCachedStoredSessionRef({
            cache,
            filePath: file,
            size: stats.size,
            mtimeMs: stats.mtimeMs,
            ref: nextRef,
            version: CODEX_STORED_SESSION_CACHE_VERSION,
          });
        }
        setPreferredCodexStoredSessionRecord(records, {
          ref: nextRef,
          rolloutPath: file,
          archived,
        });
        continue;
      }
      const parsedResult = parseStoredSessionRecord(file);
      if (parsedResult.kind === "ignored") {
        continue;
      }
      if (parsedResult.kind === "invalid") {
        if (scanState) {
          // A provider file may be in the middle of an atomic rewrite, and
          // the metadata cache may itself have been rebuilt or removed.
          // Absence from this scan is therefore never deletion evidence.
          scanState.complete = false;
        }
        continue;
      }
      const parsed = parsedResult.record;
      const renamedTitle = renamedTitles.get(parsed.ref.providerSessionId);
      if (renamedTitle) {
        parsed.ref = {
          ...parsed.ref,
          title: renamedTitle,
        };
      }
      parsed.ref = cachedHistoryMeta
        ? { ...parsed.ref, historyMeta: cachedHistoryMeta }
        : withHistoryFileMeta(parsed.ref, file, stats);
      setCachedStoredSessionRef({
        cache,
        filePath: file,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        ref: parsed.ref,
        version: CODEX_STORED_SESSION_CACHE_VERSION,
      });
      setPreferredCodexStoredSessionRecord(records, parsed);
    }
  }
  if (!scanState || scanState.complete) {
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
              version: CODEX_STORED_SESSION_CACHE_VERSION,
            },
          ] as const;
        }),
      ),
    );
  }
  return [...records.values()].sort((a, b) =>
    (b.ref.updatedAt ?? "").localeCompare(a.ref.updatedAt ?? ""),
  );
}

export function discoverCodexStoredSessions(): CodexStoredSessionRecord[] {
  return discoverCodexStoredSessionsImpl();
}

export function scanCodexStoredSessionCatalog(): CodexStoredSessionCatalogScan {
  const scanState: CodexCatalogScanState = { complete: true };
  const records = discoverCodexStoredSessionsImpl(scanState);
  return { records, complete: scanState.complete };
}

export function findCodexStoredSessionRecord(
  providerSessionId: string,
): CodexStoredSessionRecord | undefined {
  return discoverCodexStoredSessions().find(
    (record) => record.ref.providerSessionId === providerSessionId,
  );
}

export function patchCodexStoredSessionTitle(
  providerSessionId: string,
  title: string,
): CodexStoredSessionRecord | undefined {
  const record = findCodexStoredSessionRecord(providerSessionId);
  if (!record) {
    return undefined;
  }
  record.ref = {
    ...record.ref,
    title,
  };
  const stats = statSync(record.rolloutPath);
  const cache = loadStoredSessionMetadataCache("codex");
  setCachedStoredSessionRef({
    cache,
    filePath: record.rolloutPath,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ref: record.ref,
    version: CODEX_STORED_SESSION_CACHE_VERSION,
  });
  writeStoredSessionMetadataCache("codex", cache);
  return record;
}

export function getCodexWorkspaceSnapshot(cwd: string) {
  return getWorkspaceSnapshot(cwd);
}

export async function getCodexGitStatus(
  cwd: string,
  options?: { scopeRoot?: string; baseBranch?: string },
) {
  return await getWorkspaceGitStatusDataAsync(cwd, options);
}

export async function getCodexGitDiff(
  cwd: string,
  targetPath: string,
  options?: {
    staged?: boolean;
    ignoreWhitespace?: boolean;
    scopeRoot?: string;
    baseBranch?: string;
  },
): Promise<string> {
  return await getWorkspaceGitDiffAsync(cwd, targetPath, options);
}

export async function applyCodexGitFileAction(
  cwd: string,
  request: Parameters<typeof applyWorkspaceGitFileActionAsync>[1],
  options?: { scopeRoot?: string },
) {
  return await applyWorkspaceGitFileActionAsync(cwd, request, options);
}

export async function applyCodexGitHunkAction(
  cwd: string,
  request: Parameters<typeof applyWorkspaceGitHunkActionAsync>[1],
  options?: { scopeRoot?: string },
) {
  return await applyWorkspaceGitHunkActionAsync(cwd, request, options);
}

export async function searchWorkspaceFiles(cwd: string, query: string, limit = 100) {
  return await searchWorkspaceFilesInDirectoryAsync(cwd, query, limit);
}

export async function readWorkspaceFile(
  cwd: string,
  targetPath: string,
  options?: { scopeRoot?: string },
) {
  return await readWorkspaceFileDataAsync(cwd, targetPath, options);
}
