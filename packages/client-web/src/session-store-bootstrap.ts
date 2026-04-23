import type { StoredSessionRef } from "@rah/runtime-protocol";
import * as api from "./api";
import {
  clearLastHistorySelection,
  readLastHistorySelection,
} from "./history-selection";
import {
  appendVisibleWorkspaceDir,
  isHiddenWorkspace,
} from "./session-store-workspace";

const CLIENT_ID_STORAGE_KEY = "rah.web-client-id";
const CONNECTION_ID_STORAGE_KEY = "rah.web-connection-id";
const SHARED_WEB_CLIENT_ID = "web-user";

let initialized = false;
let attemptedStoredHistoryRestore = false;

export function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function generateClientId(): string {
  const randomUuid =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID.bind(globalThis.crypto)
      : null;
  if (randomUuid) {
    return `web-${randomUuid()}`;
  }
  return `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function readOrCreateClientId(
  _storage?:
    | Pick<Storage, "getItem" | "setItem">
    | null,
): string {
  return SHARED_WEB_CLIENT_ID;
}

export function readOrCreateConnectionId(
  storage?:
    | Pick<Storage, "getItem" | "setItem">
    | null,
): string {
  const effectiveStorage =
    storage ??
    (typeof window !== "undefined"
      ? (() => {
          try {
            return window.sessionStorage;
          } catch {
            return null;
          }
        })()
      : null);

  if (effectiveStorage) {
    try {
      const existing = effectiveStorage.getItem(CONNECTION_ID_STORAGE_KEY)?.trim();
      if (existing) {
        return existing;
      }
    } catch {
      // ignore
    }
  }

  const created = generateClientId();
  if (effectiveStorage) {
    try {
      effectiveStorage.setItem(CONNECTION_ID_STORAGE_KEY, created);
    } catch {
      // ignore
    }
  }
  return created;
}

export function beginSessionStoreInit(): boolean {
  if (initialized) {
    return false;
  }
  initialized = true;
  return true;
}

export function resetSessionStoreInit() {
  initialized = false;
}

export async function maybeRestoreLastHistorySelection(args: {
  isInitialLoaded: boolean;
  sessionsResponse: Awaited<ReturnType<typeof api.listSessions>>;
  revealWorkspaceSelection: (workspaceDir: string) => void;
  resumeStoredSession: (
    ref: StoredSessionRef,
    options?: { preferStoredReplay?: boolean; historyReplay?: "include" | "skip" },
  ) => Promise<void>;
}) {
  if (
    attemptedStoredHistoryRestore ||
    args.isInitialLoaded ||
    args.sessionsResponse.sessions.length > 0
  ) {
    return;
  }
  attemptedStoredHistoryRestore = true;
  const selection = readLastHistorySelection();
  if (!selection) {
    return;
  }
  const ref =
    args.sessionsResponse.storedSessions.find(
      (session) =>
        session.provider === selection.provider &&
        session.providerSessionId === selection.providerSessionId,
    ) ??
    args.sessionsResponse.recentSessions.find(
      (session) =>
        session.provider === selection.provider &&
        session.providerSessionId === selection.providerSessionId,
    );
  if (!ref) {
    clearLastHistorySelection();
    return;
  }
  if (selection.workspaceDir) {
    args.revealWorkspaceSelection(selection.workspaceDir);
  }
  try {
    await args.resumeStoredSession(ref, { preferStoredReplay: true });
  } catch {
    clearLastHistorySelection();
  }
}

export function revealStoredHistoryWorkspace(args: {
  workspaceDir: string;
  hiddenWorkspaceDirs: ReadonlySet<string>;
  workspaceDirs: readonly string[];
}): {
  workspaceDir: string;
  workspaceDirs: string[];
} {
  return {
    workspaceDir: isHiddenWorkspace(args.hiddenWorkspaceDirs, args.workspaceDir)
      ? ""
      : args.workspaceDir,
    workspaceDirs: appendVisibleWorkspaceDir(
      args.hiddenWorkspaceDirs,
      args.workspaceDirs,
      args.workspaceDir,
    ),
  };
}
