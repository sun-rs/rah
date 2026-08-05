import type { StoredSessionRef } from "@rah/runtime-protocol";
import * as api from "./api";
import {
  clearLastHistorySelection,
  readLastHistorySelection,
  type HistorySelection,
} from "./history-selection";
import {
  appendVisibleWorkspaceDir,
  isHiddenWorkspace,
} from "./session-store-workspace";

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
  attemptedStoredHistoryRestore = false;
}

export function resolveHistorySelectionRestoreTarget(
  selection: HistorySelection,
  sessionsResponse: Awaited<ReturnType<typeof api.listSessions>>,
):
  | { kind: "live"; sessionId: string; workspaceDir?: string }
  | { kind: "stored"; ref: StoredSessionRef; workspaceDir?: string }
  | null {
  const matchingLiveSession = sessionsResponse.sessions.find(
    (summary) =>
      summary.session.provider === selection.provider &&
      summary.session.providerSessionId === selection.providerSessionId,
  );
  if (matchingLiveSession) {
    const workspaceDir =
      selection.workspaceDir ||
      matchingLiveSession.session.rootDir ||
      matchingLiveSession.session.cwd;
    return {
      kind: "live",
      sessionId: matchingLiveSession.session.id,
      ...(workspaceDir ? { workspaceDir } : {}),
    };
  }

  const matchingStoredSession = [
    ...sessionsResponse.recentSessions,
    ...sessionsResponse.storedSessions,
  ].find(
    (ref) =>
      ref.provider === selection.provider &&
      ref.providerSessionId === selection.providerSessionId,
  );
  if (!matchingStoredSession) {
    return null;
  }
  const workspaceDir =
    selection.workspaceDir ||
    matchingStoredSession.rootDir ||
    matchingStoredSession.cwd;
  return {
    kind: "stored",
    ref: matchingStoredSession,
    ...(workspaceDir ? { workspaceDir } : {}),
  };
}

export async function maybeRestoreLastHistorySelection(args: {
  isInitialLoaded: boolean;
  sessionsResponse: Awaited<ReturnType<typeof api.listSessions>>;
  revealWorkspaceSelection: (workspaceDir: string) => void;
  selectSession: (sessionId: string) => void;
  resumeStoredSession: (
    ref: StoredSessionRef,
    options?: { preferStoredReplay?: boolean; historyReplay?: "include" | "skip" },
  ) => Promise<void>;
}) {
  if (attemptedStoredHistoryRestore) return;
  attemptedStoredHistoryRestore = true;
  const selection = readLastHistorySelection();
  if (!selection) {
    return;
  }
  const target = resolveHistorySelectionRestoreTarget(selection, args.sessionsResponse);
  if (!target) {
    clearLastHistorySelection();
    return;
  }
  if (target.workspaceDir) {
    args.revealWorkspaceSelection(target.workspaceDir);
  }
  if (target.kind === "live") {
    args.selectSession(target.sessionId);
    return;
  }
  await args.resumeStoredSession(target.ref, {
    preferStoredReplay: true,
    historyReplay: "include",
  });
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
