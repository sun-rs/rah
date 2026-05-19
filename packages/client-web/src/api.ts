import type {
  AddCouncilAgentRequest,
  AddCouncilAgentResponse,
  AddManualProviderModelRequest,
  AddManualProviderModelResponse,
  AttachSessionRequest,
  AttachSessionResponse,
  CloseTuiMuxSessionResponse,
  CloseSessionRequest,
  CouncilAgentTuiResponse,
  CouncilMessagesPageResponse,
  CouncilMcpRequest,
  CouncilMcpResponse,
  CouncilPostMessageRequest,
  CouncilPostMessageResponse,
  CouncilReinjectAgentsResponse,
  CouncilRemoveAgentResponse,
  CouncilStopAgentResponse,
  CreateCouncilRequest,
  CreateCouncilResponse,
  DeleteManualProviderModelOptionResponse,
  DeleteManualProviderModelResponse,
  DebugScenarioDescriptor,
  DetachSessionRequest,
  EventBatch,
  EventSubscriptionRequest,
  GitDiffResponse,
  GitFileActionRequest,
  GitFileActionResponse,
  GitHunkActionRequest,
  GitHunkActionResponse,
  IndependentTerminalSession,
  IndependentTerminalListResponse,
  IndependentTerminalStartRequest,
  IndependentTerminalStartResponse,
  GitStatusResponse,
  SessionFileSearchResponse,
  ListDebugScenariosResponse,
  ListManualProviderModelsResponse,
  ListNativeTuiDiagnosticsResponse,
  ListPtyStatsResponse,
  ListProviderModelsResponse,
  ListProvidersResponse,
  ListCouncilsResponse,
  ListTuiMuxDiagnosticsResponse,
  NativeTuiDiagnostic,
  NativeTuiSurfaceResponse,
  NativeTuiClientCloseRequest,
  ListSessionsResponse,
  ManualProviderModel,
  ProviderDiagnostic,
  ProviderKind,
  ProviderModelCatalog,
  PtyClientMessage,
  PtySessionStats,
  TuiMuxSessionDiagnostic,
  PtyServerMessage,
  PermissionResponseRequest,
  RenameCouncilRequest,
  RenameCouncilResponse,
  RenameSessionRequest,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SetSessionModeRequest,
  SetSessionModelRequest,
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

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function buildRequestHeaders(init?: RequestInit): Headers {
  const headers = new Headers(init?.headers ?? {});
  if (init?.body !== undefined && init.body !== null && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (typeof window !== "undefined" && !headers.has("x-rah-client")) {
    headers.set("x-rah-client", "web");
  }
  return headers;
}

function extractResponseErrorMessage(response: Response, raw: string): string {
  const fallback = `Request failed: ${response.status} ${response.statusText}`;
  if (!raw.trim()) {
    return fallback;
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(raw) as { error?: string; message?: string };
      const structuredMessage = parsed.error ?? parsed.message;
      if (typeof structuredMessage === "string" && structuredMessage.trim()) {
        return structuredMessage;
      }
    } catch {
      return fallback;
    }
  }
  return fallback;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${getBaseUrl()}${path}`, {
      ...init,
      headers: buildRequestHeaders(init),
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    throw new Error(error instanceof Error ? error.message : "Network request failed.");
  }
  if (!response.ok) {
    let raw = "";
    try {
      raw = await response.text();
    } catch {
      raw = "";
    }
    throw new Error(extractResponseErrorMessage(response, raw));
  }
  return (await response.json()) as T;
}

export async function listSessions(): Promise<ListSessionsResponse> {
  return requestJson<ListSessionsResponse>("/api/sessions");
}

export async function getNativeTuiSurface(
  sessionId: string,
): Promise<NativeTuiSurfaceResponse> {
  return requestJson<NativeTuiSurfaceResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}/tui-surface`,
  );
}

export async function closeNativeTuiClient(
  sessionId: string,
  request: NativeTuiClientCloseRequest,
): Promise<NativeTuiSurfaceResponse> {
  return requestJson<NativeTuiSurfaceResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}/tui-client/close`,
    {
      method: "POST",
      body: JSON.stringify(request),
    },
  );
}

export async function writeHostClipboard(text: string): Promise<{ ok: true }> {
  return requestJson<{ ok: true }>("/api/host/clipboard", {
    method: "POST",
    body: JSON.stringify({ text }),
  });
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

export async function listDirectory(
  path: string,
  options?: { signal?: AbortSignal },
): Promise<DirectoryListingResponse> {
  const encoded = encodeURIComponent(path);
  return requestJson<DirectoryListingResponse>(`/api/fs/list?path=${encoded}`, {
    ...(options?.signal ? { signal: options.signal } : {}),
  });
}

export async function ensureDirectory(
  request: WorkspaceDirectoryRequest,
): Promise<WorkspaceDirectoryResponse> {
  return requestJson<WorkspaceDirectoryResponse>("/api/fs/ensure-dir", {
    method: "POST",
    body: JSON.stringify(request),
  });
}

export async function startIndependentTerminal(
  request: IndependentTerminalStartRequest,
): Promise<IndependentTerminalSession> {
  const response = await requestJson<IndependentTerminalStartResponse>("/api/terminal/start", {
    method: "POST",
    body: JSON.stringify(request),
  });
  return response.terminal;
}

export async function listIndependentTerminals(options?: {
  cwd?: string;
  owner?: IndependentTerminalStartRequest["owner"];
}): Promise<IndependentTerminalSession[]> {
  const params = new URLSearchParams();
  if (options?.cwd) {
    params.set("cwd", options.cwd);
  }
  if (options?.owner) {
    params.set("ownerKind", options.owner.kind);
    params.set("ownerId", options.owner.id);
  }
  const search = params.size > 0 ? `?${params.toString()}` : "";
  const response = await requestJson<IndependentTerminalListResponse>(`/api/terminal/list${search}`, {
    method: "GET",
  });
  return response.terminals;
}

export async function closeIndependentTerminal(terminalId: string): Promise<void> {
  await requestJson<{ ok: true }>(`/api/terminal/${terminalId}/close`, {
    method: "POST",
  });
}

export async function listDebugScenarios(): Promise<DebugScenarioDescriptor[]> {
  const response =
    await requestJson<ListDebugScenariosResponse>("/api/debug/scenarios");
  return response.scenarios;
}

export async function listProviders(options?: {
  forceRefresh?: boolean;
  signal?: AbortSignal;
}): Promise<ProviderDiagnostic[]> {
  const search = options?.forceRefresh ? "?refresh=1" : "";
  const response = await requestJson<ListProvidersResponse>(`/api/providers${search}`, {
    ...(options?.signal ? { signal: options.signal } : {}),
  });
  return response.providers;
}

export async function listNativeTuiDiagnostics(options?: {
  sessionId?: string;
  includeResolved?: boolean;
  signal?: AbortSignal;
}): Promise<NativeTuiDiagnostic[]> {
  const query = new URLSearchParams();
  if (options?.sessionId) {
    query.set("sessionId", options.sessionId);
  }
  if (options?.includeResolved) {
    query.set("includeResolved", "1");
  }
  const suffix = query.size ? `?${query.toString()}` : "";
  const response = await requestJson<ListNativeTuiDiagnosticsResponse>(
    `/api/native-tui/diagnostics${suffix}`,
    {
      ...(options?.signal ? { signal: options.signal } : {}),
    },
  );
  return response.diagnostics;
}

export async function listPtyStats(options?: { signal?: AbortSignal }): Promise<PtySessionStats[]> {
  const response = await requestJson<ListPtyStatsResponse>("/api/pty/stats", {
    ...(options?.signal ? { signal: options.signal } : {}),
  });
  return response.sessions;
}

export async function listTuiMuxDiagnostics(options?: {
  signal?: AbortSignal;
}): Promise<TuiMuxSessionDiagnostic[]> {
  const response = await requestJson<ListTuiMuxDiagnosticsResponse>(
    "/api/tui-mux/diagnostics",
    {
      ...(options?.signal ? { signal: options.signal } : {}),
    },
  );
  return response.sessions;
}

export async function closeTuiMuxSession(sessionName: string): Promise<void> {
  await requestJson<CloseTuiMuxSessionResponse>(
    `/api/tui-mux/sessions/${encodeURIComponent(sessionName)}/close`,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
  );
}

export async function listProviderModels(
  provider: ProviderKind,
  options?: {
    cwd?: string;
    forceRefresh?: boolean;
    signal?: AbortSignal;
  },
): Promise<ProviderModelCatalog> {
  const query = new URLSearchParams();
  if (options?.cwd) {
    query.set("cwd", options.cwd);
  }
  if (options?.forceRefresh) {
    query.set("refresh", "1");
  }
  const suffix = query.size ? `?${query.toString()}` : "";
  const response = await requestJson<ListProviderModelsResponse>(
    `/api/providers/${provider}/models${suffix}`,
    {
      ...(options?.signal ? { signal: options.signal } : {}),
    },
  );
  return response.catalog;
}

export async function listManualProviderModels(
  provider: ProviderKind,
  options?: { signal?: AbortSignal },
): Promise<ManualProviderModel[]> {
  const response = await requestJson<ListManualProviderModelsResponse>(
    `/api/providers/${provider}/manual-models`,
    {
      ...(options?.signal ? { signal: options.signal } : {}),
    },
  );
  return response.models;
}

export async function addManualProviderModel(
  provider: ProviderKind,
  request: AddManualProviderModelRequest,
): Promise<AddManualProviderModelResponse> {
  return requestJson<AddManualProviderModelResponse>(
    `/api/providers/${provider}/manual-models`,
    {
      method: "POST",
      body: JSON.stringify(request),
    },
  );
}

export async function deleteManualProviderModel(
  provider: ProviderKind,
  modelId: string,
  options?: { cwd?: string },
): Promise<DeleteManualProviderModelResponse> {
  const query = new URLSearchParams();
  if (options?.cwd) {
    query.set("cwd", options.cwd);
  }
  const suffix = query.size ? `?${query.toString()}` : "";
  return requestJson<DeleteManualProviderModelResponse>(
    `/api/providers/${provider}/manual-models/${encodeURIComponent(modelId)}${suffix}`,
    { method: "DELETE" },
  );
}

export async function deleteManualProviderModelOption(
  provider: ProviderKind,
  modelId: string,
  optionId: string,
  options?: { cwd?: string },
): Promise<DeleteManualProviderModelOptionResponse> {
  const query = new URLSearchParams();
  if (options?.cwd) {
    query.set("cwd", options.cwd);
  }
  const suffix = query.size ? `?${query.toString()}` : "";
  return requestJson<DeleteManualProviderModelOptionResponse>(
    `/api/providers/${provider}/manual-models/${encodeURIComponent(modelId)}/options/${encodeURIComponent(optionId)}${suffix}`,
    { method: "DELETE" },
  );
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

export async function claimControl(
  sessionId: string,
  clientId: string,
  connectionId = clientId,
): Promise<SessionSummary> {
  const response = await requestJson<{ session: SessionSummary }>(
    `/api/sessions/${sessionId}/control/claim`,
    {
      method: "POST",
      body: JSON.stringify({
        client: {
          id: clientId,
          kind: "web",
          connectionId,
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

export async function renameSession(
  sessionId: string,
  request: RenameSessionRequest,
): Promise<SessionSummary> {
  const response = await requestJson<{ session: SessionSummary }>(`/api/sessions/${sessionId}/rename`, {
    method: "POST",
    body: JSON.stringify(request),
  });
  return response.session;
}

export async function setSessionMode(
  sessionId: string,
  request: SetSessionModeRequest,
): Promise<SessionSummary> {
  const response = await requestJson<{ session: SessionSummary }>(`/api/sessions/${sessionId}/mode`, {
    method: "POST",
    body: JSON.stringify(request),
  });
  return response.session;
}

export async function setSessionModel(
  sessionId: string,
  request: SetSessionModelRequest,
): Promise<SessionSummary> {
  const response = await requestJson<{ session: SessionSummary }>(`/api/sessions/${sessionId}/model`, {
    method: "POST",
    body: JSON.stringify(request),
  });
  return response.session;
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
  options?: { scopeRoot?: string },
): Promise<WorkspaceSnapshotResponse> {
  const query = new URLSearchParams();
  if (options?.scopeRoot) {
    query.set("scopeRoot", options.scopeRoot);
  }
  const suffix = query.size ? `?${query.toString()}` : "";
  return requestJson<WorkspaceSnapshotResponse>(`/api/sessions/${sessionId}/workspace${suffix}`);
}

export async function readGitStatus(
  sessionId: string,
  options?: { scopeRoot?: string },
): Promise<GitStatusResponse> {
  const query = new URLSearchParams();
  if (options?.scopeRoot) {
    query.set("scopeRoot", options.scopeRoot);
  }
  const suffix = query.size ? `?${query.toString()}` : "";
  return requestJson<GitStatusResponse>(`/api/sessions/${sessionId}/git-status${suffix}`);
}

export async function readWorkspaceGitStatus(dir: string): Promise<GitStatusResponse> {
  const query = new URLSearchParams({ dir });
  return requestJson<GitStatusResponse>(`/api/workspace/git-status?${query.toString()}`);
}

export async function readGitDiff(
  sessionId: string,
  path: string,
  options?: {
    staged?: boolean;
    ignoreWhitespace?: boolean;
    scopeRoot?: string;
  },
): Promise<GitDiffResponse> {
  const query = new URLSearchParams({ path });
  if (options?.staged !== undefined) {
    query.set("staged", options.staged ? "true" : "false");
  }
  if (options?.ignoreWhitespace !== undefined) {
    query.set("ignoreWhitespace", options.ignoreWhitespace ? "true" : "false");
  }
  if (options?.scopeRoot) {
    query.set("scopeRoot", options.scopeRoot);
  }
  return requestJson<GitDiffResponse>(
    `/api/sessions/${sessionId}/git-diff?${query.toString()}`,
  );
}

export async function readWorkspaceGitDiff(
  dir: string,
  path: string,
  options?: {
    staged?: boolean;
    ignoreWhitespace?: boolean;
  },
): Promise<GitDiffResponse> {
  const query = new URLSearchParams({ dir, path });
  if (options?.staged !== undefined) {
    query.set("staged", options.staged ? "true" : "false");
  }
  if (options?.ignoreWhitespace !== undefined) {
    query.set("ignoreWhitespace", options.ignoreWhitespace ? "true" : "false");
  }
  return requestJson<GitDiffResponse>(`/api/workspace/git-diff?${query.toString()}`);
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
  options?: { scopeRoot?: string },
): Promise<SessionFileResponse> {
  const query = new URLSearchParams({ path });
  if (options?.scopeRoot) {
    query.set("scopeRoot", options.scopeRoot);
  }
  return requestJson<SessionFileResponse>(
    `/api/sessions/${sessionId}/file?${query.toString()}`,
  );
}

export async function readWorkspaceFile(
  dir: string,
  path: string,
): Promise<SessionFileResponse> {
  const query = new URLSearchParams({ dir, path });
  return requestJson<SessionFileResponse>(`/api/workspace/file?${query.toString()}`);
}

export async function searchSessionFiles(
  sessionId: string,
  queryText: string,
  limit = 100,
  scopeRoot?: string,
): Promise<SessionFileSearchResponse> {
  const query = new URLSearchParams({
    query: queryText,
    limit: String(limit),
  });
  if (scopeRoot) {
    query.set("scopeRoot", scopeRoot);
  }
  return requestJson<SessionFileSearchResponse>(
    `/api/sessions/${sessionId}/file-search?${query.toString()}`,
  );
}

export async function searchWorkspaceFilesByDirectory(
  dir: string,
  queryText: string,
  limit = 100,
): Promise<SessionFileSearchResponse> {
  const query = new URLSearchParams({
    dir,
    query: queryText,
    limit: String(limit),
  });
  return requestJson<SessionFileSearchResponse>(
    `/api/workspace/file-search?${query.toString()}`,
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

export async function listCouncils(): Promise<ListCouncilsResponse> {
  return requestJson<ListCouncilsResponse>("/api/council");
}

export async function readCouncilMessages(
  councilId: string,
  options?: { beforeMessageId?: number; limit?: number },
): Promise<CouncilMessagesPageResponse> {
  const query = new URLSearchParams();
  if (options?.beforeMessageId !== undefined) {
    query.set("beforeMessageId", String(options.beforeMessageId));
  }
  if (options?.limit !== undefined) {
    query.set("limit", String(options.limit));
  }
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return requestJson<CouncilMessagesPageResponse>(
    `/api/council/${encodeURIComponent(councilId)}/messages${suffix}`,
  );
}

export async function createCouncil(
  request: CreateCouncilRequest,
): Promise<CreateCouncilResponse> {
  return requestJson<CreateCouncilResponse>("/api/council", {
    method: "POST",
    body: JSON.stringify(request),
  });
}

export async function renameCouncil(
  councilId: string,
  request: RenameCouncilRequest,
): Promise<RenameCouncilResponse> {
  return requestJson<RenameCouncilResponse>(
    `/api/council/${encodeURIComponent(councilId)}/rename`,
    {
      method: "POST",
      body: JSON.stringify(request),
    },
  );
}

export async function addCouncilAgent(
  councilId: string,
  request: AddCouncilAgentRequest,
): Promise<AddCouncilAgentResponse> {
  return requestJson<AddCouncilAgentResponse>(
    `/api/council/${encodeURIComponent(councilId)}/agents`,
    {
      method: "POST",
      body: JSON.stringify(request),
    },
  );
}

export async function postCouncilMessage(
  councilId: string,
  request: CouncilPostMessageRequest,
): Promise<CouncilPostMessageResponse> {
  return requestJson<CouncilPostMessageResponse>(
    `/api/council/${encodeURIComponent(councilId)}/messages`,
    {
      method: "POST",
      body: JSON.stringify(request),
    },
  );
}

export async function stopCouncil(councilId: string): Promise<{ ok: true }> {
  return requestJson<{ ok: true }>(
    `/api/council/${encodeURIComponent(councilId)}/stop`,
    { method: "POST", body: JSON.stringify({}) },
  );
}

export async function deleteCouncil(councilId: string): Promise<{ ok: true }> {
  return requestJson<{ ok: true }>(
    `/api/council/${encodeURIComponent(councilId)}/delete`,
    { method: "POST", body: JSON.stringify({}) },
  );
}

export async function getCouncilAgentTui(
  councilId: string,
  agentId: string,
): Promise<CouncilAgentTuiResponse> {
  return requestJson<CouncilAgentTuiResponse>(
    `/api/council/${encodeURIComponent(councilId)}/agents/${encodeURIComponent(agentId)}/tui`,
  );
}

export async function reinjectCouncilAgentPrompt(
  councilId: string,
  agentId: string,
): Promise<CouncilReinjectAgentsResponse> {
  return requestJson<CouncilReinjectAgentsResponse>(
    `/api/council/${encodeURIComponent(councilId)}/agents/${encodeURIComponent(agentId)}/reinject`,
    { method: "POST", body: JSON.stringify({}) },
  );
}

export async function removeCouncilAgent(
  councilId: string,
  agentId: string,
): Promise<CouncilRemoveAgentResponse> {
  return requestJson<CouncilRemoveAgentResponse>(
    `/api/council/${encodeURIComponent(councilId)}/agents/${encodeURIComponent(agentId)}/remove`,
    { method: "POST", body: JSON.stringify({}) },
  );
}

export async function stopCouncilAgent(
  councilId: string,
  agentId: string,
): Promise<CouncilStopAgentResponse> {
  return requestJson<CouncilStopAgentResponse>(
    `/api/council/${encodeURIComponent(councilId)}/agents/${encodeURIComponent(agentId)}/stop`,
    { method: "POST", body: JSON.stringify({}) },
  );
}

export async function callCouncilMcpTool(
  request: CouncilMcpRequest,
): Promise<CouncilMcpResponse> {
  return requestJson<CouncilMcpResponse>("/api/council/mcp", {
    method: "POST",
    body: JSON.stringify(request),
  });
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
  options?: { fromSeq?: number; replay?: boolean; replayTailBytes?: number },
): WebSocket {
  const url = new URL(`/api/pty/${sessionId}`, getBaseUrl().replace(/^http/, "ws"));
  url.searchParams.set("replay", options?.replay === false ? "false" : "true");
  if (options?.fromSeq !== undefined) {
    url.searchParams.set("fromSeq", String(options.fromSeq));
  } else if (options?.replayTailBytes !== undefined) {
    url.searchParams.set("tailBytes", String(options.replayTailBytes));
  }
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
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(JSON.stringify(message));
}
