import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { StoredSessionRef } from "@rah/runtime-protocol";
import { readLeadingLines } from "./file-snippets";
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
export type { CodexStoredSessionRecord } from "./codex-stored-session-types";
import type { CodexStoredSessionRecord } from "./codex-stored-session-types";
export {
  createCodexStoredSessionFrozenHistoryPageLoader,
  getCodexStoredSessionHistoryPage,
  replayCodexStoredSessionRollout,
  resumeCodexStoredSession,
} from "./codex-stored-session-history";
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
