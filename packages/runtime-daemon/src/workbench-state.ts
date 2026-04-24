import { mkdir, rename, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { StoredSessionRef } from "@rah/runtime-protocol";
import type { StoredSessionState } from "./session-store";

const SNAPSHOT_FILE = "workbench-state.json";
const STORAGE_VERSION = 2;
const RECENT_SESSION_LIMIT = 15;

interface WorkbenchStateFile {
  version: number;
  updatedAt: string;
  activeWorkspaceDir?: string;
  workspaces: string[];
  hiddenWorkspaces?: string[];
  hiddenSessionKeys?: string[];
  sessionTitleOverrides?: Record<string, string>;
  pendingSessionTitleOverrides?: Record<string, string>;
  sessions: StoredSessionRef[];
  recentSessions: StoredSessionRef[];
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

function uniqueDirectoriesInOrder(values: readonly string[]): string[] {
  const directories: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeDirectory(value);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      directories.push(normalized);
    }
  }
  return directories;
}

function filterHiddenDirectories(
  values: readonly string[],
  hiddenWorkspaces: readonly string[],
): string[] {
  const hidden = new Set(uniqueDirectoriesInOrder(hiddenWorkspaces));
  return uniqueDirectoriesInOrder(values).filter((directory) => !hidden.has(directory));
}

function uniqueStringsInOrder(values: readonly string[]): string[] {
  const next: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    next.push(value);
  }
  return next;
}

function resolveRahHome(): string {
  return process.env.RAH_HOME ?? path.join(os.homedir(), ".rah");
}

function workbenchSessionRef(state: StoredSessionState): StoredSessionRef | null {
  const providerSessionId = state.session.providerSessionId;
  if (!providerSessionId) {
    return null;
  }
  return {
    provider: state.session.provider,
    providerSessionId,
    cwd: state.session.cwd,
    rootDir: state.session.rootDir,
    ...(state.session.title !== undefined ? { title: state.session.title } : {}),
    ...(state.session.preview !== undefined ? { preview: state.session.preview } : {}),
    createdAt: state.session.createdAt,
    updatedAt: state.session.updatedAt,
    lastUsedAt: state.session.updatedAt,
    source: "previous_live",
  };
}

function isInternalBootstrapText(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return (
    value.includes("<environment_context>") ||
    value.includes("# AGENTS.md instructions") ||
    value.includes("<INSTRUCTIONS>") ||
    value.includes("<permissions instructions>") ||
    value.includes("<skills_instructions>")
  );
}

function sanitizeStoredSessionRef(session: StoredSessionRef): StoredSessionRef {
  return {
    ...session,
    ...(isInternalBootstrapText(session.title) ? { title: session.providerSessionId } : {}),
    ...(isInternalBootstrapText(session.preview) ? { preview: session.providerSessionId } : {}),
  };
}

function sessionKey(session: Pick<StoredSessionRef, "provider" | "providerSessionId">): string {
  return `${session.provider}:${session.providerSessionId}`;
}

function applyTitleOverride(
  session: StoredSessionRef,
  overrides: Record<string, string>,
): StoredSessionRef {
  const nextTitle = overrides[sessionKey(session)];
  if (!nextTitle || nextTitle === session.title) {
    return session;
  }
  return {
    ...session,
    title: nextTitle,
  };
}

function applyTitleOverrideToSessions(
  sessions: readonly StoredSessionRef[],
  overrides: Record<string, string>,
): StoredSessionRef[] {
  return sessions.map((session) => applyTitleOverride(session, overrides));
}

function mergeRecentSessions(
  current: readonly StoredSessionRef[],
  nextSessions: readonly StoredSessionRef[],
): StoredSessionRef[] {
  const merged = new Map<string, StoredSessionRef>();
  for (const session of current) {
    merged.set(sessionKey(session), sanitizeStoredSessionRef(session));
  }
  const now = new Date().toISOString();
  for (const session of nextSessions) {
    const normalizedSession = sanitizeStoredSessionRef(session);
    const existing = merged.get(sessionKey(normalizedSession));
    merged.set(sessionKey(session), {
      ...existing,
      ...normalizedSession,
      lastUsedAt: normalizedSession.lastUsedAt ?? normalizedSession.updatedAt ?? now,
    });
  }
  return [...merged.values()]
    .sort((a, b) => (b.lastUsedAt ?? b.updatedAt ?? "").localeCompare(a.lastUsedAt ?? a.updatedAt ?? ""))
    .slice(0, RECENT_SESSION_LIMIT);
}

function mergeRememberedSessions(
  current: readonly StoredSessionRef[],
  nextSessions: readonly StoredSessionRef[],
): StoredSessionRef[] {
  const merged = new Map<string, StoredSessionRef>();
  for (const session of current) {
    merged.set(sessionKey(session), sanitizeStoredSessionRef(session));
  }
  for (const session of nextSessions) {
    const normalizedSession = sanitizeStoredSessionRef(session);
    const existing = merged.get(sessionKey(normalizedSession));
    merged.set(sessionKey(session), {
      ...existing,
      ...normalizedSession,
      source: "previous_live",
    });
  }
  return [...merged.values()].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

async function writeJsonAtomic(pathname: string, value: unknown): Promise<void> {
  const tmpPath = `${pathname}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, JSON.stringify(value, null, 2), "utf8");
  await rename(tmpPath, pathname);
}

export class WorkbenchStateStore {
  private readonly rootDir: string;
  private readonly snapshotPath: string;
  private writeQueue: Promise<void> = Promise.resolve();
  private state: {
    activeWorkspaceDir?: string;
    workspaces: string[];
    hiddenWorkspaces: string[];
    hiddenSessionKeys: string[];
    sessionTitleOverrides: Record<string, string>;
    pendingSessionTitleOverrides: Record<string, string>;
    sessions: StoredSessionRef[];
    recentSessions: StoredSessionRef[];
  } = {
    workspaces: [],
    hiddenWorkspaces: [],
    hiddenSessionKeys: [],
    sessionTitleOverrides: {},
    pendingSessionTitleOverrides: {},
    sessions: [],
    recentSessions: [],
  };

  constructor(rootDir = path.join(resolveRahHome(), "runtime-daemon")) {
    this.rootDir = rootDir;
    this.snapshotPath = path.join(rootDir, SNAPSHOT_FILE);
    mkdirSync(this.rootDir, { recursive: true });
  }

  load(): {
    activeWorkspaceDir?: string;
    workspaces: string[];
    hiddenWorkspaces: string[];
    hiddenSessionKeys: string[];
    sessionTitleOverrides: Record<string, string>;
    pendingSessionTitleOverrides: Record<string, string>;
    sessions: StoredSessionRef[];
    recentSessions: StoredSessionRef[];
  } {
    if (!existsSync(this.snapshotPath)) {
      this.state = {
        workspaces: [],
        hiddenWorkspaces: [],
        hiddenSessionKeys: [],
        sessionTitleOverrides: {},
        pendingSessionTitleOverrides: {},
        sessions: [],
        recentSessions: [],
      };
      return this.state;
    }
    try {
      const raw = JSON.parse(readFileSync(this.snapshotPath, "utf8")) as WorkbenchStateFile;
      if (!raw || typeof raw !== "object" || !Array.isArray(raw.sessions)) {
        this.state = {
          workspaces: [],
          hiddenWorkspaces: [],
          hiddenSessionKeys: [],
          sessionTitleOverrides: {},
          pendingSessionTitleOverrides: {},
          sessions: [],
          recentSessions: [],
        };
        return this.state;
      }
      const sessions = raw.sessions.filter(
        (value): value is StoredSessionRef =>
          Boolean(
            value &&
              typeof value === "object" &&
              typeof value.provider === "string" &&
              typeof value.providerSessionId === "string",
          ),
      );
      const recentSessions = Array.isArray(raw.recentSessions)
        ? raw.recentSessions.filter(
            (value): value is StoredSessionRef =>
              Boolean(
                value &&
                  typeof value === "object" &&
                  typeof value.provider === "string" &&
                  typeof value.providerSessionId === "string",
              ),
          ).map(sanitizeStoredSessionRef)
        : [];
      const sanitizedSessions = sessions.map(sanitizeStoredSessionRef);
      const hiddenWorkspaces = Array.isArray(raw.hiddenWorkspaces)
        ? uniqueDirectoriesInOrder(raw.hiddenWorkspaces)
        : [];
      const hiddenSessionKeys = Array.isArray(raw.hiddenSessionKeys)
        ? uniqueStringsInOrder(raw.hiddenSessionKeys.filter((value): value is string => typeof value === "string"))
        : [];
      const sessionTitleOverrides =
        raw.sessionTitleOverrides && typeof raw.sessionTitleOverrides === "object"
          ? Object.fromEntries(
              Object.entries(raw.sessionTitleOverrides).filter(
                (entry): entry is [string, string] =>
                  typeof entry[0] === "string" && typeof entry[1] === "string" && entry[1].trim().length > 0,
              ),
            )
          : {};
      const pendingSessionTitleOverrides =
        raw.pendingSessionTitleOverrides && typeof raw.pendingSessionTitleOverrides === "object"
          ? Object.fromEntries(
              Object.entries(raw.pendingSessionTitleOverrides).filter(
                (entry): entry is [string, string] =>
                  typeof entry[0] === "string" && typeof entry[1] === "string" && entry[1].trim().length > 0,
              ),
            )
          : {};
      const workspaces = filterHiddenDirectories([
        ...(Array.isArray(raw.workspaces) ? raw.workspaces : []),
        ...sanitizedSessions.flatMap((session) => {
          const directory = normalizeDirectory(session.rootDir || session.cwd);
          return directory ? [directory] : [];
        }),
      ], hiddenWorkspaces);
      const activeWorkspaceDir = normalizeDirectory(raw.activeWorkspaceDir);
      this.state = {
        ...(activeWorkspaceDir && !hiddenWorkspaces.includes(activeWorkspaceDir)
          ? { activeWorkspaceDir }
          : {}),
        workspaces,
        hiddenWorkspaces,
        hiddenSessionKeys,
        sessionTitleOverrides,
        pendingSessionTitleOverrides,
        sessions: applyTitleOverrideToSessions(
          sanitizedSessions.filter((session) => !hiddenSessionKeys.includes(sessionKey(session))),
          sessionTitleOverrides,
        ),
        recentSessions: applyTitleOverrideToSessions(
          recentSessions.filter((session) => !hiddenSessionKeys.includes(sessionKey(session))),
          sessionTitleOverrides,
        ),
      };
      return this.state;
    } catch {
      this.state = {
        workspaces: [],
        hiddenWorkspaces: [],
        hiddenSessionKeys: [],
        sessionTitleOverrides: {},
        pendingSessionTitleOverrides: {},
        sessions: [],
        recentSessions: [],
      };
      return this.state;
    }
  }

  persistLiveSessions(states: readonly StoredSessionState[]): void {
    const sessions = states
      .map(workbenchSessionRef)
      .filter((value): value is StoredSessionRef => value !== null)
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    const liveWorkspaceDirs = states.flatMap((state) => {
      const directory = normalizeDirectory(state.session.rootDir || state.session.cwd);
      return directory ? [directory] : [];
    });
    const workspaces = filterHiddenDirectories(
      [...this.state.workspaces, ...liveWorkspaceDirs],
      this.state.hiddenWorkspaces,
    );
    const activeWorkspaceDir =
      (normalizeDirectory(this.state.activeWorkspaceDir) &&
      !this.state.hiddenWorkspaces.includes(normalizeDirectory(this.state.activeWorkspaceDir)!)
        ? normalizeDirectory(this.state.activeWorkspaceDir)
        : null) ??
      normalizeDirectory(sessions[0]?.rootDir ?? sessions[0]?.cwd) ??
      workspaces[0];
    const visibleSessionKeys = new Set(
      sessions.map((session) => sessionKey(session)),
    );
    this.state = {
      ...(activeWorkspaceDir ? { activeWorkspaceDir } : {}),
      workspaces,
      hiddenWorkspaces: this.state.hiddenWorkspaces,
      hiddenSessionKeys: this.state.hiddenSessionKeys.filter((key) => !visibleSessionKeys.has(key)),
      sessionTitleOverrides: this.state.sessionTitleOverrides,
      pendingSessionTitleOverrides: this.state.pendingSessionTitleOverrides,
      sessions: mergeRememberedSessions(this.state.sessions, sessions),
      recentSessions: mergeRecentSessions(this.state.recentSessions, sessions),
    };
    this.persistState();
  }

  rememberSession(state: StoredSessionState): void {
    const session = workbenchSessionRef(state);
    if (!session) {
      return;
    }
    const hiddenSessionKeys = this.state.hiddenSessionKeys.filter(
      (key) => key !== sessionKey(session),
    );
    const hiddenWorkspaces = this.state.hiddenWorkspaces.filter(
      (workspace) => !normalizeDirectory(session.rootDir || session.cwd) || workspace !== normalizeDirectory(session.rootDir || session.cwd),
    );
    const workspaces = filterHiddenDirectories([
      ...this.state.workspaces,
      ...(session.rootDir || session.cwd ? [session.rootDir ?? session.cwd ?? ""] : []),
    ], hiddenWorkspaces);
    const sessionsByKey = new Map(
      this.state.sessions.map((entry) => [sessionKey(entry), entry] as const),
    );
    sessionsByKey.set(sessionKey(session), session);
    this.state = {
      ...this.state,
      workspaces,
      hiddenWorkspaces,
      hiddenSessionKeys,
      sessionTitleOverrides: this.state.sessionTitleOverrides,
      pendingSessionTitleOverrides: this.state.pendingSessionTitleOverrides,
      sessions: mergeRememberedSessions(this.state.sessions, [session]),
      recentSessions: mergeRecentSessions(this.state.recentSessions, [session]),
    };
    this.persistState();
  }

  snapshot(): {
    activeWorkspaceDir?: string;
    workspaces: string[];
    hiddenWorkspaces: string[];
    hiddenSessionKeys: string[];
    sessionTitleOverrides: Record<string, string>;
    pendingSessionTitleOverrides: Record<string, string>;
    sessions: StoredSessionRef[];
    recentSessions: StoredSessionRef[];
  } {
    return {
      ...(this.state.activeWorkspaceDir ? { activeWorkspaceDir: this.state.activeWorkspaceDir } : {}),
      workspaces: [...this.state.workspaces],
      hiddenWorkspaces: [...this.state.hiddenWorkspaces],
      hiddenSessionKeys: [...this.state.hiddenSessionKeys],
      sessionTitleOverrides: { ...this.state.sessionTitleOverrides },
      pendingSessionTitleOverrides: { ...this.state.pendingSessionTitleOverrides },
      sessions: [...this.state.sessions],
      recentSessions: [...this.state.recentSessions],
    };
  }

  selectWorkspace(rawDir: string): void {
    const directory = normalizeDirectory(rawDir);
    if (!directory) {
      return;
    }
    const hiddenWorkspaces = this.state.hiddenWorkspaces.filter((workspace) => workspace !== directory);
    const workspaces = filterHiddenDirectories([...this.state.workspaces, directory], hiddenWorkspaces);
    this.state = {
      activeWorkspaceDir: directory,
      workspaces,
      hiddenWorkspaces,
      hiddenSessionKeys: this.state.hiddenSessionKeys,
      sessionTitleOverrides: this.state.sessionTitleOverrides,
      pendingSessionTitleOverrides: this.state.pendingSessionTitleOverrides,
      sessions: this.state.sessions,
      recentSessions: this.state.recentSessions,
    };
    this.persistState();
  }

  removeWorkspace(rawDir: string): void {
    const directory = normalizeDirectory(rawDir);
    if (!directory) {
      return;
    }
    const workspaces = this.state.workspaces.filter((workspace) => workspace !== directory);
    const hiddenWorkspaces = uniqueDirectoriesInOrder([...this.state.hiddenWorkspaces, directory]);
    const activeWorkspaceDir =
      this.state.activeWorkspaceDir === directory
        ? workspaces[0]
        : this.state.activeWorkspaceDir;
    this.state = {
      ...(activeWorkspaceDir ? { activeWorkspaceDir } : {}),
      workspaces,
      hiddenWorkspaces,
      hiddenSessionKeys: this.state.hiddenSessionKeys,
      sessionTitleOverrides: this.state.sessionTitleOverrides,
      pendingSessionTitleOverrides: this.state.pendingSessionTitleOverrides,
      sessions: this.state.sessions,
      recentSessions: this.state.recentSessions,
    };
    this.persistState();
  }

  hideSession(session: Pick<StoredSessionRef, "provider" | "providerSessionId">): void {
    const key = sessionKey(session);
    const nextOverrides = { ...this.state.sessionTitleOverrides };
    delete nextOverrides[key];
    this.state = {
      ...this.state,
      hiddenSessionKeys: uniqueStringsInOrder([...this.state.hiddenSessionKeys, key]),
      sessionTitleOverrides: nextOverrides,
      sessions: this.state.sessions.filter((entry) => sessionKey(entry) !== key),
      recentSessions: this.state.recentSessions.filter((entry) => sessionKey(entry) !== key),
    };
    this.persistState();
  }

  hideSessionsInWorkspace(rawDir: string): void {
    const directory = normalizeDirectory(rawDir);
    if (!directory) {
      return;
    }
    const matchingSessionKeys = [
      ...this.state.sessions,
      ...this.state.recentSessions,
    ]
      .filter((entry) => {
        const sessionDir = normalizeDirectory(entry.rootDir || entry.cwd);
        return (
          sessionDir === directory ||
          sessionDir?.startsWith(`${directory}/`) ||
          sessionDir?.startsWith(`${directory}\\`)
        );
      })
      .map((entry) => sessionKey(entry));

    if (matchingSessionKeys.length === 0) {
      return;
    }

    const hiddenSessionKeys = new Set([
      ...this.state.hiddenSessionKeys,
      ...matchingSessionKeys,
    ]);
    const nextOverrides = { ...this.state.sessionTitleOverrides };
    for (const key of matchingSessionKeys) {
      delete nextOverrides[key];
    }

    this.state = {
      ...this.state,
      hiddenSessionKeys: [...hiddenSessionKeys],
      sessionTitleOverrides: nextOverrides,
      sessions: this.state.sessions.filter((entry) => !hiddenSessionKeys.has(sessionKey(entry))),
      recentSessions: this.state.recentSessions.filter((entry) => !hiddenSessionKeys.has(sessionKey(entry))),
    };
    this.persistState();
  }

  setSessionTitleOverride(
    session: Pick<StoredSessionRef, "provider" | "providerSessionId">,
    title: string,
  ): void {
    const nextTitle = title.trim();
    if (!nextTitle) {
      throw new Error("Session title is required.");
    }
    const key = sessionKey(session);
    this.state = {
      ...this.state,
      sessionTitleOverrides: {
        ...this.state.sessionTitleOverrides,
        [key]: nextTitle,
      },
      sessions: this.state.sessions.map((entry) =>
        sessionKey(entry) === key ? { ...entry, title: nextTitle } : entry,
      ),
      recentSessions: this.state.recentSessions.map((entry) =>
        sessionKey(entry) === key ? { ...entry, title: nextTitle } : entry,
      ),
    };
    this.persistState();
  }

  setPendingSessionTitleOverride(sessionId: string, title: string): void {
    const nextTitle = title.trim();
    if (!nextTitle) {
      throw new Error("Session title is required.");
    }
    this.state = {
      ...this.state,
      pendingSessionTitleOverrides: {
        ...this.state.pendingSessionTitleOverrides,
        [sessionId]: nextTitle,
      },
    };
    this.persistState();
  }

  promotePendingSessionTitleOverride(
    sessionId: string,
    session: Pick<StoredSessionRef, "provider" | "providerSessionId">,
  ): string | null {
    const title = this.state.pendingSessionTitleOverrides[sessionId];
    if (!title) {
      return null;
    }
    const nextPending = { ...this.state.pendingSessionTitleOverrides };
    delete nextPending[sessionId];
    const key = sessionKey(session);
    this.state = {
      ...this.state,
      pendingSessionTitleOverrides: nextPending,
      sessionTitleOverrides: {
        ...this.state.sessionTitleOverrides,
        [key]: title,
      },
      sessions: this.state.sessions.map((entry) =>
        sessionKey(entry) === key ? { ...entry, title } : entry,
      ),
      recentSessions: this.state.recentSessions.map((entry) =>
        sessionKey(entry) === key ? { ...entry, title } : entry,
      ),
    };
    this.persistState();
    return title;
  }

  private persistState(): void {
    const payload: WorkbenchStateFile = {
      version: STORAGE_VERSION,
      updatedAt: new Date().toISOString(),
      ...(this.state.activeWorkspaceDir ? { activeWorkspaceDir: this.state.activeWorkspaceDir } : {}),
      workspaces: this.state.workspaces,
      hiddenWorkspaces: this.state.hiddenWorkspaces,
      hiddenSessionKeys: this.state.hiddenSessionKeys,
      sessionTitleOverrides: this.state.sessionTitleOverrides,
      pendingSessionTitleOverrides: this.state.pendingSessionTitleOverrides,
      sessions: this.state.sessions,
      recentSessions: this.state.recentSessions,
    };
    this.enqueue(async () => {
      await mkdir(this.rootDir, { recursive: true });
      await writeJsonAtomic(this.snapshotPath, payload);
    });
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  private enqueue(task: () => Promise<void>): void {
    this.writeQueue = this.writeQueue
      .then(task)
      .catch((error) => {
        console.error("[rah:workbench-state] write failed", error);
      });
  }
}
