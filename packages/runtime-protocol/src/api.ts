import type {
  AttachMode,
  AttachedClient,
  ClientKind,
  ControlLease,
  ManagedSession,
  ProviderKind,
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

export interface StartSessionRequest {
  provider: ProviderKind;
  cwd: string;
  title?: string;
  model?: string;
  approvalPolicy?: string;
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
  preferStoredReplay?: boolean;
  historyReplay?: "include" | "skip";
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

export interface ClaimControlRequest {
  client: AttachClientDescriptor;
}

export interface ReleaseControlRequest {
  clientId: string;
}

export interface WorkspaceDirectoryRequest {
  dir: string;
}

export interface WorkspaceDirectoryResponse {
  path: string;
}

export interface PermissionResponseRequest {
  behavior: "allow" | "deny";
  message?: string;
  selectedActionId?: string;
  decision?:
    | "approved"
    | "approved_for_session"
    | "denied"
    | "abort"
    | "accept"
    | "acceptForSession"
    | "decline"
    | "cancel";
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

export interface GitStatusResponse {
  sessionId: string;
  branch?: string;
  changedFiles: string[];
}

export interface GitDiffResponse {
  sessionId: string;
  path: string;
  diff: string;
}

export interface SessionHistoryPageResponse {
  sessionId: string;
  events: RahEvent[];
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
  version?: string;
  detail?: string;
  auth: "provider_managed";
}

export interface ListProvidersResponse {
  providers: ProviderDiagnostic[];
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
