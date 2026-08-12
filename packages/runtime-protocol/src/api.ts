import type {
  AttachMode,
  AttachedClient,
  CapabilityFreshness,
  CapabilitySource,
  ClientKind,
  ControlLease,
  ManagedSession,
  ManagedSessionOrigin,
  ModelCapabilityProfile,
  ProviderKind,
  SessionRuntimeDescriptor,
  SessionLiveBackend,
  SessionConfigOption,
  SessionConfigValue,
  SessionInputAttachment,
  SessionInputAnnotation,
  SessionInputQueuePolicy,
  SessionBranchKind,
  SessionWorkspaceMode,
  SessionModelDescriptor,
  SessionModelSource,
  SessionModeDescriptor,
  StoredSessionIdentity,
  StoredSessionRef,
  Workbench,
} from "./session";
import type {
  AddCouncilAgentRequest,
  AddCouncilAgentResponse,
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
  ListCouncilsResponse,
  RenameCouncilRequest,
  RenameCouncilResponse,
} from "./council";
import type {
  ContextUsage,
  EventEnvelope,
  JsonObject,
  RahEvent,
  RahEventType,
  WorkbenchPinnedItemRef,
} from "./events";
import type {
  ConversationProjectionDelta,
  ConversationTurnFileChangesProjection,
} from "./conversation";

export interface RuntimeIdentityResponse {
  name: "rah";
  runtimeId: string;
  pid: number;
  port: number;
  startedAt: string;
  rootDir: string;
  version?: string;
  sourceRevision?: string;
  sourceDirty?: boolean;
  /**
   * Exact Web asset generation that was current when this daemon started.
   * The browser compares this opaque value with its embedded generation to
   * detect a newly published Web client served by an older daemon process.
   */
  webBuildId?: string;
}

export interface TrustedDeviceDescriptor {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string;
}

export interface DeviceAuthStatusResponse {
  authenticated: boolean;
  hasTrustedDevices: boolean;
  device?: TrustedDeviceDescriptor;
}

export interface PairDeviceRequest {
  code: string;
  name: string;
}

export interface PairDeviceResponse {
  authenticated: true;
  device: TrustedDeviceDescriptor;
}

export interface PairingCodeResponse {
  id: string;
  code: string;
  expiresAt: string;
}

export interface PairingCodeStatusResponse {
  active: boolean;
}

export interface ListTrustedDevicesResponse {
  devices: TrustedDeviceDescriptor[];
  currentDeviceId?: string;
}

export interface RevokeTrustedDeviceResponse {
  ok: true;
  revokedCurrentDevice: boolean;
}

export interface AttachClientDescriptor {
  id: string;
  kind: ClientKind;
  connectionId: string;
  cols?: number;
  rows?: number;
}

export type CanonicalPermissionDecision =
  | "approved"
  | "approved_for_session"
  | "denied"
  | "abort";

export type PermissionDecision = CanonicalPermissionDecision;

export function normalizePermissionDecision(
  decision: string | undefined,
): CanonicalPermissionDecision | undefined {
  switch (decision) {
    case "accept":
    case "approved":
      return "approved";
    case "acceptForSession":
    case "approved_for_session":
      return "approved_for_session";
    case "decline":
    case "denied":
      return "denied";
    case "cancel":
    case "abort":
      return "abort";
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
      return "approved";
    case "decline":
      return "denied";
    case "cancel":
      return "abort";
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
  return args.behavior === "deny" || canonical === "denied";
}

export function isPermissionAbort(args: {
  decision?: string;
  selectedActionId?: string;
}): boolean {
  const canonical =
    normalizePermissionDecision(args.decision) ??
    decisionFromPermissionActionId(args.selectedActionId);
  return canonical === "abort";
}

export interface StartSessionRequest {
  provider: ProviderKind;
  cwd: string;
  origin?: ManagedSessionOrigin;
  liveBackend?: SessionLiveBackend;
  title?: string;
  model?: string;
  /**
   * Model-scoped option values keyed by the selected model's declared
   * SessionConfigOption ids. Unknown keys are invalid.
   */
  optionValues?: Record<string, SessionConfigValue>;
  modeId?: string;
  command?: string;
  args?: string[];
  /**
   * Text submitted as the first provider turn as part of Session startup. This
   * avoids the create-then-input request gap where a browser navigation or a
   * late provider rejection could otherwise lose the user's first question.
   */
  initialPrompt?: string;
  /** Stable optimistic identity for `initialPrompt`. */
  initialClientMessageId?: string;
  /** Stable optimistic turn identity for `initialPrompt`. */
  initialClientTurnId?: string;
  /**
   * User input delivered as part of the same startup transaction. Unlike
   * `initialPrompt`, this form also carries attachments and annotations. A
   * successful response means the live provider accepted the input; while that
   * handoff is pending, RAH retains the sole owned copy in the Session queue.
   */
  initialInput?: SessionInputRequest;
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
  origin?: ManagedSessionOrigin;
  liveBackend?: SessionLiveBackend;
  cwd?: string;
  model?: string;
  /**
   * Model-scoped option values keyed by the selected model's declared
   * SessionConfigOption ids. Unknown keys are invalid.
   */
  optionValues?: Record<string, SessionConfigValue>;
  modeId?: string;
  preferStoredReplay?: boolean;
  historyReplay?: "include" | "skip";
  historySourceSessionId?: string;
  /**
   * User input delivered as part of the same live-resume transaction. A
   * successful response guarantees that the live provider accepted it. Until
   * that acknowledgement, the daemon owns the input in the resumed Session's
   * canonical queue; live-resume failures must not degrade to a read-only
   * replay and report success.
   */
  initialInput?: SessionInputRequest;
  attach?: {
    client: AttachClientDescriptor;
    mode: AttachMode;
    claimControl?: boolean;
  };
}

export interface ForkSessionRequest {
  /**
   * Stable client-generated id for this branch operation. Reusing the id must
   * return the original result instead of creating another provider thread.
   */
  operationId: string;
  kind: SessionBranchKind;
  workspaceMode: SessionWorkspaceMode;
  /** Fork through this completed provider turn, inclusive. */
  lastTurnId?: string;
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

export interface UploadAttachmentResponse {
  attachment: SessionInputAttachment;
}

export interface SessionInputRequest {
  clientId: string;
  text: string;
  attachments?: SessionInputAttachment[];
  annotations?: SessionInputAnnotation[];
  /**
   * Stable client-generated id for this submitted user message. The daemon and
   * provider mirrors should echo it when they can so optimistic UI rows can be
   * replaced by authoritative transcript rows without text-based guessing.
   */
  clientMessageId?: string;
  /**
   * Stable client-generated id for the user-visible turn started by this input.
   * Provider-native turn ids may differ; this id exists only to correlate the
   * web optimistic row, queued input state, and later echo/notice anchoring.
   */
  clientTurnId?: string;
}

export interface UpdateQueuedInputRequest {
  clientId: string;
  text: string;
}

export interface DeleteQueuedInputRequest {
  clientId: string;
}

export interface ReorderQueuedInputRequest {
  clientId: string;
  position: number;
}

export interface SteerQueuedInputRequest {
  clientId: string;
}

/** @deprecated Follow-up input always queues; retained for older clients. */
export interface SetInputQueuePolicyRequest {
  clientId: string;
  policy: SessionInputQueuePolicy;
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

export interface UpdateWorkbenchPinnedItemRequest extends WorkbenchPinnedItemRef {
  pinned: boolean;
}

export interface StoredSessionRemoveRequest {
  provider: ProviderKind;
  providerSessionId: string;
}

export interface StoredSessionArchiveRequest extends StoredSessionRemoveRequest {
  /**
   * When present, daemon closes this matching managed runtime before archiving
   * its provider history. clientId is required for the close authorization.
   */
  runtimeSessionId?: string;
  clientId?: string;
}

export type StoredSessionRestoreRequest = StoredSessionRemoveRequest;

export interface WorkspaceDirectoryResponse {
  path: string;
}

export interface IndependentTerminalOwner {
  kind: "workspace" | "session";
  id: string;
}

export interface IndependentTerminalStartRequest {
  cwd?: string;
  cols?: number;
  rows?: number;
  owner?: IndependentTerminalOwner;
}

export interface IndependentTerminalSession {
  id: string;
  cwd: string;
  shell: string;
  owner?: IndependentTerminalOwner;
}

export interface IndependentTerminalStartResponse {
  terminal: IndependentTerminalSession;
}

export interface IndependentTerminalListResponse {
  terminals: IndependentTerminalSession[];
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
  eventSeq?: number;
  storedSessionsRevision?: number;
  workspaceDirs: string[];
  hiddenWorkspaces?: string[];
  activeWorkspaceDir?: string;
  pinnedSidebarItems?: WorkbenchPinnedItemRef[];
}

export interface StoredSessionsDeltaResponse {
  fromRevision: number;
  revision: number;
  upsert: StoredSessionRef[];
  remove: StoredSessionIdentity[];
  resetRequired?: boolean;
}

export interface StartSessionResponse {
  session: SessionSummary;
}

export interface ResumeSessionResponse {
  session: SessionSummary;
}

export interface ForkSessionResponse {
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

/** A file in the final current-worktree snapshot that differs from the resolved diff base. */
export type GitBranchChangedFile = Omit<GitChangedFile, "staged">;

export type GitComparisonMode =
  | "uncommitted"
  | "merge_base"
  | "direct";

export interface GitStatusResponse {
  sessionId: string;
  /** The branch currently checked out in the inspected worktree. */
  branch?: string;
  /** The branch/ref selected in the Against control. Defaults to the checked-out branch. */
  baseBranch?: string;
  /**
   * How `baseBranch` was resolved. The current branch uses its HEAD, while a
   * different branch normally uses the merge-base shared with HEAD.
   */
  comparisonMode?: GitComparisonMode;
  /** The concrete commit used as the left side of the diff. */
  comparisonBase?: string;
  /** Locally available branches/refs that can be used as diff baselines. */
  branchOptions?: string[];
  /** Current worktree changes relative to `comparisonBase`, including untracked files. */
  branchFiles?: GitBranchChangedFile[];
  changedFiles: string[];
  stagedFiles?: GitChangedFile[];
  unstagedFiles?: GitChangedFile[];
  totalBranch?: number;
  totalStaged?: number;
  totalUnstaged?: number;
}

export interface GitDiffResponse {
  sessionId: string;
  path: string;
  diff: string;
}

export interface TurnFileChangesResponse {
  sessionId: string;
  turnId: string;
  fileChanges: ConversationTurnFileChangesProjection;
  capturedAt: string;
  truncated: boolean;
}

export interface TurnFileDiffResponse {
  sessionId: string;
  turnId: string;
  path: string;
  diff: string;
  truncated: boolean;
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
  mimeType?: string;
  sizeBytes?: number;
  contentBase64?: string;
  truncated?: boolean;
  notebookPreview?: NotebookPreviewData;
}

export interface AttachmentPreviewResponse {
  attachment: SessionInputAttachment;
  file: SessionFileResponse;
}

export interface NotebookPreviewCell {
  type: string;
  source: string;
  executionCount?: number | null;
  outputSummary?: string;
}

export interface NotebookPreviewData {
  cells: NotebookPreviewCell[];
  truncated: boolean;
  language?: string;
  omittedOutputs?: boolean;
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

export type ConversationEvidenceDetailMode = "full" | "summary" | "chat";

export interface ConversationEvidencePage {
  sessionId: string;
  events: RahEvent[];
  /** Provider source revision represented by this evidence page. */
  sourceRevision?: string;
  /**
   * Provider-turn keyed detail availability carried alongside lightweight
   * evidence. This avoids hydrating a turn merely to discover that its Worked
   * section contains no renderable process rows.
   */
  turnProcessDetailsAvailable?: Record<string, boolean>;
  nextCursor?: string;
  nextBeforeTs?: string;
  detailMode?: ConversationEvidenceDetailMode;
  approximateBytes?: number;
}

export type ConversationTurnDirectoryStatus =
  | "in_progress"
  | "completed"
  | "interrupted"
  | "failed";

export interface ConversationTurnDirectoryItem {
  id: string;
  ordinal: number;
  userPreview: string;
  assistantPreview?: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  status: ConversationTurnDirectoryStatus;
}

export interface ConversationTurnDirectoryResponse {
  sessionId: string;
  revision: string;
  items: ConversationTurnDirectoryItem[];
  complete: boolean;
  sourceBytes?: number;
  generatedAt: string;
}

export type ConversationItemDetailKind = "tool_call" | "observation";

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
  conversationDeltas?: ConversationProjectionDelta[];
  replayGap?: ReplayGapNotice;
  /** This frame belongs to a retained-event replay rather than the live tail. */
  replay?: boolean;
  /** Initial replay frames must not be treated as unread live activity. */
  initial?: boolean;
  /** False on intermediate replay chunks and true on the final acknowledgement. */
  replayComplete?: boolean;
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
  providerHealth?: ProviderRuntimeHealthDiagnostic;
}

export interface ProviderRuntimeHealthDiagnostic {
  source: "codex_doctor";
  status: "ok" | "warning" | "error" | "unknown";
  generatedAt?: string;
  auth?: {
    status: "configured" | "missing" | "unknown";
    mode?: string;
    storedApiKey?: boolean;
    storedChatGptTokens?: boolean;
    summary?: string;
  };
  appServer?: {
    status?: string;
    mode?: string;
    summary?: string;
  };
  network?: {
    status?: "ok" | "warning" | "error" | "unknown";
    summary?: string;
  };
  error?: string;
}

export interface ListProvidersResponse {
  providers: ProviderDiagnostic[];
}

export type NativeTuiDiagnosticKind =
  | "binding_missing"
  | "binding_failed"
  | "mirror_source_missing"
  | "mirror_failed"
  | "process_exited";
export type NativeTuiDiagnosticStatus = "active" | "resolved";
export type NativeTuiDiagnosticSeverity = "info" | "warning" | "error";

export interface NativeTuiDiagnostic {
  id: string;
  sessionId: string;
  provider: ProviderKind;
  providerSessionId?: string;
  kind: NativeTuiDiagnosticKind;
  severity: NativeTuiDiagnosticSeverity;
  status: NativeTuiDiagnosticStatus;
  message: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  elapsedMs?: number;
  details?: Record<string, string | number | boolean | null>;
}

export interface ListNativeTuiDiagnosticsResponse {
  diagnostics: NativeTuiDiagnostic[];
}

export interface ProviderModelCatalog {
  provider: ProviderKind;
  runtime?: SessionRuntimeDescriptor;
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

export interface ManualProviderModel {
  provider: ProviderKind;
  id: string;
  optionIds?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ListManualProviderModelsResponse {
  models: ManualProviderModel[];
}

export interface AddManualProviderModelRequest {
  id: string;
  optionIds?: string[];
  /**
   * Optional workspace used only for duplicate checks against provider-native
   * catalogs. Manual model supplements remain provider-wide.
   */
  cwd?: string;
}

export interface AddManualProviderModelResponse {
  model: ManualProviderModel;
  catalog: ProviderModelCatalog;
}

export interface DeleteManualProviderModelResponse {
  ok: true;
  catalog: ProviderModelCatalog;
}

export interface DeleteManualProviderModelOptionResponse {
  model: ManualProviderModel;
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

export interface PtySessionStats {
  sessionId: string;
  provider?: ProviderKind;
  liveBackend?: SessionLiveBackend;
  runtimeState?: ManagedSession["runtimeState"];
  nativeTuiPromptState?: NonNullable<ManagedSession["nativeTui"]>["promptState"];
  mux?: ManagedSession["mux"];
  replayChunks: number;
  replayBytes: number;
  maxReplayChunks: number;
  maxReplayBytes: number;
  nextSeq: number;
  firstReplaySeq?: number;
  droppedBeforeSeq?: number;
  subscriberCount: number;
  status: "open" | "exited";
}

export interface ListPtyStatsResponse {
  sessions: PtySessionStats[];
}

export interface TuiMuxPaneDiagnostic {
  paneId: string;
  title: string;
  exited: boolean;
  held: boolean;
  exitStatus: number | null;
  rows: number;
  columns: number;
  command?: string;
  cwd?: string;
  tabId?: number;
  tabName?: string;
}

export interface TuiMuxSessionDiagnostic {
  sessionName: string;
  backend?: "tmux";
  managedSessionId?: string;
  provider?: ProviderKind;
  runtimeState?: ManagedSession["runtimeState"];
  paneId?: string;
  panes: TuiMuxPaneDiagnostic[];
  error?: string;
}

export interface ListTuiMuxDiagnosticsResponse {
  sessions: TuiMuxSessionDiagnostic[];
}

export interface CloseTuiMuxSessionResponse {
  ok: true;
}

export type PtyServerMessage =
  | {
      type: "pty.replay";
      sessionId: string;
      chunks: string[];
      baseSeq?: number;
      nextSeq?: number;
      droppedBeforeSeq?: number;
      status?: "open" | "exited";
      exitCode?: number;
      signal?: string;
    }
  | {
      type: "pty.output";
      sessionId: string;
      data: string;
      seq?: number;
      replace?: boolean;
    }
  | {
      type: "pty.exited";
      sessionId: string;
      seq?: number;
      exitCode?: number;
      signal?: string;
    }
  | {
      type: "pty.server.pong";
      sessionId: string;
      nonce: string;
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
    }
  | {
      type: "pty.surface.attach";
      sessionId: string;
      clientId: string;
      surfaceId?: string;
      clientKind: ClientKind;
      cols: number;
      rows: number;
    }
  | {
      type: "pty.surface.detach";
      sessionId: string;
      clientId: string;
      surfaceId?: string;
    }
  | {
      type: "pty.client.ping";
      sessionId: string;
      clientId: string;
      nonce: string;
    };

export interface NativeTuiSurfaceState {
  sessionId: string;
  surfaceId?: string;
  clientId: string;
  clientKind: ClientKind;
  cols?: number;
  rows?: number;
  attachedAt: string;
}

export interface NativeTuiSurfaceClaimRequest {
  clientId: string;
  surfaceId?: string;
  clientKind: ClientKind;
  cols?: number;
  rows?: number;
}

export interface NativeTuiSurfaceReleaseRequest {
  clientId: string;
  surfaceId?: string;
}

export interface NativeTuiClientCloseRequest {
  clientId: string;
  surfaceId?: string;
}

export interface NativeTuiSurfaceResponse {
  surface?: NativeTuiSurfaceState;
}

export interface CouncilApi {
  listCouncils(): Promise<ListCouncilsResponse>;
  createCouncil(request: CreateCouncilRequest): Promise<CreateCouncilResponse>;
  readCouncilMessages(councilId: string, options?: { beforeMessageId?: number; limit?: number }): Promise<CouncilMessagesPageResponse>;
  renameCouncil(councilId: string, request: RenameCouncilRequest): Promise<RenameCouncilResponse>;
  addAgent(councilId: string, request: AddCouncilAgentRequest): Promise<AddCouncilAgentResponse>;
  postMessage(councilId: string, request: CouncilPostMessageRequest): Promise<CouncilPostMessageResponse>;
  stopCouncil(councilId: string): Promise<{ ok: true }>;
  deleteCouncil(councilId: string): Promise<{ ok: true }>;
  getAgentTui(councilId: string, agentId: string): Promise<CouncilAgentTuiResponse>;
  reinjectAgent(councilId: string, agentId: string): Promise<CouncilReinjectAgentsResponse>;
  removeAgent(councilId: string, agentId: string): Promise<CouncilRemoveAgentResponse>;
  stopAgent(councilId: string, agentId: string): Promise<CouncilStopAgentResponse>;
  callMcpTool(request: CouncilMcpRequest): Promise<CouncilMcpResponse>;
}

/**
 * Debug mode feeds synthetic canonical events into the same protocol that real
 * adapters will use later. This lets the frontend be built before any
 * provider-specific integration exists.
 */
export interface DebugReplayScript {
  session: ManagedSession;
  events: EventEnvelope[];
}
