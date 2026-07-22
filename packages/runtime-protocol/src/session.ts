import type { ConversationPhase, ConversationStatus } from "./conversation-state";

export type ProviderKind =
  | "codex"
  | "claude"
  | "opencode"
  | "custom";

export type SessionInputAttachmentKind = "image" | "file";

/**
 * Opaque reference to a file uploaded into RAH's managed attachment store.
 * Clients never submit a host path; the daemon resolves `id` to the trusted
 * path it created when accepting the upload.
 */
export interface SessionInputAttachment {
  id: string;
  kind: SessionInputAttachmentKind;
  name: string;
  mediaType: string;
  size: number;
}

export type SessionLaunchSource = "web";
export type SessionLiveBackend =
  | "structured"
  | "native_local_server"
  | "native_tui"
  | "tui_mux";
export type ManagedSessionOrigin =
  | {
      kind: "council";
      councilId: string;
      councilTitle?: string;
      agentId: string;
      agentLabel?: string;
    };
export type ProviderRuntimeKind =
  | "native_local_server"
  | "tui_mux_fallback"
  | "stored_history"
  | "stream_json_fifo"
  | "native_cloud_remote"
  | "internal_experimental"
  | "provider_control";
export type ProtocolStability =
  | "official_stable"
  | "project_native"
  | "tui_stdio"
  | "reverse_engineered_internal";
export type RuntimeLiveSource =
  | "provider_server"
  | "provider_history"
  | "tui_mux"
  | "rah_control";
export type RuntimeTuiRole =
  | "client_view"
  | "session_owner"
  | "fallback_surface"
  | "none";
export type SessionRuntimeCapabilityStatus =
  | "available"
  | "unverified"
  | "unsupported"
  | "experimental";
export type NativeTuiPromptState = "prompt_clean" | "prompt_dirty" | "agent_busy";

export type SessionRuntimeState =
  | "starting"
  | "running"
  | "idle"
  | "waiting_input"
  | "waiting_permission"
  | "stopped"
  | "failed";

export type ClientKind = "web" | "ios" | "ipad" | "api";

export type AttachMode = "observe" | "interactive";

export type SessionRenameMode = "none" | "local" | "native";
export type SessionModeSource = "native" | "local" | "external_locked";
export type SessionModeRole =
  | "ask"
  | "auto_edit"
  | "full_auto"
  | "plan"
  | "custom";
export type SessionModeApplyTiming =
  | "immediate"
  | "next_turn"
  | "idle_only"
  | "restart_required"
  | "startup_only";
export type SessionModelSource = "native" | "static" | "fallback";
export type CapabilitySource =
  | "runtime_session"
  | "native_online"
  | "native_local"
  | "cached_runtime"
  | "static_builtin";
export type CapabilityFreshness = "authoritative" | "provisional" | "stale";
export type SessionReasoningOptionKind =
  | "reasoning_effort"
  | "thinking"
  | "model_variant";
export type SessionConfigOptionKind = "select" | "boolean" | "number" | "string";
export type SessionConfigOptionScope = "provider" | "session" | "model";
export type SessionConfigOptionApplyTiming =
  | "immediate"
  | "next_turn"
  | "restart_required";
export type SessionConfigValue = string | number | boolean | null;

export interface SessionModeDescriptor {
  id: string;
  role?: SessionModeRole;
  label: string;
  description?: string;
  applyTiming?: SessionModeApplyTiming;
  hotSwitch: boolean;
}

export interface SessionModeState {
  currentModeId: string | null;
  availableModes: SessionModeDescriptor[];
  mutable: boolean;
  source: SessionModeSource;
}

export interface SessionReasoningOption {
  id: string;
  label: string;
  description?: string;
  kind: SessionReasoningOptionKind;
}

export interface SessionConfigOptionChoice {
  id: string;
  label: string;
  description?: string;
}

export interface SessionConfigOptionConstraints {
  min?: number;
  max?: number;
  step?: number;
}

export interface SessionConfigOptionAvailability {
  modelIds?: string[];
  modeIds?: string[];
  capabilityFlags?: string[];
}

export interface SessionConfigOption {
  id: string;
  label: string;
  description?: string;
  kind: SessionConfigOptionKind;
  scope: SessionConfigOptionScope;
  source: CapabilitySource;
  mutable: boolean;
  applyTiming: SessionConfigOptionApplyTiming;
  currentValue?: SessionConfigValue;
  defaultValue?: SessionConfigValue;
  options?: SessionConfigOptionChoice[];
  constraints?: SessionConfigOptionConstraints;
  availability?: SessionConfigOptionAvailability;
  backendKey?: string;
}

export interface ModelCapabilityTraits {
  supportsThinking?: boolean;
  supportsAdaptiveThinking?: boolean;
  supportsEffort?: boolean;
  supportsThinkingBudget?: boolean;
  supportsThinkingLevel?: boolean;
  supportsReasoningVariant?: boolean;
}

export interface ModelCapabilityProfile {
  modelId: string;
  source: CapabilitySource;
  freshness: CapabilityFreshness;
  contextWindow?: number;
  traits?: ModelCapabilityTraits;
  configOptions: SessionConfigOption[];
}

export interface SessionModelDescriptor {
  id: string;
  description?: string;
  contextWindow?: number;
  hidden?: boolean;
  isDefault?: boolean;
  reasoningOptions?: SessionReasoningOption[];
  defaultReasoningId?: string | null;
}

export interface SessionModelState {
  currentModelId: string | null;
  currentReasoningId?: string | null;
  availableModels: SessionModelDescriptor[];
  mutable: boolean;
  source: SessionModelSource;
}

export interface SessionResolvedConfig {
  values: Record<string, SessionConfigValue>;
  source: CapabilitySource | "fallback";
  revision?: string;
}

export interface SessionActionCapabilities {
  info: boolean;
  stop: boolean;
  archive?: boolean;
  restore?: boolean;
  delete: boolean;
  rename: SessionRenameMode;
}

export type SessionBranchKind = "fork" | "side";
export type SessionWorkspaceMode = "shared" | "worktree";
export type SessionPersistence = "persistent" | "ephemeral";
export type SessionSideLifecycleState =
  | "ready"
  | "active"
  | "completed"
  | "expired"
  | "cleanup_failed"
  | "discarded";
export type SessionCloseDisposition = "stopped" | "discarded" | "parent_closed";

/**
 * Provider-native branching features. Missing means the provider has not
 * declared native branching support; clients must not emulate it by copying a
 * rendered transcript.
 */
export interface SessionBranchCapabilities {
  sameWorkspace: boolean;
  worktree: boolean;
  side: boolean;
}

/**
 * Stable parent/child identity for provider-native forks. The relationship is
 * owned by the runtime session, while Canvas panes are only views over it.
 */
export interface SessionRelationship {
  parentSessionId: string;
  parentProviderSessionId?: string;
  forkPointTurnId?: string;
  kind: SessionBranchKind;
  workspaceMode: SessionWorkspaceMode;
  persistence: SessionPersistence;
  /**
   * Explicit lifecycle for provider-native ephemeral Side tasks. Forks do not
   * use this field. `discarded` is normally observed only in the terminal
   * lifecycle event immediately before the managed session is removed.
   */
  sideState?: SessionSideLifecycleState;
  sideStateDetail?: string;
}

export interface SessionRuntimeDescriptor {
  kind: ProviderRuntimeKind;
  protocolStability: ProtocolStability;
  liveSource: RuntimeLiveSource;
  tuiRole: RuntimeTuiRole;
  structuredLiveEvents: boolean;
  tuiContinuity: boolean;
  features?: {
    structuredLiveEvents: SessionRuntimeCapabilityStatus;
    structuredControl: SessionRuntimeCapabilityStatus;
    historyBackfill: SessionRuntimeCapabilityStatus;
    tuiClientContinuity: SessionRuntimeCapabilityStatus;
    crossClientSync: SessionRuntimeCapabilityStatus;
    prelaunchConfig: SessionRuntimeCapabilityStatus;
    runtimeConfig: SessionRuntimeCapabilityStatus;
    interrupt: SessionRuntimeCapabilityStatus;
    stopLifecycle: SessionRuntimeCapabilityStatus;
  };
}

export type SessionRuntimeAttachState =
  | "unavailable"
  | "unverified"
  | "ready"
  | "failed";

export interface SessionRuntimeDiagnostics {
  serverEndpoint?: string;
  serverPid?: number;
  attachCommand?: string;
  attachState?: SessionRuntimeAttachState;
  lastEventCursor?: string;
  lastError?: string;
}

/**
 * Provider-specific feature flags surfaced to clients so the UI can degrade
 * cleanly instead of assuming every adapter supports the same experience.
 */
export interface SessionCapabilities {
  liveAttach: boolean;
  structuredTimeline: boolean;
  nativeTui: boolean;
  rawPtyInput: boolean;
  chatMirror: boolean;
  structuredControl: boolean;
  livePermissions: boolean;
  contextUsage: boolean;
  resumeByProvider: boolean;
  listProviderSessions: boolean;
  actions: SessionActionCapabilities;
  steerInput: boolean;
  queuedInput: boolean;
  modelSwitch: boolean;
  planMode: boolean;
  subagents: boolean;
  branching?: SessionBranchCapabilities;
}

/**
 * A provider/runtime-owned input waiting for the current turn to finish.
 * The client message id is the stable mutation key; text is display data only.
 */
export type SessionQueuedInputState = "queued" | "submitting";
/** @deprecated Follow-up submission now always queues; retained for wire compatibility. */
export type SessionInputQueuePolicy = "queue" | "steer";

export interface SessionQueuedInput {
  clientMessageId: string;
  clientTurnId?: string;
  text: string;
  attachments?: SessionInputAttachment[];
  queuedAt: string;
  position: number;
  state?: SessionQueuedInputState;
}

/**
 * A runtime-owned running session. This is the only session kind that can provide
 * continuity guarantees across terminal and remote clients.
 */
export interface ManagedSession {
  id: string;
  provider: ProviderKind;
  providerSessionId?: string;
  origin?: ManagedSessionOrigin;
  launchSource: SessionLaunchSource;
  liveBackend?: SessionLiveBackend;
  status: ConversationStatus;
  phase: ConversationPhase;
  cwd: string;
  rootDir: string;
  /**
   * Adapter/runtime execution state. UI conversation state must use status + phase;
   * runtimeState is retained only for coordination and diagnostics.
   */
  runtimeState: SessionRuntimeState;
  runtime?: SessionRuntimeDescriptor;
  runtimeDiagnostics?: SessionRuntimeDiagnostics;
  ptyId: string;
  nativeTui?: {
    terminalId: string;
    viewAvailable: boolean;
    promptState?: NativeTuiPromptState;
    queuedInputCount?: number;
  };
  inputQueue?: SessionQueuedInput[];
  /** @deprecated Follow-up input always queues; old summaries may still carry this field. */
  inputQueuePolicy?: SessionInputQueuePolicy;
  mux?: {
    backend: "tmux";
    sessionName: string;
    paneId: string;
  };
  pid?: number;
  title?: string;
  preview?: string;
  relationship?: SessionRelationship;
  capabilities: SessionCapabilities;
  mode?: SessionModeState;
  model?: SessionModelState;
  config?: SessionResolvedConfig;
  modelProfile?: ModelCapabilityProfile;
  createdAt: string;
  updatedAt: string;
}

export interface StoredSessionHistoryMeta {
  bytes?: number;
  lines?: number;
  messages?: number;
}

export interface StoredSessionProviderState {
  /**
   * Provider-native archive/trash state. This is not a RAH running/stopped
   * lifecycle flag; it only describes the provider-owned stored history entry.
   */
  archived?: boolean;
  archivedAt?: string;
}

/**
 * RAH-owned placement in the cross-provider session library. This is
 * intentionally independent from both ManagedSession.runtimeState and a
 * provider's private archive representation.
 */
export type StoredSessionLibraryPlacement = "workspace" | "archive";

export type StoredSessionArchiveBackend =
  | "provider_native"
  | "rah_overlay"
  | "rah_snapshot";

export type StoredSessionRemovalDisposition = "trash" | "permanent";

export interface StoredSessionLibraryState {
  placement: StoredSessionLibraryPlacement;
  archivedAt?: string;
  backend?: StoredSessionArchiveBackend;
}

export interface StoredSessionIdentity {
  provider: ProviderKind;
  providerSessionId: string;
}

/**
 * A provider-owned persisted session reference that is known to the system but
 * is not currently running under runtime control.
 */
export interface StoredSessionRef extends StoredSessionIdentity {
  cwd?: string;
  rootDir?: string;
  title?: string;
  preview?: string;
  createdAt?: string;
  updatedAt?: string;
  lastUsedAt?: string;
  historyMeta?: StoredSessionHistoryMeta;
  providerState?: StoredSessionProviderState;
  libraryState?: StoredSessionLibraryState;
  /** Provider adapter's actual destructive-remove behavior. */
  removalDisposition?: StoredSessionRemovalDisposition;
  source?: "provider_history" | "previous_running";
}

export interface AttachedClient {
  id: string;
  kind: ClientKind;
  sessionId: string;
  connectionId: string;
  attachMode: AttachMode;
  focus: boolean;
  lastSeenAt: string;
}

/**
 * Only one client may hold input control for a session at a time.
 */
export interface ControlLease {
  sessionId: string;
  holderClientId?: string;
  holderKind?: ClientKind;
  grantedAt?: string;
}

export type PaneKind = "session" | "files" | "diff" | "inspector" | "timeline";

export interface WorkbenchPane {
  id: string;
  kind: PaneKind;
  sessionId?: string;
}

export interface WorkbenchLayout {
  panes: WorkbenchPane[];
  activePaneId?: string;
}

/**
 * A workbench is the user-facing board that groups sessions and view state.
 * Layout state is device-facing; session membership is shared.
 */
export interface Workbench {
  id: string;
  sessionIds: string[];
  activeSessionId?: string;
  layout: WorkbenchLayout;
  restoredFrom?: string;
}
