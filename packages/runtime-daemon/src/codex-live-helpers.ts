import {
  isPermissionAbort,
  isPermissionDenied,
  isPermissionSessionGrant,
  type AttachSessionRequest,
  type ManagedSession,
  type PermissionRequest,
  type PermissionResponseRequest,
} from "@rah/runtime-protocol";
import type { RuntimeServices } from "./provider-adapter";
import {
  applyProviderActivity,
  applyProviderActivityAsync,
  type ProviderActivity,
} from "./provider-activity";
import {
  type CodexLiveTranslatedActivity,
  mapCodexQuestionRequestToActivities,
  translateCodexAppServerNotification,
  translateCodexAppServerThreadSnapshot,
} from "./codex-app-server-activity";
import { type CodexAppServerRpcClient } from "./codex-live-rpc";
import {
  SESSION_SOURCE,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type LiveCodexSession,
} from "./codex-live-types";
import { requestCodexThreadResumeWithoutTranscript } from "./codex-app-server-resume";
import { setSessionSideLifecycleState } from "./session-side-lifecycle";
import {
  deleteRuntimeQueuedInput,
  publishSessionInputAccepted,
  publishSessionInputQueue,
} from "./session-input-queue";
import {
  codexNotificationCoalescing,
  materializeCodexCoalescedNotification,
  markCodexCompletionOutputIncomplete,
  prepareCodexNotificationForIngress,
  type CodexNotificationCoalescing,
} from "./codex-notification-ingress";
import { boundedJsonByteLength } from "./bounded-json-size";

type BufferedServerRequest = {
  request: JsonRpcRequest;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type QueuedCodexNotification = {
  notification: JsonRpcNotification;
  bytes: number;
  droppable: boolean;
  latencyTolerant: boolean;
  processOutputKey?: string;
  completionOutputKey?: string;
  coalesceKey?: string;
  coalesceMode?: Exclude<CodexNotificationCoalescing["mode"], "latest">;
  coalescedChunks?: string[];
  coalescedChunkHead?: number;
  coalescedChunkBytes?: number;
  coalescedBaseBytes?: number;
};

const MAX_CODEX_NOTIFICATION_QUEUE_ITEMS = 2_048;
const MAX_CODEX_NOTIFICATION_QUEUE_BYTES = 4 * 1024 * 1024;
const MAX_CODEX_COALESCED_DELTA_BYTES = 256 * 1024;
const MAX_CODEX_NOTIFICATION_DRAIN_ITEMS = 32;
const MAX_CODEX_NOTIFICATION_DRAIN_MS = 4;
const CODEX_DATA_PLANE_DRAIN_INTERVAL_MS = 25;
const MAX_BUFFERED_SERVER_REQUESTS = 256;
const MAX_INCOMPLETE_PROCESS_OUTPUT_KEYS = 4_096;

function isDroppableCodexNotification(notification: JsonRpcNotification): boolean {
  const method = notification.method.toLowerCase();
  return (
    method.includes("delta") ||
    method.endsWith("/progress") ||
    method.includes("outputdelta")
  );
}

function codexNotificationBytes(notification: JsonRpcNotification): number {
  return boundedJsonByteLength(
    notification,
    MAX_CODEX_NOTIFICATION_QUEUE_BYTES,
  );
}

function codexDeltaChunkBytes(
  mode: Exclude<CodexNotificationCoalescing["mode"], "latest">,
  chunk: string,
): number {
  return mode === "base64-delta"
    ? Buffer.byteLength(chunk, "base64")
    : Buffer.byteLength(chunk, "utf8");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeQuestionPermissionRequestId(itemId: string): string {
  return `permission-${itemId}`;
}

function makeCommandPermissionRequest(requestId: string, params: Record<string, unknown>): PermissionRequest {
  const command = typeof params.command === "string" ? params.command : "Run command";
  const cwd = typeof params.cwd === "string" ? params.cwd : null;
  return {
    id: requestId,
    kind: "tool",
    title: command,
    ...(typeof params.reason === "string" ? { description: params.reason } : {}),
    detail: {
      artifacts: [
        {
          kind: "command",
          command,
          ...(cwd ? { cwd } : {}),
        },
      ],
    },
    actions: [
      { id: "allow", label: "Yes", behavior: "allow", variant: "primary" },
      { id: "allow_for_session", label: "Yes for session", behavior: "allow", variant: "secondary" },
      { id: "abort", label: "Abort", behavior: "deny", variant: "danger" },
    ],
  };
}

function makeFilePermissionRequest(requestId: string, params: Record<string, unknown>): PermissionRequest {
  return {
    id: requestId,
    kind: "tool",
    title: "Apply file changes",
    ...(typeof params.reason === "string" ? { description: params.reason } : {}),
    actions: [
      { id: "allow", label: "Yes", behavior: "allow", variant: "primary" },
      { id: "allow_for_session", label: "Yes for session", behavior: "allow", variant: "secondary" },
      { id: "abort", label: "Abort", behavior: "deny", variant: "danger" },
    ],
  };
}

function makePermissionsPermissionRequest(requestId: string, params: Record<string, unknown>): PermissionRequest {
  return {
    id: requestId,
    kind: "mode",
    title: "Grant additional permissions",
    ...(typeof params.reason === "string" ? { description: params.reason } : {}),
    detail: {
      artifacts: [{ kind: "json", label: "permissions", value: params.permissions ?? {} }],
    },
    input: {
      permissions: params.permissions as never,
    },
    actions: [
      { id: "allow", label: "Allow", behavior: "allow", variant: "primary" },
      { id: "deny", label: "Deny", behavior: "deny", variant: "danger" },
    ],
  };
}

function makeMcpElicitationPermissionRequest(requestId: string, params: Record<string, unknown>): PermissionRequest {
  const serverName = typeof params.serverName === "string" ? params.serverName : "MCP server";
  const message = typeof params.message === "string" ? params.message : "MCP server requested input.";
  return {
    id: requestId,
    kind: "question",
    title: `${serverName} elicitation`,
    description: message,
    detail: {
      artifacts: [{ kind: "json", label: "elicitation", value: params }],
    },
    input: params as never,
    actions: [
      { id: "allow", label: "Accept", behavior: "allow", variant: "primary" },
      { id: "deny", label: "Decline", behavior: "deny", variant: "danger" },
    ],
  };
}

function shouldAttachCurrentTurn(activity: ProviderActivity): boolean {
  switch (activity.type) {
    case "timeline_item":
    case "timeline_item_updated":
    case "message_part_added":
    case "message_part_updated":
    case "message_part_delta":
    case "message_part_removed":
    case "tool_call_started":
    case "tool_call_delta":
    case "tool_call_completed":
    case "tool_call_failed":
    case "process_output_appended":
    case "process_output_snapshot":
    case "observation_started":
    case "observation_updated":
    case "observation_completed":
    case "observation_failed":
    case "permission_requested":
    case "permission_resolved":
    case "operation_started":
    case "operation_resolved":
    case "operation_requested":
    case "governance_updated":
    case "runtime_status":
    case "notification":
    case "usage":
      return activity.turnId === undefined;
    default:
      return false;
  }
}

export function attachCurrentTurn(
  activity: ProviderActivity,
  currentTurnId: string | null,
): ProviderActivity {
  if (!currentTurnId || !shouldAttachCurrentTurn(activity)) {
    return activity;
  }
  return {
    ...activity,
    turnId: currentTurnId,
  } as ProviderActivity;
}

function normalizeCurrentTurnLifecycle(
  activity: ProviderActivity,
  currentTurnId: string | null,
): ProviderActivity {
  if (
    !currentTurnId ||
    (activity.type !== "turn_completed" &&
      activity.type !== "turn_failed" &&
      activity.type !== "turn_canceled")
  ) {
    return activity;
  }
  // Some Codex app-server builds emit turn/completed without a stable turn id.
  // The translator uses "current-turn" as a placeholder; replacing it here keeps
  // the lifecycle tied to the active web turn and prevents dedupe from swallowing
  // later completions under the same placeholder.
  if (activity.turnId !== "current-turn") {
    return activity;
  }
  return {
    ...activity,
    turnId: currentTurnId,
  } as ProviderActivity;
}

function isActiveRuntimeState(state: ManagedSession["runtimeState"]): boolean {
  return (
    state === "running" ||
    state === "waiting_input" ||
    state === "waiting_permission"
  );
}

function isSubagentLifecycleObservation(activity: ProviderActivity): boolean {
  return (
    (activity.type === "observation_started" ||
      activity.type === "observation_updated" ||
      activity.type === "observation_completed" ||
      activity.type === "observation_failed") &&
    activity.observation.kind === "subagent.lifecycle"
  );
}

/**
 * Subagent lifecycle notifications describe work inside the public main turn.
 * Codex reports the nested agent's own turn id, but exposing that id to the
 * canonical projector creates a second top-level turn with no user message or
 * final answer. Always correlate visible subagent activity to the active main
 * turn instead.
 */
export function normalizeCodexSubagentObservationTurn(
  activity: ProviderActivity,
  currentTurnId: string | null,
): ProviderActivity {
  if (!currentTurnId || !isSubagentLifecycleObservation(activity)) {
    return activity;
  }
  return {
    ...activity,
    turnId: currentTurnId,
  } as ProviderActivity;
}

function isForeignProviderSessionActivity(args: {
  activity: ProviderActivity;
  providerSessionId?: string | undefined;
  mainProviderSessionId?: string | undefined;
}): boolean {
  if (
    !args.providerSessionId ||
    !args.mainProviderSessionId ||
    args.providerSessionId === args.mainProviderSessionId
  ) {
    return false;
  }
  if (isSubagentLifecycleObservation(args.activity)) {
    return false;
  }
  return true;
}

function isTurnLifecycleActivity(activity: ProviderActivity): activity is Extract<
  ProviderActivity,
  { type: "turn_started" | "turn_completed" | "turn_failed" | "turn_canceled" }
> {
  return (
    activity.type === "turn_started" ||
    activity.type === "turn_completed" ||
    activity.type === "turn_failed" ||
    activity.type === "turn_canceled"
  );
}

function isOutOfBandTurnLifecycleActivity(args: {
  activity: ProviderActivity;
  currentTurnId: string | null;
}): boolean {
  if (!args.currentTurnId || !isTurnLifecycleActivity(args.activity)) {
    return false;
  }
  if (args.activity.turnId === args.currentTurnId || args.activity.turnId === "current-turn") {
    return false;
  }
  // A Codex thread may publish delayed historical or nested-agent lifecycle
  // notifications under the main thread id. The turn id is the authoritative
  // correlation key while a web turn is active; accepting a different one
  // would let it end the public turn without clearing the adapter's private
  // currentTurnId, permanently blocking queued input.
  return true;
}

export function shouldApplyCodexTranslatedActivity(args: {
  activity: ProviderActivity;
  origin?: "notification" | "snapshot" | undefined;
  currentTurnId: string | null;
  hasPendingInput?: boolean;
  providerSessionId?: string | undefined;
  mainProviderSessionId?: string | undefined;
}): boolean {
  if (isSubagentLifecycleObservation(args.activity) && !args.currentTurnId) {
    // A delayed nested-agent completion after the main turn has settled has no
    // public turn to belong to. Native history already carries the completed
    // main-turn summary, so accepting this event would create an orphan row.
    return false;
  }
  if (isForeignProviderSessionActivity(args)) {
    return false;
  }
  if (isOutOfBandTurnLifecycleActivity(args)) {
    return false;
  }
  if (
    args.hasPendingInput === true &&
    args.activity.type === "session_state" &&
    args.activity.state === "idle"
  ) {
    // Codex may publish the idle snapshot/notification from thread/resume
    // after RAH has already accepted the first queued input but before
    // turn/start receives its turn id. That stale idle edge must not erase the
    // authoritative Starting/Working state while RAH still owns the prompt.
    return false;
  }
  if (
    args.activity.type !== "session_state" ||
    args.origin !== "snapshot" ||
    !args.currentTurnId
  ) {
    return true;
  }
  return isActiveRuntimeState(args.activity.state);
}

export function publishSessionBootstrap(
  services: RuntimeServices,
  sessionId: string,
  session: ManagedSession,
) {
  services.eventBus.publish({
    sessionId,
    type: "session.created",
    source: SESSION_SOURCE,
    payload: { session },
  });
  services.eventBus.publish({
    sessionId,
    type: "session.started",
    source: SESSION_SOURCE,
    payload: { session },
  });
}

async function applyCodexLiveTranslatedItems(
  services: RuntimeServices,
  liveSession: LiveCodexSession,
  items: CodexLiveTranslatedActivity[],
): Promise<void> {
  for (const item of items) {
    if (
      item.activity.type === "turn_started" &&
      liveSession.finishedTurnIds.has(item.activity.turnId)
    ) {
      continue;
    }
    if (
      !shouldApplyCodexTranslatedActivity({
        activity: item.activity,
        origin: item.origin,
        currentTurnId: liveSession.currentTurnId,
        hasPendingInput:
          liveSession.turnStartInFlight || liveSession.queuedInputs.length > 0,
        providerSessionId: item.providerSessionId,
        mainProviderSessionId: liveSession.threadId,
      })
    ) {
      continue;
    }
    const activity = attachCurrentTurn(
      normalizeCurrentTurnLifecycle(
        normalizeCodexSubagentObservationTurn(
          item.activity,
          liveSession.currentTurnId,
        ),
        liveSession.currentTurnId,
      ),
      liveSession.currentTurnId,
    );
    const events = await applyProviderActivityAsync(
      services,
      liveSession.sessionId,
      {
        provider: "codex",
        ...(item.channel !== undefined ? { channel: item.channel } : {}),
        ...(item.authority !== undefined ? { authority: item.authority } : {}),
        ...(item.raw !== undefined ? { raw: item.raw } : {}),
        ...(item.ts !== undefined ? { ts: item.ts } : {}),
      },
      activity,
    );
    if (
      activity.type === "timeline_item" &&
      activity.item.kind === "user_message" &&
      activity.item.clientMessageId
    ) {
      const clientMessageId = activity.item.clientMessageId;
      if (deleteRuntimeQueuedInput(liveSession.queuedInputs, clientMessageId)) {
        publishSessionInputAccepted(services, liveSession.sessionId, {
          clientMessageId,
          ...(activity.item.clientTurnId
            ? { clientTurnId: activity.item.clientTurnId }
            : {}),
        });
        if (
          liveSession.queuedInputSubmission?.clientMessageId === clientMessageId
        ) {
          delete liveSession.queuedInputSubmission;
        }
        if (
          liveSession.uncertainQueuedInputClientMessageId === clientMessageId
        ) {
          delete liveSession.uncertainQueuedInputClientMessageId;
        }
        liveSession.queuedInputDrainPaused = false;
        publishSessionInputQueue(
          services,
          liveSession.sessionId,
          liveSession.queuedInputs,
        );
      }
    }
    for (const event of events) {
      if (event.type === "turn.started") {
        liveSession.currentTurnId = event.turnId ?? null;
        const queuedInputSubmission = liveSession.queuedInputSubmission;
        if (queuedInputSubmission) {
          queuedInputSubmission.accepted = true;
          if (
            deleteRuntimeQueuedInput(
              liveSession.queuedInputs,
              queuedInputSubmission.clientMessageId,
            )
          ) {
            publishSessionInputAccepted(services, liveSession.sessionId, queuedInputSubmission);
            publishSessionInputQueue(
              services,
              liveSession.sessionId,
              liveSession.queuedInputs,
            );
          }
          if (
            liveSession.uncertainQueuedInputClientMessageId ===
            queuedInputSubmission.clientMessageId
          ) {
            delete liveSession.uncertainQueuedInputClientMessageId;
          }
          liveSession.queuedInputDrainPaused = false;
        }
        if (liveSession.ephemeral && item.origin !== "snapshot") {
          setSessionSideLifecycleState(services, liveSession.sessionId, "active");
        }
      } else if (
        event.type === "turn.completed" ||
        event.type === "turn.failed" ||
        event.type === "turn.canceled"
      ) {
        if (event.turnId) {
          liveSession.finishedTurnIds.add(event.turnId);
          liveSession.interruptingTurnIds.delete(event.turnId);
        }
        // shouldApplyCodexTranslatedActivity is the single turn-correlation
        // boundary. Once a terminal event passes it, public and private turn
        // state must transition together.
        liveSession.currentTurnId = null;
        liveSession.drainQueuedInput?.();
        if (liveSession.ephemeral && item.origin !== "snapshot") {
          setSessionSideLifecycleState(
            services,
            liveSession.sessionId,
            event.type === "turn.completed" ? "completed" : "ready",
          );
        }
      }
    }
  }
}

function threadIdFromNotification(notification: JsonRpcNotification): string | null {
  const params =
    notification.params && typeof notification.params === "object" && !Array.isArray(notification.params)
      ? (notification.params as Record<string, unknown>)
      : null;
  const thread =
    params?.thread && typeof params.thread === "object" && !Array.isArray(params.thread)
      ? (params.thread as Record<string, unknown>)
      : null;
  const threadId =
    typeof params?.threadId === "string"
      ? params.threadId
      : typeof params?.thread_id === "string"
        ? params.thread_id
        : typeof thread?.id === "string"
          ? thread.id
          : null;
  return threadId?.trim() || null;
}

function sideExpiryDetail(notification: JsonRpcNotification): string | null {
  if (notification.method === "thread/closed" || notification.method === "thread/deleted") {
    return "Codex closed this ephemeral Side task. Start a new Side to continue.";
  }
  if (notification.method !== "thread/status/changed") {
    return null;
  }
  const params =
    notification.params && typeof notification.params === "object" && !Array.isArray(notification.params)
      ? (notification.params as Record<string, unknown>)
      : null;
  const status =
    params?.status && typeof params.status === "object" && !Array.isArray(params.status)
      ? (params.status as Record<string, unknown>)
      : null;
  return status?.type === "notLoaded"
    ? "Codex unloaded this ephemeral Side task. Start a new Side to continue."
    : null;
}

function expireCodexSideFromNotification(
  services: RuntimeServices,
  liveSession: LiveCodexSession,
  notification: JsonRpcNotification,
): boolean {
  if (!liveSession.ephemeral || liveSession.disposalInFlight || liveSession.ephemeralExpired) {
    return false;
  }
  const detail = sideExpiryDetail(notification);
  if (!detail || threadIdFromNotification(notification) !== liveSession.threadId) {
    return false;
  }
  liveSession.ephemeralExpired = true;
  liveSession.queuedInputs.length = 0;
  delete liveSession.queuedInputSubmission;
  delete liveSession.queuedInputDrainPaused;
  delete liveSession.uncertainQueuedInputClientMessageId;
  publishSessionInputQueue(services, liveSession.sessionId, liveSession.queuedInputs);
  liveSession.currentTurnId = null;
  applyProviderActivity(
    services,
    liveSession.sessionId,
    {
      provider: "codex",
      channel: "structured_live",
      authority: "authoritative",
      raw: notification,
    },
    { type: "session_state", state: "stopped" },
  );
  setSessionSideLifecycleState(services, liveSession.sessionId, "expired", detail);
  // The Side is pathless and this app-server process is dedicated to it.
  // Keep the projected conversation visible, but release the provider process
  // as soon as the provider confirms that the thread cannot continue.
  void liveSession.client.dispose().catch((error) => {
    console.warn("[rah] failed to dispose expired Codex Side app-server", {
      sessionId: liveSession.sessionId,
      threadId: liveSession.threadId,
      error,
    });
  });
  return true;
}

function threadIdFromThreadStartedNotification(notification: JsonRpcNotification): string | null {
  if (notification.method !== "thread/started") {
    return null;
  }
  const params =
    notification.params && typeof notification.params === "object" && !Array.isArray(notification.params)
      ? (notification.params as Record<string, unknown>)
      : null;
  const thread =
    params?.thread && typeof params.thread === "object" && !Array.isArray(params.thread)
      ? (params.thread as Record<string, unknown>)
      : null;
  const threadId =
    typeof thread?.id === "string"
      ? thread.id
      : typeof params?.threadId === "string"
        ? params.threadId
        : typeof params?.thread_id === "string"
          ? params.thread_id
          : null;
  return threadId && threadId.trim() ? threadId : null;
}

function threadFromResponse(response: unknown): unknown {
  return response && typeof response === "object" && !Array.isArray(response)
    ? (response as Record<string, unknown>).thread
    : undefined;
}

function subscribeExternalCodexThreadForMirror(
  services: RuntimeServices,
  liveSession: LiveCodexSession,
) {
  if (
    liveSession.externalThreadMirrorSubscribed ||
    liveSession.externalThreadMirrorSubscribeInFlight ||
    !liveSession.threadId
  ) {
    return;
  }
  liveSession.externalThreadMirrorSubscribeInFlight = true;
  void (async () => {
    let attempt = 0;
    try {
      while (!liveSession.externalThreadMirrorSubscribed) {
        if (!services.sessionStore.getSession(liveSession.sessionId)) {
          return;
        }
        try {
          const response = await requestCodexThreadResumeWithoutTranscript({
            client: liveSession.client,
            params: { threadId: liveSession.threadId },
            timeoutMs: 30_000,
          });
          liveSession.externalThreadMirrorSubscribed = true;
          await applyCodexLiveTranslatedItems(
            services,
            liveSession,
            translateCodexAppServerThreadSnapshot(
              threadFromResponse(response),
              liveSession.translationState,
              response,
            ),
          );
          liveSession.drainQueuedInput?.();
          return;
        } catch {
          attempt += 1;
          await delay(Math.min(1_000, 100 + attempt * 50));
        }
      }
    } finally {
      liveSession.externalThreadMirrorSubscribeInFlight = false;
    }
  })();
}

function bindCodexThreadFromNotification(
  services: RuntimeServices,
  liveSession: LiveCodexSession,
  notification: JsonRpcNotification,
) {
  const threadId = threadIdFromThreadStartedNotification(notification);
  if (!threadId || liveSession.threadId === threadId) {
    return;
  }
  const wasUnbound = !liveSession.threadId;
  liveSession.threadId = threadId;
  const current = services.sessionStore.getSession(liveSession.sessionId);
  if (!current) {
    return;
  }
  const next = services.sessionStore.patchManagedSession(liveSession.sessionId, {
    providerSessionId: threadId,
    nativeTui: {
      terminalId: liveSession.sessionId,
      viewAvailable: true,
      promptState: "prompt_clean",
      queuedInputCount: 0,
    },
    capabilities: {
      nativeTui: true,
      rawPtyInput: true,
    },
    runtimeDiagnostics: {
      ...(current.session.runtimeDiagnostics ?? {}),
      lastEventCursor: `thread:${threadId}`,
    },
  });
  services.eventBus.publish({
    sessionId: liveSession.sessionId,
    type: "session.started",
    source: SESSION_SOURCE,
    payload: { session: next.session },
  });
  if (wasUnbound) {
    subscribeExternalCodexThreadForMirror(services, liveSession);
  }
  liveSession.drainQueuedInput?.();
}

async function handleCodexLiveNotification(
  services: RuntimeServices,
  liveSession: LiveCodexSession,
  notification: JsonRpcNotification,
): Promise<void> {
  if (expireCodexSideFromNotification(services, liveSession, notification)) {
    return;
  }
  bindCodexThreadFromNotification(services, liveSession, notification);
  await applyCodexLiveTranslatedItems(
    services,
    liveSession,
    translateCodexAppServerNotification(notification, liveSession.translationState),
  );
}

async function handleCodexLiveRequest(
  services: RuntimeServices,
  liveSession: LiveCodexSession,
  rpcRequest: JsonRpcRequest,
): Promise<unknown> {
  if (
    rpcRequest.method === "item/tool/requestUserInput" ||
    rpcRequest.method === "tool/requestUserInput"
  ) {
    const params =
      rpcRequest.params && typeof rpcRequest.params === "object" && !Array.isArray(rpcRequest.params)
        ? (rpcRequest.params as Record<string, unknown>)
        : {};
    const itemId = typeof params.itemId === "string" ? params.itemId : `question-${rpcRequest.id}`;
    const permissionRequestId = makeQuestionPermissionRequestId(itemId);
    const activities = mapCodexQuestionRequestToActivities({
      itemId,
      questions: params.questions,
    });
    liveSession.pendingQuestions.set(itemId, { permissionRequestId });
    for (const item of activities) {
      applyProviderActivity(
        services,
        liveSession.sessionId,
        {
          provider: "codex",
          ...(item.channel !== undefined ? { channel: item.channel } : {}),
          ...(item.authority !== undefined ? { authority: item.authority } : {}),
          ...(item.raw !== undefined ? { raw: item.raw } : {}),
          ...(item.ts !== undefined ? { ts: item.ts } : {}),
        },
        attachCurrentTurn(item.activity, liveSession.currentTurnId),
      );
    }
    return await new Promise((resolve) => {
      liveSession.pendingApprovals.set(permissionRequestId, {
        kind: "question",
        resolve,
        requestId: permissionRequestId,
        itemId,
        questions: params.questions,
      });
    });
  }

  if (
    rpcRequest.method === "item/commandExecution/requestApproval" ||
    rpcRequest.method === "item/fileChange/requestApproval" ||
    rpcRequest.method === "item/permissions/requestApproval" ||
    rpcRequest.method === "execCommandApproval" ||
    rpcRequest.method === "applyPatchApproval"
  ) {
    const params =
      rpcRequest.params && typeof rpcRequest.params === "object" && !Array.isArray(rpcRequest.params)
        ? (rpcRequest.params as Record<string, unknown>)
        : {};
    const itemId = typeof params.itemId === "string" ? params.itemId : `approval-${rpcRequest.id}`;
    const requestId = `permission-${itemId}`;
    const approvalKind =
      rpcRequest.method === "item/permissions/requestApproval"
        ? "permissions"
        : rpcRequest.method === "item/commandExecution/requestApproval" ||
            rpcRequest.method === "execCommandApproval"
          ? "command"
          : "file";
    const permissionRequest =
      approvalKind === "permissions"
        ? makePermissionsPermissionRequest(requestId, params)
        : approvalKind === "command"
          ? makeCommandPermissionRequest(requestId, params)
          : makeFilePermissionRequest(requestId, params);
    applyProviderActivity(
      services,
      liveSession.sessionId,
      { provider: "codex", channel: "structured_live", authority: "derived", raw: rpcRequest },
      liveSession.currentTurnId
        ? { type: "permission_requested", request: permissionRequest, turnId: liveSession.currentTurnId }
        : { type: "permission_requested", request: permissionRequest },
    );
    return await new Promise((resolve) => {
      liveSession.pendingApprovals.set(requestId, {
        kind: approvalKind,
        resolve,
        requestId,
        itemId,
        approvalResponseShape:
          rpcRequest.method === "execCommandApproval" ||
          rpcRequest.method === "applyPatchApproval"
            ? "approval"
            : "action",
        ...(approvalKind === "permissions" ? { requestedPermissions: params.permissions } : {}),
      });
    });
  }

  if (rpcRequest.method === "mcpServer/elicitation/request") {
    const params =
      rpcRequest.params && typeof rpcRequest.params === "object" && !Array.isArray(rpcRequest.params)
        ? (rpcRequest.params as Record<string, unknown>)
        : {};
    const requestId = `permission-mcp-${rpcRequest.id}`;
    const turnId = typeof params.turnId === "string" ? params.turnId : liveSession.currentTurnId ?? undefined;
    applyProviderActivity(
      services,
      liveSession.sessionId,
      { provider: "codex", channel: "structured_live", authority: "derived", raw: rpcRequest },
      turnId
        ? {
            type: "permission_requested",
            request: makeMcpElicitationPermissionRequest(requestId, params),
            turnId,
          }
        : {
            type: "permission_requested",
            request: makeMcpElicitationPermissionRequest(requestId, params),
          },
    );
    return await new Promise((resolve) => {
      liveSession.pendingApprovals.set(requestId, {
        kind: "mcp_elicitation",
        resolve,
        requestId,
        itemId: requestId,
      });
    });
  }

  if (rpcRequest.method === "item/tool/call") {
    const params =
      rpcRequest.params && typeof rpcRequest.params === "object" && !Array.isArray(rpcRequest.params)
        ? (rpcRequest.params as Record<string, unknown>)
        : {};
    const callId = typeof params.callId === "string" ? params.callId : `dynamic-${rpcRequest.id}`;
    const tool = typeof params.tool === "string" ? params.tool : "dynamic tool";
    const turnId = typeof params.turnId === "string" ? params.turnId : liveSession.currentTurnId ?? undefined;
    applyProviderActivity(
      services,
      liveSession.sessionId,
      { provider: "codex", channel: "structured_live", authority: "derived", raw: rpcRequest },
      {
        type: "operation_requested",
        ...(turnId !== undefined ? { turnId } : {}),
        operation: {
          id: callId,
          kind: "external_tool",
          name: tool,
          target: "client",
          input: params as never,
        },
      },
    );
    applyProviderActivity(
      services,
      liveSession.sessionId,
      { provider: "codex", channel: "structured_live", authority: "derived", raw: rpcRequest },
      {
        type: "tool_call_failed",
        ...(turnId !== undefined ? { turnId } : {}),
        toolCallId: callId,
        error: "RAH does not implement client-side dynamic tool execution yet.",
      },
    );
    return {
      contentItems: [
        {
          type: "inputText",
          text: "RAH does not implement client-side dynamic tool execution yet.",
        },
      ],
      success: false,
    };
  }

  if (rpcRequest.method === "account/chatgptAuthTokens/refresh") {
    applyProviderActivity(
      services,
      liveSession.sessionId,
      { provider: "codex", channel: "structured_live", authority: "derived", raw: rpcRequest },
      {
        type: "operation_requested",
        operation: {
          id: `auth-refresh-${rpcRequest.id}`,
          kind: "provider_internal",
          name: "ChatGPT auth token refresh",
          target: "account",
          input: (rpcRequest.params ?? {}) as never,
        },
      },
    );
    throw new Error("RAH does not manage ChatGPT auth token refresh requests.");
  }

  if (rpcRequest.method === "attestation/generate") {
    applyProviderActivity(
      services,
      liveSession.sessionId,
      { provider: "codex", channel: "structured_live", authority: "derived", raw: rpcRequest },
      {
        type: "operation_requested",
        operation: {
          id: `attestation-${rpcRequest.id}`,
          kind: "provider_internal",
          name: "Generate client attestation",
          target: "account",
          input: (rpcRequest.params ?? {}) as never,
        },
      },
    );
    throw new Error("RAH does not provide Codex client attestation tokens.");
  }

  return {};
}

export function createLiveSessionBridge(
  services: RuntimeServices,
  client: CodexAppServerRpcClient,
) {
  const notificationEntries: QueuedCodexNotification[] = [];
  let notificationHead = 0;
  const coalescedNotificationEntries = new Map<
    string,
    QueuedCodexNotification
  >();
  const incompleteProcessOutputKeys = new Set<string>();
  const bufferedRequests: BufferedServerRequest[] = [];
  let liveSession: LiveCodexSession | null = null;
  let queuedNotificationBytes = 0;
  let queuedUrgentNotifications = 0;
  let drainingNotifications = false;
  let notificationDrainScheduled = false;
  let notificationDrainScheduledUrgent = false;
  let cancelScheduledNotificationDrain: (() => void) | null = null;
  let bridgeOverloaded = false;
  const notificationDrainWaiters = new Set<() => void>();

  const queuedNotificationCount = () =>
    notificationEntries.length - notificationHead;

  const compactConsumedNotificationEntries = () => {
    if (
      notificationHead < 256 ||
      notificationHead * 2 < notificationEntries.length
    ) {
      return;
    }
    notificationEntries.splice(0, notificationHead);
    notificationHead = 0;
  };

  const markProcessOutputIncomplete = (key: string | undefined) => {
    if (!key) {
      return;
    }
    incompleteProcessOutputKeys.delete(key);
    incompleteProcessOutputKeys.add(key);
    while (
      incompleteProcessOutputKeys.size > MAX_INCOMPLETE_PROCESS_OUTPUT_KEYS
    ) {
      const oldest = incompleteProcessOutputKeys.values().next().value;
      if (typeof oldest !== "string") {
        break;
      }
      incompleteProcessOutputKeys.delete(oldest);
    }
  };

  const forgetCoalescedEntry = (entry: QueuedCodexNotification) => {
    if (
      entry.coalesceKey &&
      coalescedNotificationEntries.get(entry.coalesceKey) === entry
    ) {
      coalescedNotificationEntries.delete(entry.coalesceKey);
    }
  };

  const resolveNotificationDrainWaiters = () => {
    if (
      drainingNotifications ||
      notificationDrainScheduled ||
      queuedNotificationCount() > 0
    ) {
      return;
    }
    for (const resolve of notificationDrainWaiters) {
      resolve();
    }
    notificationDrainWaiters.clear();
  };

  const removeQueuedDroppableNotifications = (): boolean => {
    const retained: QueuedCodexNotification[] = [];
    let retainedBytes = 0;
    let removedAny = false;
    for (
      let index = notificationHead;
      index < notificationEntries.length;
      index += 1
    ) {
      const entry = notificationEntries[index]!;
      if (entry.droppable) {
        markProcessOutputIncomplete(entry.processOutputKey);
        forgetCoalescedEntry(entry);
        removedAny = true;
        continue;
      }
      retained.push(entry);
      retainedBytes += entry.bytes;
    }
    if (!removedAny) {
      return false;
    }
    notificationEntries.splice(0, notificationEntries.length, ...retained);
    notificationHead = 0;
    queuedNotificationBytes = retainedBytes;
    queuedUrgentNotifications = retained.reduce(
      (count, entry) => count + (entry.latencyTolerant ? 0 : 1),
      0,
    );
    return true;
  };

  const cancelNotificationDrain = () => {
    cancelScheduledNotificationDrain?.();
    cancelScheduledNotificationDrain = null;
    notificationDrainScheduled = false;
    notificationDrainScheduledUrgent = false;
  };

  const markBridgeOverloaded = (notification: JsonRpcNotification) => {
    if (bridgeOverloaded) {
      return;
    }
    bridgeOverloaded = true;
    console.error("[rah] Codex notification bridge exceeded its bounded queue", {
      sessionId: liveSession?.sessionId,
      method: notification.method,
      queuedItems: queuedNotificationCount(),
      queuedBytes: queuedNotificationBytes,
    });
    notificationEntries.length = 0;
    notificationHead = 0;
    queuedNotificationBytes = 0;
    queuedUrgentNotifications = 0;
    coalescedNotificationEntries.clear();
    cancelNotificationDrain();
    // A semantic-event flood means ordering can no longer be guaranteed.
    // Dispose the provider channel and let the normal reconnect/resume path
    // rebuild canonical state instead of allowing daemon memory to grow.
    void client.dispose().catch(() => undefined);
  };

  const scheduleNotificationDrain = (urgent = false) => {
    if (
      drainingNotifications ||
      !liveSession ||
      bridgeOverloaded
    ) {
      return;
    }
    if (notificationDrainScheduled) {
      if (!urgent || notificationDrainScheduledUrgent) {
        return;
      }
      // A lifecycle, permission, or completion event must not wait behind the
      // data-plane cadence. Promote the existing delayed drain.
      cancelNotificationDrain();
    }
    notificationDrainScheduled = true;
    notificationDrainScheduledUrgent = urgent;
    const run = () => {
      cancelScheduledNotificationDrain = null;
      notificationDrainScheduled = false;
      notificationDrainScheduledUrgent = false;
      void drainNotifications();
    };
    if (urgent) {
      const immediate = setImmediate(run);
      cancelScheduledNotificationDrain = () => clearImmediate(immediate);
      return;
    }
    const timer = setTimeout(run, CODEX_DATA_PLANE_DRAIN_INTERVAL_MS);
    timer.unref?.();
    cancelScheduledNotificationDrain = () => clearTimeout(timer);
  };

  const drainNotifications = async () => {
    if (drainingNotifications || !liveSession || bridgeOverloaded) {
      resolveNotificationDrainWaiters();
      return;
    }
    drainingNotifications = true;
    const startedAt = performance.now();
    let processed = 0;
    try {
      while (
        liveSession &&
        queuedNotificationCount() > 0 &&
        !bridgeOverloaded &&
        processed < MAX_CODEX_NOTIFICATION_DRAIN_ITEMS &&
        performance.now() - startedAt < MAX_CODEX_NOTIFICATION_DRAIN_MS
      ) {
        const entry = notificationEntries[notificationHead++]!;
        queuedNotificationBytes -= entry.bytes;
        if (!entry.latencyTolerant) {
          queuedUrgentNotifications = Math.max(
            0,
            queuedUrgentNotifications - 1,
          );
        }
        forgetCoalescedEntry(entry);
        compactConsumedNotificationEntries();
        processed += 1;
        try {
          const notification =
            entry.coalesceMode && entry.coalescedChunks
              ? materializeCodexCoalescedNotification(
                  entry.notification,
                  entry.coalesceMode,
                  entry.coalescedChunks.slice(
                    entry.coalescedChunkHead ?? 0,
                  ),
                )
              : entry.notification;
          await handleCodexLiveNotification(services, liveSession, notification);
        } catch (error) {
          console.warn("[rah] failed to apply Codex live notification", {
            sessionId: liveSession.sessionId,
            method: entry.notification.method,
            error,
          });
        }
      }
    } finally {
      drainingNotifications = false;
      if (queuedNotificationBytes < 0) {
        queuedNotificationBytes = 0;
      }
      if (liveSession && queuedNotificationCount() > 0 && !bridgeOverloaded) {
        scheduleNotificationDrain(queuedUrgentNotifications > 0);
      }
      resolveNotificationDrainWaiters();
    }
  };

  const enqueueNotification = (
    notification: JsonRpcNotification,
  ) => {
    if (bridgeOverloaded) {
      return;
    }
    const prepared = prepareCodexNotificationForIngress(notification);
    if (prepared.truncatedProcessOutput) {
      markProcessOutputIncomplete(
        prepared.processOutputKey ?? prepared.completionOutputKey,
      );
    }
    let boundedNotification = prepared.notification;
    if (
      prepared.completionOutputKey &&
      incompleteProcessOutputKeys.has(prepared.completionOutputKey)
    ) {
      boundedNotification =
        markCodexCompletionOutputIncomplete(boundedNotification);
    }
    const coalescing = codexNotificationCoalescing(boundedNotification);
    const coalesceKey = coalescing?.key;
    const droppable = isDroppableCodexNotification(boundedNotification);
    const coalescedChunkBytes =
      coalescing && coalescing.mode !== "latest"
        ? codexDeltaChunkBytes(coalescing.mode, coalescing.chunk)
        : undefined;
    const notificationBytes = codexNotificationBytes(boundedNotification);
    const entry: QueuedCodexNotification = {
      notification: boundedNotification,
      bytes: notificationBytes,
      droppable,
      latencyTolerant: droppable || coalescing !== undefined,
      ...(prepared.processOutputKey
        ? { processOutputKey: prepared.processOutputKey }
        : {}),
      ...(prepared.completionOutputKey
        ? { completionOutputKey: prepared.completionOutputKey }
        : {}),
      ...(coalesceKey ? { coalesceKey } : {}),
      ...(coalescing && coalescing.mode !== "latest"
        ? {
            coalesceMode: coalescing.mode,
            coalescedChunks: [coalescing.chunk],
            coalescedChunkHead: 0,
            coalescedChunkBytes: coalescedChunkBytes!,
            coalescedBaseBytes: Math.max(
              0,
              notificationBytes - (coalescedChunkBytes ?? 0),
            ),
          }
        : {}),
    };
    const previousCoalescedEntry = coalesceKey
      ? coalescedNotificationEntries.get(coalesceKey)
      : undefined;
    if (previousCoalescedEntry) {
      const previousBytes = previousCoalescedEntry.bytes;
      const previousLatencyTolerant =
        previousCoalescedEntry.latencyTolerant;
      if (
        previousCoalescedEntry.coalesceMode &&
        entry.coalesceMode === previousCoalescedEntry.coalesceMode &&
        entry.coalescedChunks?.length === 1
      ) {
        const chunk = entry.coalescedChunks[0]!;
        const chunkBytes = entry.coalescedChunkBytes ?? 0;
        previousCoalescedEntry.notification = entry.notification;
        previousCoalescedEntry.coalescedChunks?.push(chunk);
        previousCoalescedEntry.coalescedChunkBytes =
          (previousCoalescedEntry.coalescedChunkBytes ?? 0) + chunkBytes;
        previousCoalescedEntry.coalescedBaseBytes =
          entry.coalescedBaseBytes ?? 0;
        let head = previousCoalescedEntry.coalescedChunkHead ?? 0;
        const chunks = previousCoalescedEntry.coalescedChunks ?? [];
        while (
          (previousCoalescedEntry.coalescedChunkBytes ?? 0) >
            MAX_CODEX_COALESCED_DELTA_BYTES &&
          head < chunks.length - 1
        ) {
          const removed = chunks[head++]!;
          previousCoalescedEntry.coalescedChunkBytes =
            (previousCoalescedEntry.coalescedChunkBytes ?? 0) -
            codexDeltaChunkBytes(
              previousCoalescedEntry.coalesceMode,
              removed,
            );
          markProcessOutputIncomplete(
            previousCoalescedEntry.processOutputKey ??
              entry.processOutputKey,
          );
        }
        previousCoalescedEntry.coalescedChunkHead = head;
        if (head >= 64 && head * 2 >= chunks.length) {
          chunks.splice(0, head);
          previousCoalescedEntry.coalescedChunkHead = 0;
        }
        previousCoalescedEntry.bytes = Math.min(
          MAX_CODEX_NOTIFICATION_QUEUE_BYTES + 1,
          (previousCoalescedEntry.coalescedBaseBytes ?? 0) +
            (previousCoalescedEntry.coalescedChunkBytes ?? 0),
        );
      } else {
        previousCoalescedEntry.notification = entry.notification;
        previousCoalescedEntry.bytes = entry.bytes;
      }
      previousCoalescedEntry.droppable = entry.droppable;
      previousCoalescedEntry.latencyTolerant = entry.latencyTolerant;
      if (entry.processOutputKey) {
        previousCoalescedEntry.processOutputKey = entry.processOutputKey;
      } else {
        delete previousCoalescedEntry.processOutputKey;
      }
      if (entry.completionOutputKey) {
        previousCoalescedEntry.completionOutputKey = entry.completionOutputKey;
      } else {
        delete previousCoalescedEntry.completionOutputKey;
      }
      queuedNotificationBytes +=
        previousCoalescedEntry.bytes - previousBytes;
      if (
        previousLatencyTolerant !==
        previousCoalescedEntry.latencyTolerant
      ) {
        queuedUrgentNotifications += previousCoalescedEntry.latencyTolerant
          ? -1
          : 1;
      }
      if (queuedNotificationBytes > MAX_CODEX_NOTIFICATION_QUEUE_BYTES) {
        markBridgeOverloaded(boundedNotification);
      }
      scheduleNotificationDrain(queuedUrgentNotifications > 0);
      return;
    }
    const exceedsQueueBudget = () =>
      queuedNotificationCount() >= MAX_CODEX_NOTIFICATION_QUEUE_ITEMS ||
      queuedNotificationBytes + entry.bytes > MAX_CODEX_NOTIFICATION_QUEUE_BYTES;
    if (exceedsQueueBudget() && entry.droppable) {
      markProcessOutputIncomplete(entry.processOutputKey);
      return;
    }
    if (exceedsQueueBudget()) {
      removeQueuedDroppableNotifications();
      if (
        entry.completionOutputKey &&
        incompleteProcessOutputKeys.has(entry.completionOutputKey)
      ) {
        entry.notification = markCodexCompletionOutputIncomplete(
          entry.notification,
        );
        entry.bytes = codexNotificationBytes(entry.notification);
      }
    }
    if (exceedsQueueBudget()) {
      markBridgeOverloaded(notification);
      return;
    }
    notificationEntries.push(entry);
    if (entry.coalesceKey) {
      coalescedNotificationEntries.set(entry.coalesceKey, entry);
    }
    queuedNotificationBytes += entry.bytes;
    if (!entry.latencyTolerant) {
      queuedUrgentNotifications += 1;
    }
    if (entry.completionOutputKey) {
      incompleteProcessOutputKeys.delete(entry.completionOutputKey);
    }
    // Provider callbacks are transport ingress, not a work loop. Always yield
    // before translating notifications so a noisy Codex child cannot occupy
    // the daemon's current RPC/read callback and starve RAH control traffic.
    scheduleNotificationDrain(!entry.latencyTolerant);
  };

  client.setNotificationHandler((notification) => {
    enqueueNotification(notification);
  });

  client.setRequestHandler((request) => {
    if (liveSession) {
      return handleCodexLiveRequest(services, liveSession, request);
    }
    if (bufferedRequests.length >= MAX_BUFFERED_SERVER_REQUESTS) {
      return Promise.reject(
        new Error("Codex server request queue is full before session activation."),
      );
    }
    return new Promise((resolve, reject) => {
      bufferedRequests.push({
        request,
        resolve,
        reject,
      });
    });
  });

  return {
    activate(nextLiveSession: LiveCodexSession) {
      liveSession = nextLiveSession;
      nextLiveSession.flushNotifications = async () => {
        cancelNotificationDrain();
        void drainNotifications();
        while (
          drainingNotifications ||
          notificationDrainScheduled ||
          queuedNotificationCount() > 0
        ) {
          await new Promise<void>((resolve) => {
            notificationDrainWaiters.add(resolve);
          });
        }
      };
      scheduleNotificationDrain(queuedUrgentNotifications > 0);
      for (const pending of bufferedRequests.splice(0)) {
        void handleCodexLiveRequest(services, nextLiveSession, pending.request).then(
          pending.resolve,
          (error) => {
            pending.reject(error instanceof Error ? error : new Error(String(error)));
          },
        );
      }
    },
  };
}

export function attachRequestedClient(
  services: RuntimeServices,
  sessionId: string,
  attach: AttachSessionRequest | undefined,
) {
  if (!attach) {
    return;
  }
  services.sessionStore.attachClient({
    sessionId,
    clientId: attach.client.id,
    kind: attach.client.kind,
    connectionId: attach.client.connectionId,
    attachMode: attach.mode,
    focus: true,
  });
  services.eventBus.publish({
    sessionId,
    type: "session.attached",
    source: SESSION_SOURCE,
    payload: {
      clientId: attach.client.id,
      clientKind: attach.client.kind,
    },
  });
  if (attach.claimControl) {
    services.sessionStore.claimControl(sessionId, attach.client.id, attach.client.kind);
    services.eventBus.publish({
      sessionId,
      type: "control.claimed",
      source: SESSION_SOURCE,
      payload: {
        clientId: attach.client.id,
        clientKind: attach.client.kind,
      },
    });
  }
}

export function isCodexInternalThreadMetadataText(value: string | null | undefined): boolean {
  if (!value) {
    return false;
  }
  return (
    value.includes("<environment_context>") ||
    value.includes("# AGENTS.md instructions") ||
    value.includes("<INSTRUCTIONS>") ||
    value.includes("<permissions instructions>") ||
    value.includes("<skills_instructions>")
  );
}

export function resolveCodexApprovalDecision(
  response: PermissionResponseRequest,
  responseShape: "action" | "approval",
): string {
  if (isPermissionSessionGrant(response)) {
    return responseShape === "approval" ? "approved_for_session" : "acceptForSession";
  }
  if (isPermissionAbort(response)) {
    return responseShape === "approval" ? "abort" : "cancel";
  }
  if (isPermissionDenied(response)) {
    return responseShape === "approval" ? "denied" : "decline";
  }
  if (response.behavior === "allow") {
    return responseShape === "approval" ? "approved" : "accept";
  }
  return responseShape === "approval" ? "denied" : "decline";
}
