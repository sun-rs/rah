import type {
  AttachMode,
  AttachedClient,
  CapabilityFreshness,
  CapabilitySource,
  ClientKind,
  ControlLease,
  ManagedSession,
  ModelCapabilityProfile,
  ProviderKind,
  SessionConfigOption,
  SessionConfigValue,
  SessionModelDescriptor,
  SessionModelSource,
  SessionModeDescriptor,
  StoredSessionRef,
  Workbench,
} from "./session";
import type { ContextUsage, EventEnvelope, JsonObject, RahEvent, RahEventType } from "./events";

export interface AttachClientDescriptor {
  id: string;
  kind: ClientKind;
  connectionId: string;
  cols?: number;
  rows?: number;
}

export type ApprovalPolicy = "default" | "on-request" | "never" | "auto_edit" | "yolo";

export type CanonicalPermissionDecision =
  | "approved"
  | "approved_for_session"
  | "denied"
  | "abort"
  | "accept"
  | "decline"
  | "cancel";

export type LegacyPermissionDecision = "acceptForSession";

export type PermissionDecision = CanonicalPermissionDecision | LegacyPermissionDecision;

export function normalizePermissionDecision(
  decision: string | undefined,
): CanonicalPermissionDecision | undefined {
  switch (decision) {
    case "acceptForSession":
      return "approved_for_session";
    case "approved":
    case "approved_for_session":
    case "denied":
    case "abort":
    case "accept":
    case "decline":
    case "cancel":
      return decision;
    default:
      return undefined;
  }
}

export function decisionFromPermissionActionId(
  actionId: string | undefined,
): CanonicalPermissionDecision | undefined {
  switch (actionId) {
    case "allow":
    case "approve":
    case "approved":
      return "approved";
    case "allow_for_session":
    case "approve_for_session":
    case "approved_for_session":
    case "acceptForSession":
      return "approved_for_session";
    case "deny":
    case "reject":
    case "denied":
      return "denied";
    case "abort":
      return "abort";
    case "accept":
      return "accept";
    case "decline":
      return "decline";
    case "cancel":
      return "cancel";
    default:
      return undefined;
  }
}

export function isPermissionSessionGrant(args: {
  decision?: string;
  selectedActionId?: string;
}): boolean {
  const canonical =
    normalizePermissionDecision(args.decision) ??
    decisionFromPermissionActionId(args.selectedActionId);
  return canonical === "approved_for_session";
}

export function isPermissionDenied(args: {
  behavior?: string;
  decision?: string;
  selectedActionId?: string;
}): boolean {
  const canonical =
    normalizePermissionDecision(args.decision) ??
    decisionFromPermissionActionId(args.selectedActionId);
  return args.behavior === "deny" || canonical === "denied" || canonical === "decline";
}

export function isPermissionAbort(args: {
  decision?: string;
  selectedActionId?: string;
}): boolean {
  const canonical =
    normalizePermissionDecision(args.decision) ??
    decisionFromPermissionActionId(args.selectedActionId);
  return canonical === "abort" || canonical === "cancel";
}

export interface StartSessionRequest {
  provider: ProviderKind;
  cwd: string;
  title?: string;
  model?: string;
  /**
   * Model-scoped option values keyed by the selected model's declared
   * SessionConfigOption ids. Unknown keys are invalid.
   */
  optionValues?: Record<string, SessionConfigValue>;
  /**
   * @deprecated Use optionValues. Kept as a compatibility alias for the first
   * model reasoning/thinking/variant option exposed by the provider catalog.
   */
  reasoningId?: string;
  /**
   * @deprecated Compatibility escape hatch for provider/API callers. Web clients
   * should pass modeId/model/reasoningId and let the adapter translate them.
   */
  providerConfig?: Record<string, SessionConfigValue>;
  modeId?: string;
  /**
   * @deprecated Compatibility field. Provider permission policy belongs behind
   * adapter-owned modeId translation.
   */
  approvalPolicy?: ApprovalPolicy;
  /**
   * @deprecated Compatibility field. Provider sandbox policy belongs behind
   * adapter-owned modeId translation.
   */
  sandbox?: string;
  command?: string;
  args?: string[];
  initialPrompt?: string;
  attach?: {
    client: AttachClientDescriptor;
    mode: AttachMode;
    claimControl?: boolean;
  };
}

/**
 * Resume is only valid for provider sessions that are not already running under
 * runtime management. Running sessions must be attached, not resumed.
 */
export interface ResumeSessionRequest {
  provider: ProviderKind;
  providerSessionId: string;
  cwd?: string;
  model?: string;
  /**
   * Model-scoped option values keyed by the selected model's declared
   * SessionConfigOption ids. Unknown keys are invalid.
   */
  optionValues?: Record<string, SessionConfigValue>;
  /**
   * @deprecated Use optionValues. Kept as a compatibility alias for the first
   * model reasoning/thinking/variant option exposed by the provider catalog.
   */
  reasoningId?: string | null;
  /**
   * @deprecated Compatibility escape hatch for provider/API callers. Web clients
   * should pass modeId/model/reasoningId and let the adapter translate them.
   */
  providerConfig?: Record<string, SessionConfigValue>;
  modeId?: string;
  /**
   * @deprecated Compatibility field. Provider permission policy belongs behind
   * adapter-owned modeId translation.
   */
  approvalPolicy?: ApprovalPolicy;
  /**
   * @deprecated Compatibility field. Provider sandbox policy belongs behind
   * adapter-owned modeId translation.
   */
  sandbox?: string;
  preferStoredReplay?: boolean;
  historyReplay?: "include" | "skip";
  historySourceSessionId?: string;
  attach?: {
    client: AttachClientDescriptor;
    mode: AttachMode;
    claimControl?: boolean;
  };
}

export interface AttachSessionRequest {
  client: AttachClientDescriptor;
  mode: AttachMode;
  claimControl?: boolean;
}

export interface SessionInputRequest {
  clientId: string;
  text: string;
}

export interface InterruptSessionRequest {
  clientId: string;
}

export interface DetachSessionRequest {
  clientId: string;
}

export interface CloseSessionRequest {
  clientId: string;
}

export interface RenameSessionRequest {
  title: string;
}

export interface SetSessionModeRequest {
  modeId: string;
}

export interface SetSessionModelRequest {
  modelId: string;
  /**
   * Model-scoped option values keyed by the selected model's declared
   * SessionConfigOption ids. Unknown keys are invalid.
   */
  optionValues?: Record<string, SessionConfigValue>;
  /**
   * @deprecated Use optionValues. Kept as a compatibility alias for the first
   * model reasoning/thinking/variant option exposed by the provider catalog.
   */
  reasoningId?: string | null;
}

export interface SetSessionConfigRequest {
  /**
   * Session/model option values keyed by provider catalog SessionConfigOption ids.
   */
  optionValues: Record<string, SessionConfigValue>;
}

export interface ClaimControlRequest {
  client: AttachClientDescriptor;
}

export interface ReleaseControlRequest {
  clientId: string;
}

export interface WorkspaceDirectoryRequest {
  dir: string;
}

export interface StoredSessionRemoveRequest {
  provider: ProviderKind;
  providerSessionId: string;
}

export interface WorkspaceDirectoryResponse {
  path: string;
}

export interface IndependentTerminalStartRequest {
  cwd?: string;
  cols?: number;
  rows?: number;
}

export interface IndependentTerminalSession {
  id: string;
  cwd: string;
  shell: string;
}

export interface IndependentTerminalStartResponse {
  terminal: IndependentTerminalSession;
}

export interface PermissionResponseRequest {
  behavior: "allow" | "deny";
  message?: string;
  selectedActionId?: string;
  decision?: PermissionDecision;
  answers?: Record<string, { answers: string[] }>;
  updatedInput?: JsonObject;
}

export interface SessionSummary {
  session: ManagedSession;
  attachedClients: AttachedClient[];
  controlLease: ControlLease;
  usage?: ContextUsage;
}

export interface ListSessionsResponse {
  sessions: SessionSummary[];
  storedSessions: StoredSessionRef[];
  recentSessions: StoredSessionRef[];
  workspaceDirs: string[];
  hiddenWorkspaces?: string[];
  activeWorkspaceDir?: string;
}

export interface StartSessionResponse {
  session: SessionSummary;
}

export interface ResumeSessionResponse {
  session: SessionSummary;
}

export interface AttachSessionResponse {
  session: SessionSummary;
}

export interface WorkbenchResponse {
  workbench: Workbench;
}

export interface WorkspaceNode {
  path: string;
  name: string;
  kind: "file" | "directory";
}

export interface WorkspaceSnapshotResponse {
  sessionId: string;
  cwd: string;
  nodes: WorkspaceNode[];
}

export interface GitChangedFile {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted";
  staged: boolean;
  added: number;
  removed: number;
  binary?: boolean;
  oldPath?: string;
}

export interface GitStatusResponse {
  sessionId: string;
  branch?: string;
  changedFiles: string[];
  stagedFiles?: GitChangedFile[];
  unstagedFiles?: GitChangedFile[];
  totalStaged?: number;
  totalUnstaged?: number;
}

export interface GitDiffResponse {
  sessionId: string;
  path: string;
  diff: string;
}

export interface GitHunkActionRequest {
  path: string;
  hunkIndex: number;
  staged?: boolean;
  action: "stage" | "unstage" | "revert";
}

export interface GitHunkActionResponse {
  sessionId: string;
  path: string;
  hunkIndex: number;
  staged?: boolean;
  action: "stage" | "unstage" | "revert";
  ok: true;
}

export interface GitFileActionRequest {
  path: string;
  staged?: boolean;
  action: "stage" | "unstage";
}

export interface GitFileActionResponse {
  sessionId: string;
  path: string;
  staged?: boolean;
  action: "stage" | "unstage";
  ok: true;
}

export interface SessionFileResponse {
  sessionId: string;
  path: string;
  content: string;
  binary: boolean;
  truncated?: boolean;
}

export interface SessionFileSearchItem {
  path: string;
  name: string;
  parentPath: string;
}

export interface SessionFileSearchResponse {
  sessionId: string;
  query: string;
  files: SessionFileSearchItem[];
}

export interface SessionHistoryPageResponse {
  sessionId: string;
  events: RahEvent[];
  nextCursor?: string;
  nextBeforeTs?: string;
}

export interface EventSubscriptionRequest {
  sessionIds?: string[];
  eventTypes?: RahEventType[];
  replayFromSeq?: number;
}

export interface ReplayGapNotice {
  requestedFromSeq: number;
  oldestAvailableSeq: number | null;
  newestAvailableSeq: number | null;
}

export interface EventBatch {
  events: RahEvent[];
  replayGap?: ReplayGapNotice;
  initial?: boolean;
}

export interface ProviderDiagnostic {
  provider: ProviderKind;
  status: "ready" | "missing_binary" | "launch_error";
  launchCommand: string;
  installedVersion?: string;
  latestVersion?: string;
  latestVersionSource?: "npm" | "github" | "cdn";
  latestVersionError?: string;
  versionStatus?: "up_to_date" | "update_available" | "unknown";
  detail?: string;
  auth: "provider_managed";
}

export interface ListProvidersResponse {
  providers: ProviderDiagnostic[];
}

export interface ProviderModelCatalog {
  provider: ProviderKind;
  currentModelId?: string;
  currentReasoningId?: string | null;
  models: SessionModelDescriptor[];
  fetchedAt: string;
  source: SessionModelSource;
  sourceDetail?: CapabilitySource;
  freshness?: CapabilityFreshness;
  revision?: string;
  modelsExact?: boolean;
  optionsExact?: boolean;
  /**
   * Adapter-owned default permission/behavior mode. Clients must submit this
   * opaque id back as modeId, not decompose it into provider-native flags.
   */
  defaultModeId?: string;
  /**
   * Adapter-owned permission/behavior modes. role is the stable cross-provider
   * UI semantic; id remains provider/adapter specific.
   */
  modes?: SessionModeDescriptor[];
  configOptions?: SessionConfigOption[];
  modelProfiles?: ModelCapabilityProfile[];
}

export interface ListProviderModelsResponse {
  catalog: ProviderModelCatalog;
}

export interface DebugScenarioDescriptor {
  id: string;
  label: string;
  description: string;
  provider: ProviderKind;
  cwd: string;
  rootDir: string;
  title: string;
  preview?: string;
}

export interface ListDebugScenariosResponse {
  scenarios: DebugScenarioDescriptor[];
}

export interface StartDebugScenarioRequest {
  scenarioId: string;
  attach?: AttachSessionRequest;
}

export interface PtyAttachRequest {
  sessionId: string;
  replay?: boolean;
  cols?: number;
  rows?: number;
}

export type PtyServerMessage =
  | {
      type: "pty.replay";
      sessionId: string;
      chunks: string[];
    }
  | {
      type: "pty.output";
      sessionId: string;
      data: string;
    }
  | {
      type: "pty.exited";
      sessionId: string;
      exitCode?: number;
      signal?: string;
    };

export type PtyClientMessage =
  | {
      type: "pty.input";
      sessionId: string;
      clientId: string;
      data: string;
    }
  | {
      type: "pty.resize";
      sessionId: string;
      clientId: string;
      cols: number;
      rows: number;
    };

/**
 * Debug mode feeds synthetic canonical events into the same protocol that real
 * adapters will use later. This lets the frontend be built before any
 * provider-specific integration exists.
 */
export interface DebugReplayScript {
  session: ManagedSession;
  events: EventEnvelope[];
}
