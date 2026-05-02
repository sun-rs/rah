import type {
  AttachClientDescriptor,
  AttachSessionRequest,
  ClaimControlRequest,
  CloseSessionRequest,
  DetachSessionRequest,
  GitFileActionRequest,
  GitHunkActionRequest,
  IndependentTerminalStartRequest,
  InterruptSessionRequest,
  PermissionResponseRequest,
  ProviderKind,
  ReleaseControlRequest,
  ResumeSessionRequest,
  SessionConfigValue,
  SessionInputRequest,
  SetSessionModelRequest,
  StartDebugScenarioRequest,
  StartSessionRequest,
  StoredSessionRemoveRequest,
  WorkspaceDirectoryRequest,
} from "@rah/runtime-protocol";

type JsonRecord = Record<string, unknown>;

const PROVIDERS = new Set<ProviderKind>(["codex", "claude", "kimi", "gemini", "opencode", "custom"]);
const CLIENT_KINDS = new Set(["terminal", "web", "ios", "ipad", "api"]);
const APPROVAL_POLICIES = new Set(["default", "on-request", "never", "auto_edit", "yolo"]);

export function parseIndependentTerminalStartRequest(body: unknown): IndependentTerminalStartRequest {
  const record = optionalObjectBody(body);
  const request: IndependentTerminalStartRequest = {};
  const cwd = optionalString(record, "cwd");
  const cols = optionalNumber(record, "cols");
  const rows = optionalNumber(record, "rows");
  if (cwd !== undefined) {
    request.cwd = cwd;
  }
  if (cols !== undefined) {
    request.cols = cols;
  }
  if (rows !== undefined) {
    request.rows = rows;
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
  const command = optionalString(record, "command");
  const args = optionalStringArray(record, "args");
  const initialPrompt = optionalString(record, "initialPrompt");
  if (title !== undefined) {
    request.title = title;
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
  const preferStoredReplay = optionalBoolean(record, "preferStoredReplay");
  const historyReplay = optionalEnum(record, "historyReplay", ["include", "skip"]);
  const historySourceSessionId = optionalString(record, "historySourceSessionId");
  if (cwd !== undefined) {
    request.cwd = cwd;
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
  if (record.attach !== undefined) {
    request.attach = parseAttachPayload(record.attach);
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
  return {
    clientId: requireString(record, "clientId"),
    text: requireString(record, "text"),
  };
}

export function parseInterruptSessionRequest(body: unknown): InterruptSessionRequest {
  const record = requireObjectBody(body);
  return { clientId: requireString(record, "clientId") };
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
  const record = requireObjectBody(body);
  const title = requireString(record, "title").trim();
  if (!title) {
    throw badRequest("Session title is required.");
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
  const modelId = requireString(record, "modelId").trim();
  if (!modelId) {
    throw badRequest("Session model is required.");
  }
  const request: SetSessionModelRequest = { modelId };
  const optionValues = optionalConfigValues(record, "optionValues");
  if (optionValues !== undefined) {
    request.optionValues = optionValues;
  }
  if (record.reasoningId === null || typeof record.reasoningId === "string") {
    request.reasoningId = record.reasoningId;
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
  const decision = optionalString(record, "decision");
  if (message !== undefined) {
    request.message = message;
  }
  if (selectedActionId !== undefined) {
    request.selectedActionId = selectedActionId;
  }
  if (decision !== undefined) {
    request.decision = decision as NonNullable<PermissionResponseRequest["decision"]>;
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
  const config: Partial<StartSessionRequest & ResumeSessionRequest> = {};
  const model = optionalString(record, "model");
  const optionValues = optionalConfigValues(record, "optionValues");
  const providerConfig = optionalConfigValues(record, "providerConfig");
  const modeId = optionalString(record, "modeId");
  const approvalPolicy = optionalApprovalPolicy(record);
  const sandbox = optionalString(record, "sandbox");
  if (model !== undefined) {
    config.model = model;
  }
  if (optionValues !== undefined) {
    config.optionValues = optionValues;
  }
  if (typeof record.reasoningId === "string") {
    config.reasoningId = record.reasoningId;
  }
  if (providerConfig !== undefined) {
    config.providerConfig = providerConfig;
  }
  if (modeId !== undefined) {
    config.modeId = modeId;
  }
  if (approvalPolicy !== undefined) {
    config.approvalPolicy = approvalPolicy;
  }
  if (sandbox !== undefined) {
    config.sandbox = sandbox;
  }
  return config;
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

function optionalApprovalPolicy(record: JsonRecord): StartSessionRequest["approvalPolicy"] {
  const value = optionalString(record, "approvalPolicy");
  if (value === undefined) {
    return undefined;
  }
  if (!APPROVAL_POLICIES.has(value)) {
    throw badRequest("approvalPolicy is invalid.");
  }
  return value as StartSessionRequest["approvalPolicy"];
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

function badRequest(message: string): Error {
  return new Error(`Bad Request: ${message}`);
}
