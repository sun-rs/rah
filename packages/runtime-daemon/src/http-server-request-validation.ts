import type {
  AddCouncilAgentRequest,
  AddManualProviderModelRequest,
  AttachClientDescriptor,
  AttachSessionRequest,
  ClaimControlRequest,
  CloseSessionRequest,
  CouncilAgentConfig,
  CouncilMcpRequest,
  CouncilMcpToolName,
  CouncilPostMessageRequest,
  CreateCouncilRequest,
  DetachSessionRequest,
  DeleteQueuedInputRequest,
  GitFileActionRequest,
  GitHunkActionRequest,
  ForkSessionRequest,
  IndependentTerminalStartRequest,
  InterruptSessionRequest,
  NativeTuiSurfaceClaimRequest,
  NativeTuiClientCloseRequest,
  NativeTuiSurfaceReleaseRequest,
  PermissionResponseRequest,
  ProviderKind,
  ReleaseControlRequest,
  ReorderQueuedInputRequest,
  ResumeSessionRequest,
  SessionConfigValue,
  SessionInputAttachment,
  SessionInputAnnotation,
  SessionInputRequest,
  SetInputQueuePolicyRequest,
  SetSessionModelRequest,
  StartDebugScenarioRequest,
  StartSessionRequest,
  SteerQueuedInputRequest,
  StoredSessionRemoveRequest,
  StoredSessionArchiveRequest,
  UpdateQueuedInputRequest,
  UpdateWorkbenchPinnedItemRequest,
  WorkspaceDirectoryRequest,
} from "@rah/runtime-protocol";

type JsonRecord = Record<string, unknown>;

const PROVIDERS = new Set<ProviderKind>(["codex", "claude", "opencode", "custom"]);
const COUNCIL_PROVIDERS = new Set<ProviderKind>(["codex", "claude", "opencode"]);
const CLIENT_KINDS = new Set(["web", "ios", "ipad", "api"]);
const PUBLIC_LIVE_BACKENDS = new Set([
  "native_tui",
  "tui_mux",
  "native_local_server",
]);
const REMOVED_SESSION_CONFIG_FIELDS = new Set([
  "reasoningId",
  "providerConfig",
  "approvalPolicy",
  "sandbox",
]);
const COUNCIL_MCP_TOOLS = new Set<CouncilMcpToolName>([
  "channel_join",
  "channel_post",
  "channel_wait_new",
  "channel_history",
  "channel_state",
  "channel_peek_inbox",
  "channel_set_status",
  "channel_claim_file",
  "channel_release_file",
  "channel_list_claims",
  "channel_send_control",
  "channel_peek_control",
]);

export function parseIndependentTerminalStartRequest(body: unknown): IndependentTerminalStartRequest {
  const record = optionalObjectBody(body);
  const request: IndependentTerminalStartRequest = {};
  const cwd = optionalString(record, "cwd");
  const cols = optionalNumber(record, "cols");
  const rows = optionalNumber(record, "rows");
  const owner = optionalObject(record, "owner");
  if (cwd !== undefined) {
    request.cwd = cwd;
  }
  if (cols !== undefined) {
    request.cols = cols;
  }
  if (rows !== undefined) {
    request.rows = rows;
  }
  if (owner !== undefined) {
    const kind = optionalEnum(owner, "kind", ["workspace", "session"]);
    const id = optionalString(owner, "id");
    if (!kind || !id) {
      throw badRequest("terminal owner requires kind and id.");
    }
    request.owner = { kind: kind as "workspace" | "session", id };
  }
  return request;
}

export function parseStartSessionRequest(body: unknown): StartSessionRequest {
  const record = requireObjectBody(body);
  const request: StartSessionRequest = {
    provider: requireProvider(record, "provider"),
    cwd: requireString(record, "cwd"),
  };
  Object.assign(request, parseOptionalSessionConfig(record));
  const title = optionalString(record, "title");
  const liveBackend = optionalEnum(record, "liveBackend", [...PUBLIC_LIVE_BACKENDS]);
  const command = optionalString(record, "command");
  const args = optionalStringArray(record, "args");
  const initialPrompt = optionalString(record, "initialPrompt");
  const initialClientMessageId = optionalString(record, "initialClientMessageId");
  const initialClientTurnId = optionalString(record, "initialClientTurnId");
  if (title !== undefined) {
    request.title = title;
  }
  if (liveBackend !== undefined) {
    request.liveBackend = liveBackend as NonNullable<StartSessionRequest["liveBackend"]>;
  }
  if (command !== undefined) {
    request.command = command;
  }
  if (args !== undefined) {
    request.args = args;
  }
  if (initialPrompt !== undefined) {
    request.initialPrompt = initialPrompt;
  }
  if (initialClientMessageId !== undefined) {
    request.initialClientMessageId = initialClientMessageId;
  }
  if (initialClientTurnId !== undefined) {
    request.initialClientTurnId = initialClientTurnId;
  }
  if (record.initialInput !== undefined) {
    request.initialInput = parseSessionInputRequest(record.initialInput);
  }
  if (record.attach !== undefined) {
    request.attach = parseAttachPayload(record.attach);
  }
  return request;
}

export function parseResumeSessionRequest(body: unknown): ResumeSessionRequest {
  const record = requireObjectBody(body);
  const request: ResumeSessionRequest = {
    provider: requireProvider(record, "provider"),
    providerSessionId: requireString(record, "providerSessionId"),
  };
  Object.assign(request, parseOptionalSessionConfig(record));
  const cwd = optionalString(record, "cwd");
  const liveBackend = optionalEnum(record, "liveBackend", [...PUBLIC_LIVE_BACKENDS]);
  const preferStoredReplay = optionalBoolean(record, "preferStoredReplay");
  const historyReplay = optionalEnum(record, "historyReplay", ["include", "skip"]);
  const historySourceSessionId = optionalString(record, "historySourceSessionId");
  if (cwd !== undefined) {
    request.cwd = cwd;
  }
  if (liveBackend !== undefined) {
    request.liveBackend = liveBackend as NonNullable<ResumeSessionRequest["liveBackend"]>;
  }
  if (preferStoredReplay !== undefined) {
    request.preferStoredReplay = preferStoredReplay;
  }
  if (historyReplay !== undefined) {
    request.historyReplay = historyReplay;
  }
  if (historySourceSessionId !== undefined) {
    request.historySourceSessionId = historySourceSessionId;
  }
  if (record.initialInput !== undefined) {
    request.initialInput = parseSessionInputRequest(record.initialInput);
  }
  if (record.attach !== undefined) {
    request.attach = parseAttachPayload(record.attach);
  }
  return request;
}

export function parseForkSessionRequest(body: unknown): ForkSessionRequest {
  const record = requireObjectBody(body);
  const request: ForkSessionRequest = {
    operationId: requireString(record, "operationId"),
    kind: requireEnum(record, "kind", ["fork", "side"]) as ForkSessionRequest["kind"],
    workspaceMode: requireEnum(record, "workspaceMode", [
      "shared",
      "worktree",
    ]) as ForkSessionRequest["workspaceMode"],
  };
  const lastTurnId = optionalString(record, "lastTurnId");
  if (lastTurnId !== undefined) {
    request.lastTurnId = lastTurnId;
  }
  if (record.attach !== undefined) {
    request.attach = parseAttachPayload(record.attach);
  }
  if (request.kind === "side" && request.workspaceMode !== "shared") {
    throw new Error("Side tasks must share the parent workspace.");
  }
  return request;
}

export function parseAttachSessionRequest(body: unknown): AttachSessionRequest {
  return parseAttachPayload(body);
}

export function parseClaimControlRequest(body: unknown): ClaimControlRequest {
  const record = requireObjectBody(body);
  return { client: parseClientDescriptor(record.client) };
}

export function parseReleaseControlRequest(body: unknown): ReleaseControlRequest {
  const record = requireObjectBody(body);
  return { clientId: requireString(record, "clientId") };
}

export function parseSessionInputRequest(body: unknown): SessionInputRequest {
  const record = requireObjectBody(body);
  const request: SessionInputRequest = {
    clientId: requireString(record, "clientId"),
    text: requireString(record, "text"),
  };
  const clientMessageId = optionalString(record, "clientMessageId");
  const clientTurnId = optionalString(record, "clientTurnId");
  const attachments = optionalSessionInputAttachments(record, "attachments");
  const annotations = optionalSessionInputAnnotations(record, "annotations");
  if (clientMessageId !== undefined) {
    request.clientMessageId = clientMessageId;
  }
  if (clientTurnId !== undefined) {
    request.clientTurnId = clientTurnId;
  }
  if (attachments !== undefined) {
    request.attachments = attachments;
  }
  if (annotations !== undefined) {
    request.annotations = annotations;
  }
  if (!request.text.trim() && !request.attachments?.length && !request.annotations?.length) {
    throw badRequest("session input requires text, an attachment, or an annotation.");
  }
  return request;
}

export function parseUpdateQueuedInputRequest(body: unknown): UpdateQueuedInputRequest {
  const record = requireObjectBody(body);
  return {
    clientId: requireString(record, "clientId"),
    text: requireString(record, "text"),
  };
}

export function parseDeleteQueuedInputRequest(body: unknown): DeleteQueuedInputRequest {
  const record = requireObjectBody(body);
  return { clientId: requireString(record, "clientId") };
}

export function parseReorderQueuedInputRequest(body: unknown): ReorderQueuedInputRequest {
  const record = requireObjectBody(body);
  return {
    clientId: requireString(record, "clientId"),
    position: requireNumber(record, "position"),
  };
}

export function parseSteerQueuedInputRequest(body: unknown): SteerQueuedInputRequest {
  const record = requireObjectBody(body);
  return { clientId: requireString(record, "clientId") };
}

export function parseSetInputQueuePolicyRequest(body: unknown): SetInputQueuePolicyRequest {
  const record = requireObjectBody(body);
  return {
    clientId: requireString(record, "clientId"),
    policy: requireEnum(record, "policy", ["queue", "steer"]),
  };
}

export function parseInterruptSessionRequest(body: unknown): InterruptSessionRequest {
  const record = requireObjectBody(body);
  return { clientId: requireString(record, "clientId") };
}

export function parseNativeTuiSurfaceClaimRequest(
  body: unknown,
): NativeTuiSurfaceClaimRequest {
  const record = requireObjectBody(body);
  const request: NativeTuiSurfaceClaimRequest = {
    clientId: requireString(record, "clientId"),
    clientKind: requireEnum(record, "clientKind", [...CLIENT_KINDS]) as NativeTuiSurfaceClaimRequest["clientKind"],
  };
  const surfaceId = optionalString(record, "surfaceId");
  const cols = optionalNumber(record, "cols");
  const rows = optionalNumber(record, "rows");
  if (surfaceId !== undefined) {
    request.surfaceId = surfaceId;
  }
  if (cols !== undefined) {
    request.cols = cols;
  }
  if (rows !== undefined) {
    request.rows = rows;
  }
  return request;
}

export function parseNativeTuiSurfaceReleaseRequest(
  body: unknown,
): NativeTuiSurfaceReleaseRequest {
  const record = requireObjectBody(body);
  const request: NativeTuiSurfaceReleaseRequest = {
    clientId: requireString(record, "clientId"),
  };
  const surfaceId = optionalString(record, "surfaceId");
  if (surfaceId !== undefined) {
    request.surfaceId = surfaceId;
  }
  return request;
}

export function parseNativeTuiClientCloseRequest(
  body: unknown,
): NativeTuiClientCloseRequest {
  const record = requireObjectBody(body);
  const request: NativeTuiClientCloseRequest = {
    clientId: requireString(record, "clientId"),
  };
  const surfaceId = optionalString(record, "surfaceId");
  if (surfaceId !== undefined) {
    request.surfaceId = surfaceId;
  }
  return request;
}

export function parseDetachSessionRequest(body: unknown): DetachSessionRequest {
  const record = requireObjectBody(body);
  return { clientId: requireString(record, "clientId") };
}

export function parseCloseSessionRequest(body: unknown): CloseSessionRequest {
  const record = requireObjectBody(body);
  return { clientId: requireString(record, "clientId") };
}

export function parseRenameSessionRequest(body: unknown): { title: string } {
  return parseRenameTitleRequest(body, "Session");
}

export function parseRenameCouncilRequest(body: unknown): { title: string } {
  return parseRenameTitleRequest(body, "Council");
}

function parseRenameTitleRequest(body: unknown, subject: string): { title: string } {
  const record = requireObjectBody(body);
  const title = requireString(record, "title").trim();
  if (!title) {
    throw badRequest(`${subject} title is required.`);
  }
  return { title };
}

export function parseSetSessionModeRequest(body: unknown): { modeId: string } {
  const record = requireObjectBody(body);
  const modeId = requireString(record, "modeId").trim();
  if (!modeId) {
    throw badRequest("Session mode is required.");
  }
  return { modeId };
}

export function parseSetSessionModelRequest(body: unknown): SetSessionModelRequest {
  const record = requireObjectBody(body);
  rejectRemovedSessionConfigFields(record);
  const modelId = requireString(record, "modelId").trim();
  if (!modelId) {
    throw badRequest("Session model is required.");
  }
  const request: SetSessionModelRequest = { modelId };
  const optionValues = optionalConfigValues(record, "optionValues");
  if (optionValues !== undefined) {
    request.optionValues = optionValues;
  }
  return request;
}

export function parsePermissionResponseRequest(body: unknown): PermissionResponseRequest {
  const record = requireObjectBody(body);
  const request: PermissionResponseRequest = {
    behavior: requireEnum(record, "behavior", ["allow", "deny"]),
  };
  const message = optionalString(record, "message");
  const selectedActionId = optionalString(record, "selectedActionId");
  const decision = optionalEnum(record, "decision", [
    "approved",
    "approved_for_session",
    "denied",
    "abort",
  ]);
  if (message !== undefined) {
    request.message = message;
  }
  if (selectedActionId !== undefined) {
    request.selectedActionId = selectedActionId;
  }
  if (decision !== undefined) {
    request.decision = decision;
  }
  if (record.answers !== undefined) {
    request.answers = requireRecord(record, "answers") as NonNullable<PermissionResponseRequest["answers"]>;
  }
  if (record.updatedInput !== undefined) {
    request.updatedInput = requireRecord(record, "updatedInput") as NonNullable<PermissionResponseRequest["updatedInput"]>;
  }
  return request;
}

export function parseWorkspaceDirectoryRequest(body: unknown): WorkspaceDirectoryRequest {
  const record = requireObjectBody(body);
  return { dir: requireString(record, "dir") };
}

export function parseUpdateWorkbenchPinnedItemRequest(body: unknown): UpdateWorkbenchPinnedItemRequest {
  const record = requireObjectBody(body);
  if (typeof record.pinned !== "boolean") {
    throw new Error("pinned must be a boolean.");
  }
  return {
    workspaceDir: requireString(record, "workspaceDir"),
    itemKey: requireString(record, "itemKey"),
    pinned: record.pinned,
  };
}

export function parseClipboardWriteRequest(body: unknown): { text: string } {
  const record = requireObjectBody(body);
  const text = requireString(record, "text");
  if (text.length > 64 * 1024) {
    throw new Error("Clipboard text is too large.");
  }
  return { text };
}

export function parseStoredSessionRemoveRequest(body: unknown): StoredSessionRemoveRequest {
  const record = requireObjectBody(body);
  return {
    provider: requireProvider(record, "provider"),
    providerSessionId: requireString(record, "providerSessionId"),
  };
}

export function parseStoredSessionArchiveRequest(body: unknown): StoredSessionArchiveRequest {
  const record = requireObjectBody(body);
  const runtimeSessionId = optionalString(record, "runtimeSessionId");
  const clientId = optionalString(record, "clientId");
  if ((runtimeSessionId === undefined) !== (clientId === undefined)) {
    throw new Error("runtimeSessionId and clientId must be provided together.");
  }
  return {
    provider: requireProvider(record, "provider"),
    providerSessionId: requireString(record, "providerSessionId"),
    ...(runtimeSessionId !== undefined ? { runtimeSessionId, clientId: clientId! } : {}),
  };
}

export function parseAddManualProviderModelRequest(body: unknown): AddManualProviderModelRequest {
  const record = requireObjectBody(body);
  const request: AddManualProviderModelRequest = {
    id: requireString(record, "id"),
  };
  const optionIds = optionalStringArray(record, "optionIds");
  const cwd = optionalString(record, "cwd");
  if (optionIds !== undefined) {
    request.optionIds = optionIds;
  }
  if (cwd !== undefined) {
    request.cwd = cwd;
  }
  return request;
}

export function parseCreateCouncilRequest(body: unknown): CreateCouncilRequest {
  const record = requireObjectBody(body);
  const agentsRaw = record.agents;
  if (!Array.isArray(agentsRaw) || agentsRaw.length === 0) {
    throw badRequest("agents must be a non-empty array.");
  }
  const request: CreateCouncilRequest = {
    workspace: requireString(record, "workspace"),
    agents: agentsRaw.map((agent, index) => parseCouncilAgentConfig(agent, index)),
  };
  const title = optionalString(record, "title");
  if (title !== undefined) {
    request.title = title;
  }
  return request;
}

export function parseAddCouncilAgentRequest(body: unknown): AddCouncilAgentRequest {
  const record = requireObjectBody(body);
  return {
    agent: parseCouncilAgentConfig(record.agent, 0),
  };
}

export function parseCouncilPostMessageRequest(body: unknown): CouncilPostMessageRequest {
  const record = requireObjectBody(body);
  const request: CouncilPostMessageRequest = {
    text: requireString(record, "text"),
  };
  const actorId = optionalString(record, "actorId");
  const role = optionalEnum(record, "role", ["user", "agent", "system"]);
  const replyTo = optionalNumber(record, "replyTo");
  if (actorId !== undefined) {
    request.actorId = actorId;
  }
  if (role !== undefined) {
    request.role = role;
  }
  if (replyTo !== undefined) {
    request.replyTo = replyTo;
  }
  return request;
}

export function parseCouncilMcpRequest(body: unknown): CouncilMcpRequest {
  const record = requireObjectBody(body);
  const tool = requireString(record, "tool");
  if (!COUNCIL_MCP_TOOLS.has(tool as CouncilMcpToolName)) {
    throw badRequest("tool is invalid.");
  }
  const request: CouncilMcpRequest = {
    councilId: requireString(record, "councilId"),
    actorId: requireString(record, "actorId"),
    tool: tool as CouncilMcpToolName,
  };
  const clientId = optionalString(record, "clientId");
  if (clientId !== undefined) {
    request.clientId = clientId;
  }
  if (record.arguments !== undefined) {
    request.arguments = requireRecord(record, "arguments");
  }
  return request;
}

export function parseCouncilMcpReadyRequest(body: unknown): {
  councilId: string;
  actorId: string;
} {
  const record = requireObjectBody(body);
  return {
    councilId: requireString(record, "councilId"),
    actorId: requireString(record, "actorId"),
  };
}

export function parseGitFileActionRequest(body: unknown): GitFileActionRequest {
  const record = requireObjectBody(body);
  const request: GitFileActionRequest = {
    path: requireString(record, "path"),
    action: requireEnum(record, "action", ["stage", "unstage"]),
  };
  const staged = optionalBoolean(record, "staged");
  if (staged !== undefined) {
    request.staged = staged;
  }
  return request;
}

export function parseGitHunkActionRequest(body: unknown): GitHunkActionRequest {
  const record = requireObjectBody(body);
  const hunkIndex = requireNumber(record, "hunkIndex");
  if (!Number.isInteger(hunkIndex) || hunkIndex < 0) {
    throw badRequest("hunkIndex must be a non-negative integer.");
  }
  const request: GitHunkActionRequest = {
    path: requireString(record, "path"),
    hunkIndex,
    action: requireEnum(record, "action", ["stage", "unstage", "revert"]),
  };
  const staged = optionalBoolean(record, "staged");
  if (staged !== undefined) {
    request.staged = staged;
  }
  return request;
}

export function parseStartDebugScenarioRequest(body: unknown): StartDebugScenarioRequest {
  const record = requireObjectBody(body);
  const request: StartDebugScenarioRequest = {
    scenarioId: requireString(record, "scenarioId"),
  };
  if (record.attach !== undefined) {
    request.attach = parseAttachPayload(record.attach);
  }
  return request;
}

function parseOptionalSessionConfig(record: JsonRecord): Partial<StartSessionRequest & ResumeSessionRequest> {
  rejectRemovedSessionConfigFields(record);
  const config: Partial<StartSessionRequest & ResumeSessionRequest> = {};
  const model = optionalString(record, "model");
  const optionValues = optionalConfigValues(record, "optionValues");
  const modeId = optionalString(record, "modeId");
  if (model !== undefined) {
    config.model = model;
  }
  if (optionValues !== undefined) {
    config.optionValues = optionValues;
  }
  if (modeId !== undefined) {
    config.modeId = modeId;
  }
  return config;
}

function parseCouncilAgentConfig(value: unknown, index: number): CouncilAgentConfig {
  const record = requireObject(value, `agents[${index}]`);
  rejectRemovedSessionConfigFields(record);
  const provider = requireProvider(record, "provider");
  if (!COUNCIL_PROVIDERS.has(provider)) {
    throw badRequest("Council agent provider must be codex, claude, or opencode.");
  }
  const agent: CouncilAgentConfig = {
    provider: provider as CouncilAgentConfig["provider"],
    label: requireString(record, "label"),
  };
  const id = optionalString(record, "id");
  const role = optionalString(record, "role");
  const modelId = optionalString(record, "modelId");
  const modeId = optionalString(record, "modeId");
  const optionValues = optionalConfigValues(record, "optionValues");
  if (id !== undefined) {
    agent.id = id;
  }
  if (role !== undefined) {
    agent.role = role;
  }
  if (modelId !== undefined) {
    agent.modelId = modelId;
  }
  if (optionValues !== undefined) {
    agent.optionValues = optionValues;
  }
  if (modeId !== undefined) {
    agent.modeId = modeId;
  }
  return agent;
}

function parseAttachPayload(value: unknown): AttachSessionRequest {
  const record = requireObject(value, "attach");
  const request: AttachSessionRequest = {
    client: parseClientDescriptor(record.client),
    mode: requireEnum(record, "mode", ["observe", "interactive"]),
  };
  const claimControl = optionalBoolean(record, "claimControl");
  if (claimControl !== undefined) {
    request.claimControl = claimControl;
  }
  return request;
}

function parseClientDescriptor(value: unknown): AttachClientDescriptor {
  const record = requireObject(value, "client");
  const descriptor: AttachClientDescriptor = {
    id: requireString(record, "id"),
    kind: requireEnum(record, "kind", [...CLIENT_KINDS]) as AttachClientDescriptor["kind"],
    connectionId: requireString(record, "connectionId"),
  };
  const cols = optionalNumber(record, "cols");
  const rows = optionalNumber(record, "rows");
  if (cols !== undefined) {
    descriptor.cols = cols;
  }
  if (rows !== undefined) {
    descriptor.rows = rows;
  }
  return descriptor;
}

function optionalObjectBody(body: unknown): JsonRecord {
  if (body === undefined || body === null) {
    return {};
  }
  return requireObjectBody(body);
}

function requireObjectBody(body: unknown): JsonRecord {
  return requireObject(body, "request body");
}

function requireObject(value: unknown, name: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest(`${name} must be a JSON object.`);
  }
  return value as JsonRecord;
}

function requireRecord(record: JsonRecord, key: string): JsonRecord {
  return requireObject(record[key], key);
}

function optionalObject(record: JsonRecord, key: string): JsonRecord | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  return requireObject(value, key);
}

function requireString(record: JsonRecord, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw badRequest(`${key} is required.`);
  }
  return value;
}

function optionalString(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw badRequest(`${key} must be a string.`);
  }
  return value;
}

function requireNumber(record: JsonRecord, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw badRequest(`${key} must be a finite number.`);
  }
  return value;
}

function optionalNumber(record: JsonRecord, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw badRequest(`${key} must be a finite number.`);
  }
  return value;
}

function optionalBoolean(record: JsonRecord, key: string): boolean | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw badRequest(`${key} must be a boolean.`);
  }
  return value;
}

function optionalStringArray(record: JsonRecord, key: string): string[] | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw badRequest(`${key} must be an array of strings.`);
  }
  return [...value];
}

function optionalSessionInputAttachments(
  record: JsonRecord,
  key: string,
): SessionInputAttachment[] | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw badRequest(`${key} must be an array.`);
  }
  if (value.length > 10) {
    throw badRequest(`${key} cannot contain more than 10 files.`);
  }
  const ids = new Set<string>();
  return value.map((entry, index) => {
    const attachment = requireObject(entry, `${key}[${index}]`);
    const id = requireString(attachment, "id");
    if (ids.has(id)) {
      throw badRequest(`${key} contains duplicate attachment ids.`);
    }
    ids.add(id);
    const kind = requireEnum(attachment, "kind", ["image", "file"]);
    const name = requireString(attachment, "name");
    const mediaType = requireString(attachment, "mediaType");
    const size = requireNumber(attachment, "size");
    if (!Number.isInteger(size) || size < 1) {
      throw badRequest(`${key}[${index}].size must be a positive integer.`);
    }
    return { id, kind, name, mediaType, size };
  });
}

function optionalSessionInputAnnotations(
  record: JsonRecord,
  key: string,
): SessionInputAnnotation[] | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw badRequest(`${key} must be an array.`);
  }
  if (value.length > 20) {
    throw badRequest(`${key} cannot contain more than 20 selections.`);
  }
  const ids = new Set<string>();
  return value.map((entry, index) => {
    const annotationRecord = requireObject(entry, `${key}[${index}]`);
    const id = requireString(annotationRecord, "id");
    if (ids.has(id)) {
      throw badRequest(`${key} contains duplicate annotation ids.`);
    }
    ids.add(id);
    const text = requireString(annotationRecord, "text").trim();
    if (!text) {
      throw badRequest(`${key}[${index}].text cannot be empty.`);
    }
    if (text.length > 20_000) {
      throw badRequest(`${key}[${index}].text is too long.`);
    }
    const annotation = optionalString(annotationRecord, "annotation")?.trim();
    if (annotation && annotation.length > 20_000) {
      throw badRequest(`${key}[${index}].annotation is too long.`);
    }
    const sourceRecord = optionalObject(annotationRecord, "source");
    const entryKey = sourceRecord ? optionalString(sourceRecord, "entryKey") : undefined;
    const role = sourceRecord
      ? optionalEnum(sourceRecord, "role", ["assistant", "user"])
      : undefined;
    const source = sourceRecord
      ? {
          sessionId: requireString(sourceRecord, "sessionId"),
          ...(entryKey !== undefined ? { entryKey } : {}),
          ...(role !== undefined ? { role } : {}),
        }
      : undefined;
    return {
      id,
      text,
      ...(annotation ? { annotation } : {}),
      ...(source ? { source } : {}),
    };
  });
}

function requireProvider(record: JsonRecord, key: string): ProviderKind {
  const value = requireString(record, key);
  if (!PROVIDERS.has(value as ProviderKind)) {
    throw badRequest(`${key} must be a supported provider.`);
  }
  return value as ProviderKind;
}

function requireEnum<const T extends string>(
  record: JsonRecord,
  key: string,
  allowed: readonly T[],
): T {
  const value = requireString(record, key);
  if (!allowed.includes(value as T)) {
    throw badRequest(`${key} is invalid.`);
  }
  return value as T;
}

function optionalEnum<const T extends string>(
  record: JsonRecord,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const value = optionalString(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (!allowed.includes(value as T)) {
    throw badRequest(`${key} is invalid.`);
  }
  return value as T;
}

function optionalConfigValues(record: JsonRecord, key: string): Record<string, SessionConfigValue> | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  const config = requireObject(value, key);
  for (const [configKey, configValue] of Object.entries(config)) {
    if (
      configValue !== null &&
      typeof configValue !== "string" &&
      typeof configValue !== "number" &&
      typeof configValue !== "boolean"
    ) {
      throw badRequest(`${key}.${configKey} must be a primitive config value.`);
    }
  }
  return config as Record<string, SessionConfigValue>;
}

function rejectRemovedSessionConfigFields(record: JsonRecord): void {
  for (const key of REMOVED_SESSION_CONFIG_FIELDS) {
    if (record[key] !== undefined) {
      throw badRequest(
        `${key} was removed; pass model options through optionValues and access policy through modeId.`,
      );
    }
  }
}

function badRequest(message: string): Error {
  return new Error(`Bad Request: ${message}`);
}
