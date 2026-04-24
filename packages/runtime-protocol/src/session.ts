export type ProviderKind =
  | "codex"
  | "claude"
  | "kimi"
  | "gemini"
  | "opencode"
  | "custom";

export type SessionLaunchSource = "web" | "terminal";

export type SessionRuntimeState =
  | "starting"
  | "running"
  | "idle"
  | "waiting_input"
  | "waiting_permission"
  | "stopped"
  | "failed";

export type ClientKind = "terminal" | "web" | "ios" | "ipad" | "api";

export type AttachMode = "observe" | "interactive";

/**
 * Provider-specific feature flags surfaced to clients so the UI can degrade
 * cleanly instead of assuming every adapter supports the same experience.
 */
export interface SessionCapabilities {
  liveAttach: boolean;
  structuredTimeline: boolean;
  livePermissions: boolean;
  contextUsage: boolean;
  resumeByProvider: boolean;
  listProviderSessions: boolean;
  renameSession: boolean;
  steerInput: boolean;
  queuedInput: boolean;
  modelSwitch: boolean;
  planMode: boolean;
  subagents: boolean;
}

/**
 * A runtime-owned live session. This is the only session kind that can provide
 * continuity guarantees across terminal and remote clients.
 */
export interface ManagedSession {
  id: string;
  provider: ProviderKind;
  providerSessionId?: string;
  launchSource: SessionLaunchSource;
  cwd: string;
  rootDir: string;
  runtimeState: SessionRuntimeState;
  ptyId: string;
  pid?: number;
  title?: string;
  preview?: string;
  capabilities: SessionCapabilities;
  createdAt: string;
  updatedAt: string;
}

/**
 * A provider-owned persisted session reference that is known to the system but
 * is not currently running under runtime control.
 */
export interface StoredSessionRef {
  provider: ProviderKind;
  providerSessionId: string;
  cwd?: string;
  rootDir?: string;
  title?: string;
  preview?: string;
  createdAt?: string;
  updatedAt?: string;
  lastUsedAt?: string;
  source?: "provider_history" | "previous_live";
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
