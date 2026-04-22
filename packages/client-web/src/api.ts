import type {
  AttachSessionRequest,
  AttachSessionResponse,
  CloseSessionRequest,
  DebugScenarioDescriptor,
  DetachSessionRequest,
  EventBatch,
  EventSubscriptionRequest,
  GitDiffResponse,
  GitFileActionRequest,
  GitFileActionResponse,
  GitHunkActionRequest,
  GitHunkActionResponse,
  GitStatusResponse,
  SessionFileSearchResponse,
  ListDebugScenariosResponse,
  ListProvidersResponse,
  ListSessionsResponse,
  ProviderDiagnostic,
  PtyClientMessage,
  PtyServerMessage,
  PermissionResponseRequest,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SessionFileResponse,
  SessionInputRequest,
  SessionHistoryPageResponse,
  SessionSummary,
  StartDebugScenarioRequest,
  StartSessionRequest,
  StartSessionResponse,
  StoredSessionRemoveRequest,
  WorkspaceDirectoryResponse,
  WorkspaceDirectoryRequest,
  WorkbenchResponse,
  WorkspaceSnapshotResponse,
} from "@rah/runtime-protocol";

const DEFAULT_DAEMON_PORT = 43111;

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

function computeDefaultBaseUrl(): string {
  if (typeof window === "undefined") {
    return `http://127.0.0.1:${DEFAULT_DAEMON_PORT}`;
  }
  if (window.location.port && window.location.port !== "43112") {
    return window.location.origin;
  }
  const protocol = window.location.protocol === "https:" ? "https:" : "http:";
  const hostname = window.location.hostname || "127.0.0.1";
  return `${protocol}//${hostname}:${DEFAULT_DAEMON_PORT}`;
}

export function getBaseUrl(): string {
  const configured = window.localStorage.getItem("rah.baseUrl");
  const trimmed = configured?.trim();
  if (!trimmed) {
    return computeDefaultBaseUrl();
  }

  try {
    const configuredUrl = new URL(trimmed);
    const currentHostname = window.location.hostname || "127.0.0.1";
    if (configuredUrl.hostname !== currentHostname) {
      return computeDefaultBaseUrl();
    }
  } catch {
    return computeDefaultBaseUrl();
  }

  return trimmed;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${getBaseUrl()}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    const fallback = `Request failed: ${response.status} ${response.statusText}`;
    let message = fallback;
    try {
      const raw = await response.text();
      if (raw.trim()) {
        try {
          const parsed = JSON.parse(raw) as { error?: string; message?: string };
          message = parsed.error ?? parsed.message ?? raw;
        } catch {
          message = raw;
        }
      }
    } catch {
      // ignore
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

export async function listSessions(): Promise<ListSessionsResponse> {
  return requestJson<ListSessionsResponse>("/api/sessions");
}

export async function addWorkspace(
  request: WorkspaceDirectoryRequest,
): Promise<ListSessionsResponse> {
  return requestJson<ListSessionsResponse>("/api/workspaces/add", {
    method: "POST",
    body: JSON.stringify(request),
  });
}

export async function selectWorkspace(
  request: WorkspaceDirectoryRequest,
): Promise<ListSessionsResponse> {
  return requestJson<ListSessionsResponse>("/api/workspaces/select", {
    method: "POST",
    body: JSON.stringify(request),
  });
}

export async function removeWorkspace(
  request: WorkspaceDirectoryRequest,
): Promise<ListSessionsResponse> {
  return requestJson<ListSessionsResponse>("/api/workspaces/remove", {
    method: "POST",
    body: JSON.stringify(request),
  });
}

export async function removeStoredSession(
  request: StoredSessionRemoveRequest,
): Promise<ListSessionsResponse> {
  return requestJson<ListSessionsResponse>("/api/history/sessions/remove", {
    method: "POST",
    body: JSON.stringify(request),
  });
}

export async function removeStoredWorkspaceSessions(
  request: WorkspaceDirectoryRequest,
): Promise<ListSessionsResponse> {
  return requestJson<ListSessionsResponse>("/api/history/workspaces/remove", {
    method: "POST",
    body: JSON.stringify(request),
  });
}

export interface DirectoryListingResponse {
  path: string;
  entries: Array<{ name: string; type: "file" | "directory" }>;
}

export async function listDirectory(path: string): Promise<DirectoryListingResponse> {
  const encoded = encodeURIComponent(path);
  return requestJson<DirectoryListingResponse>(`/api/fs/list?path=${encoded}`);
}

export async function ensureDirectory(
  request: WorkspaceDirectoryRequest,
): Promise<WorkspaceDirectoryResponse> {
  return requestJson<WorkspaceDirectoryResponse>("/api/fs/ensure-dir", {
    method: "POST",
    body: JSON.stringify(request),
  });
}

export async function listDebugScenarios(): Promise<DebugScenarioDescriptor[]> {
  const response =
    await requestJson<ListDebugScenariosResponse>("/api/debug/scenarios");
  return response.scenarios;
}

export async function listProviders(options?: { forceRefresh?: boolean }): Promise<ProviderDiagnostic[]> {
  const search = options?.forceRefresh ? "?refresh=1" : "";
  const response = await requestJson<ListProvidersResponse>(`/api/providers${search}`);
  return response.providers;
}

export async function readWorkbench(): Promise<WorkbenchResponse> {
  return requestJson<WorkbenchResponse>("/api/workbenches/default");
}

export async function startSession(
  request: StartSessionRequest,
): Promise<StartSessionResponse> {
  return requestJson<StartSessionResponse>("/api/sessions/start", {
    method: "POST",
    body: JSON.stringify(request),
  });
}

export async function resumeSession(
  request: ResumeSessionRequest,
): Promise<ResumeSessionResponse> {
  return requestJson<ResumeSessionResponse>("/api/sessions/resume", {
    method: "POST",
    body: JSON.stringify(request),
  });
}

export async function startDebugScenario(
  request: StartDebugScenarioRequest,
): Promise<StartSessionResponse> {
  return requestJson<StartSessionResponse>("/api/debug/scenarios/start", {
    method: "POST",
    body: JSON.stringify(request),
  });
}

export async function attachSession(
  sessionId: string,
  request: AttachSessionRequest,
): Promise<AttachSessionResponse> {
  return requestJson<AttachSessionResponse>(`/api/sessions/${sessionId}/attach`, {
    method: "POST",
    body: JSON.stringify(request),
  });
}

export async function claimControl(sessionId: string, clientId: string): Promise<SessionSummary> {
  const response = await requestJson<{ session: SessionSummary }>(
    `/api/sessions/${sessionId}/control/claim`,
    {
      method: "POST",
      body: JSON.stringify({
        client: {
          id: clientId,
          kind: "web",
          connectionId: clientId,
        },
      }),
    },
  );
  return response.session;
}

export async function releaseControl(sessionId: string, clientId: string): Promise<SessionSummary> {
  const response = await requestJson<{ session: SessionSummary }>(
    `/api/sessions/${sessionId}/control/release`,
    {
      method: "POST",
      body: JSON.stringify({ clientId }),
    },
  );
  return response.session;
}

export async function sendSessionInput(
  sessionId: string,
  request: SessionInputRequest,
): Promise<void> {
  await requestJson<{ ok: true }>(`/api/sessions/${sessionId}/input`, {
    method: "POST",
    body: JSON.stringify(request),
  });
}

export async function interruptSession(
  sessionId: string,
  clientId: string,
): Promise<SessionSummary> {
  const response = await requestJson<{ session: SessionSummary }>(
    `/api/sessions/${sessionId}/interrupt`,
    {
      method: "POST",
      body: JSON.stringify({ clientId }),
    },
  );
  return response.session;
}

export async function detachSession(
  sessionId: string,
  request: DetachSessionRequest,
): Promise<SessionSummary> {
  const response = await requestJson<{ session: SessionSummary }>(
    `/api/sessions/${sessionId}/detach`,
    {
      method: "POST",
      body: JSON.stringify(request),
    },
  );
  return response.session;
}

export async function closeSession(
  sessionId: string,
  request: CloseSessionRequest,
): Promise<void> {
  await requestJson<{ ok: true }>(`/api/sessions/${sessionId}/close`, {
    method: "POST",
    body: JSON.stringify(request),
  });
}

export async function respondToPermission(
  sessionId: string,
  requestId: string,
  request: PermissionResponseRequest,
): Promise<void> {
  await requestJson<{ ok: true }>(
    `/api/sessions/${sessionId}/permissions/${encodeURIComponent(requestId)}/respond`,
    {
      method: "POST",
      body: JSON.stringify(request),
    },
  );
}

export async function readWorkspace(
  sessionId: string,
): Promise<WorkspaceSnapshotResponse> {
  return requestJson<WorkspaceSnapshotResponse>(`/api/sessions/${sessionId}/workspace`);
}

export async function readGitStatus(sessionId: string): Promise<GitStatusResponse> {
  return requestJson<GitStatusResponse>(`/api/sessions/${sessionId}/git-status`);
}

export async function readGitDiff(
  sessionId: string,
  path: string,
  options?: {
    staged?: boolean;
    ignoreWhitespace?: boolean;
  },
): Promise<GitDiffResponse> {
  const query = new URLSearchParams({ path });
  if (options?.staged !== undefined) {
    query.set("staged", options.staged ? "true" : "false");
  }
  if (options?.ignoreWhitespace !== undefined) {
    query.set("ignoreWhitespace", options.ignoreWhitespace ? "true" : "false");
  }
  return requestJson<GitDiffResponse>(
    `/api/sessions/${sessionId}/git-diff?${query.toString()}`,
  );
}

export async function applyGitHunkAction(
  sessionId: string,
  request: GitHunkActionRequest,
): Promise<GitHunkActionResponse> {
  return requestJson<GitHunkActionResponse>(`/api/sessions/${sessionId}/git-hunks/apply`, {
    method: "POST",
    body: JSON.stringify(request),
  });
}

export async function applyGitFileAction(
  sessionId: string,
  request: GitFileActionRequest,
): Promise<GitFileActionResponse> {
  return requestJson<GitFileActionResponse>(`/api/sessions/${sessionId}/git-files/apply`, {
    method: "POST",
    body: JSON.stringify(request),
  });
}

export async function readSessionFile(
  sessionId: string,
  path: string,
): Promise<SessionFileResponse> {
  const query = new URLSearchParams({ path });
  return requestJson<SessionFileResponse>(
    `/api/sessions/${sessionId}/file?${query.toString()}`,
  );
}

export async function searchSessionFiles(
  sessionId: string,
  queryText: string,
  limit = 100,
): Promise<SessionFileSearchResponse> {
  const query = new URLSearchParams({
    query: queryText,
    limit: String(limit),
  });
  return requestJson<SessionFileSearchResponse>(
    `/api/sessions/${sessionId}/file-search?${query.toString()}`,
  );
}

export async function readSessionHistory(
  sessionId: string,
  options?: { beforeTs?: string; cursor?: string; limit?: number },
): Promise<SessionHistoryPageResponse> {
  const query = new URLSearchParams();
  if (options?.beforeTs) {
    query.set("beforeTs", options.beforeTs);
  }
  if (options?.cursor) {
    query.set("cursor", options.cursor);
  }
  if (options?.limit !== undefined) {
    query.set("limit", String(options.limit));
  }
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return requestJson<SessionHistoryPageResponse>(
    `/api/sessions/${sessionId}/history${suffix}`,
  );
}

export function createEventsSocket(
  subscription: EventSubscriptionRequest,
  onBatch: (batch: EventBatch) => void,
  onError?: (error: Error) => void,
  options?: {
    onOpen?: () => void;
    onClose?: () => void;
  },
): WebSocket {
  const url = new URL("/api/events", getBaseUrl().replace(/^http/, "ws"));
  if (subscription.replayFromSeq !== undefined) {
    url.searchParams.set("replayFromSeq", String(subscription.replayFromSeq));
  }
  const socket = new WebSocket(url);
  socket.addEventListener("open", () => {
    options?.onOpen?.();
    socket.send(JSON.stringify(subscription));
  });
  socket.addEventListener("message", (event) => {
    try {
      onBatch(JSON.parse(event.data as string) as EventBatch);
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  });
  socket.addEventListener("error", () => {
    onError?.(new Error("Events socket failed"));
  });
  socket.addEventListener("close", () => {
    options?.onClose?.();
  });
  return socket;
}

export function createPtySocket(
  sessionId: string,
  onMessage: (message: PtyServerMessage) => void,
  onError?: (error: Error) => void,
): WebSocket {
  const url = new URL(`/api/pty/${sessionId}`, getBaseUrl().replace(/^http/, "ws"));
  url.searchParams.set("replay", "true");
  const socket = new WebSocket(url);
  socket.addEventListener("message", (event) => {
    try {
      onMessage(JSON.parse(event.data as string) as PtyServerMessage);
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  });
  socket.addEventListener("error", () => {
    onError?.(new Error("PTY socket failed"));
  });
  return socket;
}

export function sendPtyMessage(socket: WebSocket, message: PtyClientMessage): void {
  socket.send(JSON.stringify(message));
}
