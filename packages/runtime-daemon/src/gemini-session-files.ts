import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { StoredSessionRef } from "@rah/runtime-protocol";
import { readTextRange } from "./file-snippets";
export type { GeminiStoredSessionRecord } from "./gemini-session-types";
import type {
  GeminiConversationRecord,
  GeminiStoredSessionRecord,
} from "./gemini-session-types";
export {
  createGeminiStoredSessionFrozenHistoryPageLoader,
  getGeminiStoredSessionHistoryPage,
  resumeGeminiStoredSession,
} from "./gemini-session-history";
import {
  extractGeminiUserDisplayText,
  loadGeminiConversationRecord,
  truncateText,
} from "./gemini-conversation-utils";
import {
  getCachedStoredSessionRef,
  loadStoredSessionMetadataCache,
  setCachedStoredSessionRef,
  writeStoredSessionMetadataCache,
} from "./stored-session-metadata-cache";
import { withHistoryFileMeta, withHistoryMeta } from "./stored-session-history-meta";

const SESSION_FILE_PREFIX = "session-";
const GEMINI_STORED_SESSION_CACHE_VERSION = 2;

function resolveGeminiHome(): string {
  return process.env.GEMINI_CLI_HOME ?? path.join(os.homedir(), ".gemini");
}

export function resolveGeminiStoredSessionWatchRoots(): string[] {
  return [path.join(resolveGeminiHome(), "tmp")];
}

function normalizeDirectory(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const withoutTrailing = trimmed.replace(/[\\/]+$/, "");
  if (withoutTrailing.startsWith("/private/var/")) {
    return withoutTrailing.slice("/private".length);
  }
  return withoutTrailing;
}

function getProjectHash(projectRoot: string): string {
  return createHash("sha256").update(projectRoot).digest("hex");
}

function getChatsDirForCwd(cwd: string): string {
  return path.join(resolveGeminiHome(), "tmp", getProjectHash(cwd), "chats");
}

function listGeminiSessionFiles(chatsDir: string): string[] {
  try {
    return readdirSync(chatsDir)
      .filter((entry) => entry.startsWith(SESSION_FILE_PREFIX))
      .filter((entry) => entry.endsWith(".json") || entry.endsWith(".jsonl"))
      .map((entry) => path.join(chatsDir, entry))
      .sort();
  } catch {
    return [];
  }
}

function scanGeminiChatsDirs(): string[] {
  const tmpRoot = path.join(resolveGeminiHome(), "tmp");
  try {
    return readdirSync(tmpRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(tmpRoot, entry.name, "chats"))
      .filter((candidate) => {
        try {
          return statSync(candidate).isDirectory();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

type GeminiProjectIndices = {
  hashIndex: Map<string, string>;
  aliasIndex: Map<string, string>;
  knownRoots: string[];
};

type RahStoredSessionCacheEntry = {
  ref?: {
    cwd?: string;
    rootDir?: string;
  };
};

type GeminiProjectDirectories = {
  cwd?: string;
  rootDir: string;
};

const GEMINI_ABSOLUTE_PATH_HINT_PATTERN = /\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]+/g;
const GEMINI_GENERIC_ANCESTOR_NAMES = new Set([
  "src",
  "lib",
  "bin",
  "source",
  "docs",
  "doc",
  "test",
  "tests",
  "spec",
  "specs",
  "plans",
  "scripts",
  "examples",
  "example",
  "crates",
  "packages",
  "pkg",
  "cmd",
  "chat",
  "chats",
  "tmp",
  "temp",
  "build",
  "dist",
  "out",
  "target",
  "dev",
  "mobile",
]);

function loadGeminiProjectIndices(): GeminiProjectIndices {
  const filePath = path.join(resolveGeminiHome(), "projects.json");
  const hashIndex = new Map<string, string>();
  const aliasIndex = new Map<string, string>();
  const knownRoots: string[] = [];
  const addRoot = (rawRoot: string | undefined, sourceAlias?: string) => {
    const normalized = normalizeDirectory(rawRoot);
    if (!normalized) {
      return;
    }
    const register = (candidate: string | null) => {
      if (!candidate) {
        return;
      }
      const hash = getProjectHash(candidate);
      if (!hashIndex.has(hash)) {
        hashIndex.set(hash, candidate);
      }
      if (!knownRoots.includes(candidate)) {
        knownRoots.push(candidate);
      }
    };
    register(normalized);
    try {
      register(normalizeDirectory(realpathSync(normalized)));
    } catch {}
    if (normalized.startsWith("/var/")) {
      register(`/private${normalized}`);
    } else if (normalized.startsWith("/private/var/")) {
      register(normalized.slice("/private".length));
    }
    if (sourceAlias) {
      const normalizedAlias = sourceAlias.trim();
      if (normalizedAlias) {
        aliasIndex.set(normalizedAlias, normalized);
      }
    }
  };
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as {
      projects?: Record<string, string>;
    };
    for (const [projectRoot, alias] of Object.entries(parsed.projects ?? {})) {
      addRoot(projectRoot, typeof alias === "string" ? alias : undefined);
    }
  } catch {}

  const rahHome = process.env.RAH_HOME ?? path.join(os.homedir(), ".rah", "runtime-daemon");
  try {
    const workbenchState = JSON.parse(
      readFileSync(path.join(rahHome, "workbench-state.json"), "utf8"),
    ) as {
      workspaces?: string[];
      hiddenWorkspaces?: string[];
      activeWorkspaceDir?: string;
    };
    for (const workspace of workbenchState.workspaces ?? []) {
      addRoot(workspace);
    }
    for (const workspace of workbenchState.hiddenWorkspaces ?? []) {
      addRoot(workspace);
    }
    if (typeof workbenchState.activeWorkspaceDir === "string") {
      addRoot(workbenchState.activeWorkspaceDir);
    }
  } catch {}

  const storedSessionCacheDir = path.join(rahHome, "stored-session-cache");
  try {
    for (const entry of readdirSync(storedSessionCacheDir)) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      const parsed = JSON.parse(
        readFileSync(path.join(storedSessionCacheDir, entry), "utf8"),
      ) as {
        entries?: Record<string, RahStoredSessionCacheEntry>;
      };
      for (const cacheEntry of Object.values(parsed.entries ?? {})) {
        addRoot(cacheEntry.ref?.cwd);
        addRoot(cacheEntry.ref?.rootDir);
      }
    }
  } catch {}

  knownRoots.sort((left, right) => right.length - left.length);
  return { hashIndex, aliasIndex, knownRoots };
}

function isGeminiPathHintIgnored(candidate: string): boolean {
  const normalized = normalizeDirectory(candidate);
  if (!normalized) {
    return true;
  }
  const geminiTmpRoot = normalizeDirectory(path.join(resolveGeminiHome(), "tmp"));
  if (geminiTmpRoot && (normalized === geminiTmpRoot || normalized.startsWith(`${geminiTmpRoot}/`))) {
    return true;
  }
  return normalized.includes("/.tmp") || normalized.includes("/tmp/");
}

function trimGeminiPathHint(raw: string): string {
  let value = raw.trim();
  while (value.length > 1 && /[.,:;)\]}`\\]$/.test(value)) {
    value = value.slice(0, -1);
  }
  return value;
}

function inferGeminiHintDirectory(candidate: string): string {
  const normalized = normalizeDirectory(candidate) ?? candidate;
  try {
    const stats = statSync(normalized);
    return stats.isDirectory() ? normalized : path.dirname(normalized);
  } catch {
    const basename = path.basename(normalized);
    if (basename.startsWith(".") || basename.includes(".")) {
      return path.dirname(normalized);
    }
    return normalized;
  }
}

function listGeminiRecoverableAncestors(directory: string): string[] {
  const homeDir = normalizeDirectory(os.homedir());
  const rejected = new Set<string>([
    "/Users",
    "/home",
    ...(homeDir
      ? [
          homeDir,
          path.join(homeDir, "Code"),
          path.join(homeDir, "Code", "repos"),
          path.join(homeDir, "Desktop"),
          path.join(homeDir, "Desktop", "DEV"),
          path.join(homeDir, "Downloads"),
          path.join(homeDir, "Library"),
          path.join(homeDir, "Library", "Mobile"),
          path.join(homeDir, "Library", "Mobile Documents"),
          path.join(homeDir, ".config"),
        ]
      : []),
  ]);
  const ancestors: string[] = [];
  let current = normalizeDirectory(directory);
  while (current && !rejected.has(current)) {
    const parsed = path.parse(current);
    if (parsed.dir === current) {
      break;
    }
    if (current.split("/").filter(Boolean).length >= 4) {
      const tail = path.basename(current).toLowerCase();
      if (!tail.startsWith(".") && !GEMINI_GENERIC_ANCESTOR_NAMES.has(tail)) {
        ancestors.push(current);
      }
    }
    current = normalizeDirectory(path.dirname(current));
  }
  return ancestors;
}

function resolveGeminiProjectDirectoriesFromRoot(rootDir: string | null): GeminiProjectDirectories | null {
  if (!rootDir) {
    return null;
  }
  try {
    if (statSync(rootDir).isDirectory()) {
      return { cwd: rootDir, rootDir };
    }
  } catch {}
  return { rootDir };
}

function inferGeminiProjectRootFromHintTexts(
  texts: readonly string[],
  projectIndices: GeminiProjectIndices,
): string | null {
  const matchingKnownRoots = new Map<string, number>();
  const ancestorVotes = new Map<string, number>();
  for (const text of texts) {
    for (const raw of text.match(GEMINI_ABSOLUTE_PATH_HINT_PATTERN) ?? []) {
      const trimmed = trimGeminiPathHint(raw);
      if (isGeminiPathHintIgnored(trimmed)) {
        continue;
      }
      const knownRoot = projectIndices.knownRoots.find(
        (root) => trimmed === root || trimmed.startsWith(`${root}/`),
      );
      if (knownRoot) {
        matchingKnownRoots.set(knownRoot, (matchingKnownRoots.get(knownRoot) ?? 0) + 1);
        continue;
      }
      const hintedDirectory = inferGeminiHintDirectory(trimmed);
      for (const ancestor of listGeminiRecoverableAncestors(hintedDirectory)) {
        ancestorVotes.set(ancestor, (ancestorVotes.get(ancestor) ?? 0) + 1);
      }
    }
  }
  if (matchingKnownRoots.size > 0) {
    return [...matchingKnownRoots.entries()].sort(
      (left, right) => right[1] - left[1] || right[0].length - left[0].length,
    )[0]?.[0] ?? null;
  }
  if (ancestorVotes.size > 0) {
    return [...ancestorVotes.entries()].sort(
      (left, right) => right[1] - left[1] || right[0].length - left[0].length,
    )[0]?.[0] ?? null;
  }
  return null;
}

function resolveGeminiProjectDirectories(
  conversation: GeminiConversationRecord,
  filePath: string,
  projectIndices: GeminiProjectIndices,
  inferredRootCache: Map<string, GeminiProjectDirectories | null>,
): GeminiProjectDirectories | null {
  const projectDir = path.dirname(path.dirname(filePath));
  try {
    const explicit = normalizeDirectory(readFileSync(path.join(projectDir, ".project_root"), "utf8"));
    const explicitDirectories = resolveGeminiProjectDirectoriesFromRoot(explicit);
    if (explicitDirectories) {
      return explicitDirectories;
    }
  } catch {}
  const hashedDirectories = resolveGeminiProjectDirectoriesFromRoot(
    projectIndices.hashIndex.get(conversation.projectHash) ?? null,
  );
  if (hashedDirectories) {
    return hashedDirectories;
  }
  const aliasDirectories = resolveGeminiProjectDirectoriesFromRoot(
    projectIndices.aliasIndex.get(path.basename(projectDir)) ?? null,
  );
  if (aliasDirectories) {
    return aliasDirectories;
  }
  if (inferredRootCache.has(projectDir)) {
    return inferredRootCache.get(projectDir) ?? null;
  }
  const hintTexts = [
    readTextRange(filePath, { startOffset: 0, endOffset: 256 * 1024 }),
    (() => {
      try {
        return readTextRange(path.join(projectDir, "logs.json"), {
          startOffset: 0,
          endOffset: 128 * 1024,
        });
      } catch {
        return "";
      }
    })(),
  ].filter((value) => value.length > 0);
  const inferredDirectories = resolveGeminiProjectDirectoriesFromRoot(
    inferGeminiProjectRootFromHintTexts(hintTexts, projectIndices),
  );
  inferredRootCache.set(projectDir, inferredDirectories);
  return inferredDirectories;
}

function buildStoredSessionRef(
  conversation: GeminiConversationRecord,
  filePath: string,
  projectIndices: GeminiProjectIndices,
  inferredRootCache: Map<string, GeminiProjectDirectories | null>,
): StoredSessionRef {
  const firstUserMessage = conversation.messages.find((message) => message.type === "user");
  const preview = truncateText(
    (firstUserMessage ? extractGeminiUserDisplayText(firstUserMessage) : "") ||
      "Gemini conversation",
  );
  const stat = statSync(filePath);
  const projectDirectories = resolveGeminiProjectDirectories(
    conversation,
    filePath,
    projectIndices,
    inferredRootCache,
  );
  return withHistoryMeta({
    provider: "gemini",
    providerSessionId: conversation.sessionId,
    ...(projectDirectories ?? {}),
    title: truncateText(preview, 72),
    preview,
    ...(conversation.startTime ? { createdAt: conversation.startTime } : {}),
    updatedAt: conversation.lastUpdated || stat.mtime.toISOString(),
    source: "provider_history",
  }, {
    bytes: stat.size,
    messages: conversation.messages.length,
  });
}

export function discoverGeminiStoredSessions(): GeminiStoredSessionRecord[] {
  const cache = loadStoredSessionMetadataCache("gemini");
  const projectIndices = loadGeminiProjectIndices();
  const inferredRootCache = new Map<string, GeminiProjectDirectories | null>();
  const records = new Map<string, GeminiStoredSessionRecord>();
  for (const chatsDir of scanGeminiChatsDirs()) {
    for (const filePath of listGeminiSessionFiles(chatsDir)) {
      const stats = statSync(filePath);
      const cachedRef = getCachedStoredSessionRef({
        cache,
        filePath,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        version: GEMINI_STORED_SESSION_CACHE_VERSION,
      });
      if (cachedRef && (cachedRef.cwd || cachedRef.rootDir)) {
        const conversation =
          !cachedRef.createdAt ? loadGeminiConversationRecord(filePath) : null;
        const nextRef = withHistoryFileMeta(
          conversation?.startTime
            ? {
                ...cachedRef,
                createdAt: conversation.startTime,
              }
            : cachedRef,
          filePath,
          stats,
          conversation?.messages.length !== undefined
            ? { messages: conversation.messages.length }
            : undefined,
        );
        if (nextRef !== cachedRef) {
          setCachedStoredSessionRef({
            cache,
            filePath,
            size: stats.size,
            mtimeMs: stats.mtimeMs,
            ref: nextRef,
            version: GEMINI_STORED_SESSION_CACHE_VERSION,
          });
        }
        records.set(nextRef.providerSessionId, {
          ref: nextRef,
          filePath,
          conversation: {
            sessionId: nextRef.providerSessionId,
            projectHash: "",
            startTime:
              nextRef.createdAt ?? nextRef.updatedAt ?? new Date(stats.mtimeMs).toISOString(),
            lastUpdated: nextRef.updatedAt ?? new Date(stats.mtimeMs).toISOString(),
            messages: [],
          },
        });
        continue;
      }
      const conversation = loadGeminiConversationRecord(filePath);
      if (!conversation || conversation.kind === "subagent" || conversation.messages.length === 0) {
        continue;
      }
      const ref = buildStoredSessionRef(conversation, filePath, projectIndices, inferredRootCache);
      setCachedStoredSessionRef({
        cache,
        filePath,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        ref,
        version: GEMINI_STORED_SESSION_CACHE_VERSION,
      });
      records.set(conversation.sessionId, {
        ref,
        filePath,
        conversation,
      });
    }
  }
  writeStoredSessionMetadataCache(
    "gemini",
    new Map(
      [...records.values()].map((record) => {
        const stats = statSync(record.filePath);
        return [
          record.filePath,
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

export function hydrateGeminiStoredSessionRecord(
  record: GeminiStoredSessionRecord,
): GeminiStoredSessionRecord {
  if (record.conversation.messages.length > 0) {
    return record;
  }
  const conversation = loadGeminiConversationRecord(record.filePath);
  if (!conversation) {
    return record;
  }
  return {
    ...record,
    conversation,
  };
}

export function isGeminiStoredSessionRecordResumable(
  record: GeminiStoredSessionRecord,
): boolean {
  const hydrated = hydrateGeminiStoredSessionRecord(record);
  return hydrated.conversation.messages.some(
    (message) => message.type === "user" || message.type === "gemini",
  );
}

export function findGeminiStoredSessionRecord(
  providerSessionId: string,
  cwd?: string,
): GeminiStoredSessionRecord | null {
  if (cwd) {
    const projectIndices = loadGeminiProjectIndices();
    const inferredRootCache = new Map<string, GeminiProjectDirectories | null>();
    for (const filePath of listGeminiSessionFiles(getChatsDirForCwd(cwd))) {
      const conversation = loadGeminiConversationRecord(filePath);
      if (conversation?.sessionId === providerSessionId) {
        return {
          ref: buildStoredSessionRef(conversation, filePath, projectIndices, inferredRootCache),
          filePath,
          conversation,
        };
      }
    }
  }

  for (const record of discoverGeminiStoredSessions()) {
    if (record.ref.providerSessionId === providerSessionId) {
      return hydrateGeminiStoredSessionRecord(record);
    }
  }
  return null;
}
