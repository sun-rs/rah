import { mkdir, rename, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { StoredSessionRef } from "@rah/runtime-protocol";
import type { StoredSessionState } from "./session-store";

const SNAPSHOT_FILE = "workbench-state.json";
const STORAGE_VERSION = 1;
const RECENT_SESSION_LIMIT = 15;

interface WorkbenchStateFile {
  version: number;
  updatedAt: string;
  activeWorkspaceDir?: string;
  workspaces: string[];
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

function dedupeDirectories(values: readonly string[]): string[] {
  const directories = new Set<string>();
  for (const value of values) {
    const normalized = normalizeDirectory(value);
    if (normalized) {
      directories.add(normalized);
    }
  }
  return [...directories].sort((a, b) => a.localeCompare(b));
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
    sessions: StoredSessionRef[];
    recentSessions: StoredSessionRef[];
  } = { workspaces: [], sessions: [], recentSessions: [] };

  constructor(rootDir = path.join(resolveRahHome(), "runtime-daemon")) {
    this.rootDir = rootDir;
    this.snapshotPath = path.join(rootDir, SNAPSHOT_FILE);
    mkdirSync(this.rootDir, { recursive: true });
  }

  load(): {
    activeWorkspaceDir?: string;
    workspaces: string[];
    sessions: StoredSessionRef[];
    recentSessions: StoredSessionRef[];
  } {
    if (!existsSync(this.snapshotPath)) {
      this.state = { workspaces: [], sessions: [], recentSessions: [] };
      return this.state;
    }
    try {
      const raw = JSON.parse(readFileSync(this.snapshotPath, "utf8")) as WorkbenchStateFile;
      if (!raw || typeof raw !== "object" || !Array.isArray(raw.sessions)) {
        this.state = { workspaces: [], sessions: [], recentSessions: [] };
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
      const workspaces = dedupeDirectories([
        ...(Array.isArray(raw.workspaces) ? raw.workspaces : []),
        ...sanitizedSessions.flatMap((session) => {
          const directory = normalizeDirectory(session.rootDir || session.cwd);
          return directory ? [directory] : [];
        }),
      ]);
      const activeWorkspaceDir = normalizeDirectory(raw.activeWorkspaceDir);
      this.state = {
        ...(activeWorkspaceDir ? { activeWorkspaceDir } : {}),
        workspaces,
        sessions: sanitizedSessions,
        recentSessions,
      };
      return this.state;
    } catch {
      this.state = { workspaces: [], sessions: [], recentSessions: [] };
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
    const workspaces = dedupeDirectories([...this.state.workspaces, ...liveWorkspaceDirs]);
    const activeWorkspaceDir =
      normalizeDirectory(this.state.activeWorkspaceDir) ??
      normalizeDirectory(sessions[0]?.rootDir ?? sessions[0]?.cwd) ??
      workspaces[0];
    this.state = {
      ...(activeWorkspaceDir ? { activeWorkspaceDir } : {}),
      workspaces,
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
    const workspaces = dedupeDirectories([
      ...this.state.workspaces,
      ...(session.rootDir || session.cwd ? [session.rootDir ?? session.cwd ?? ""] : []),
    ]);
    const sessionsByKey = new Map(
      this.state.sessions.map((entry) => [sessionKey(entry), entry] as const),
    );
    sessionsByKey.set(sessionKey(session), session);
    this.state = {
      ...this.state,
      workspaces,
      sessions: mergeRememberedSessions(this.state.sessions, [session]),
      recentSessions: mergeRecentSessions(this.state.recentSessions, [session]),
    };
    this.persistState();
  }

  snapshot(): {
    activeWorkspaceDir?: string;
    workspaces: string[];
    sessions: StoredSessionRef[];
    recentSessions: StoredSessionRef[];
  } {
    return {
      ...(this.state.activeWorkspaceDir ? { activeWorkspaceDir: this.state.activeWorkspaceDir } : {}),
      workspaces: [...this.state.workspaces],
      sessions: [...this.state.sessions],
      recentSessions: [...this.state.recentSessions],
    };
  }

  selectWorkspace(rawDir: string): void {
    const directory = normalizeDirectory(rawDir);
    if (!directory) {
      return;
    }
    const workspaces = dedupeDirectories([...this.state.workspaces, directory]);
    this.state = {
      activeWorkspaceDir: directory,
      workspaces,
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
    const activeWorkspaceDir =
      this.state.activeWorkspaceDir === directory
        ? workspaces[0]
        : this.state.activeWorkspaceDir;
    this.state = {
      ...(activeWorkspaceDir ? { activeWorkspaceDir } : {}),
      workspaces,
      sessions: this.state.sessions,
      recentSessions: this.state.recentSessions,
    };
    this.persistState();
  }

  private persistState(): void {
    const payload: WorkbenchStateFile = {
      version: STORAGE_VERSION,
      updatedAt: new Date().toISOString(),
      ...(this.state.activeWorkspaceDir ? { activeWorkspaceDir: this.state.activeWorkspaceDir } : {}),
      workspaces: this.state.workspaces,
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
