import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import {
  isPermissionSessionGrant,
  type PermissionRequest,
  type PermissionResponseRequest,
} from "@rah/runtime-protocol";
import type { ProviderActivity } from "./provider-activity";
import type {
  QueuedTurn,
  TerminalWrapperPromptState,
} from "./terminal-wrapper-control";
import {
  createCodexAppServerClient,
  type CodexJsonRpcClient,
} from "./codex-live-client";
import {
  createCodexAppServerTranslationState,
  mapCodexPermissionResolution,
  mapCodexQuestionRequestToActivities,
  translateCodexAppServerNotification,
} from "./codex-app-server-activity";
import {
  createCodexRolloutTranslationState,
  translateCodexRolloutLine,
  type CodexRolloutTranslationState,
} from "./codex-rollout-activity";
import {
  discoverCodexStoredSessions,
  type CodexStoredSessionRecord,
} from "./codex-stored-sessions";
import {
  nextPromptStateFromActivity,
  selectCodexStoredSessionCandidate,
  sliceUnprocessedRolloutLines,
} from "./codex-terminal-wrapper-bridge";
import {
  createIsolatedCodexWrapperHome,
  resolveCodexBaseHome,
} from "./codex-wrapper-home";
import { NativeTerminalProcess } from "./native-terminal-process";
import { resolveConfiguredBinary } from "./provider-binary-utils";
import {
  clearTerminalScreen,
  enterAlternateScreen,
  leaveAlternateScreen,
  renderTerminalWrapperPanel,
  renderTerminalWrapperPanelForTerminal,
  restoreInheritedTerminalModes,
} from "./terminal-wrapper-panel";
import { deriveTerminalWrapperRemoteControlState } from "./terminal-wrapper-remote-control";
import { assertExistingWorkingDirectorySync } from "./provider-working-directory";

type WrapperMode = "local_native" | "remote_writer";

function isRemoteWriterMode(mode: WrapperMode): boolean {
  return mode === "remote_writer";
}

const CODEX_APP_SERVER_REQUEST_TIMEOUT_MS = 90_000;
const CODEX_APP_SERVER_INTERRUPT_TIMEOUT_MS = 5_000;
const CODEX_APP_SERVER_INTERRUPT_MAX_ATTEMPTS = 3;

function parseArgs(argv: string[]) {
  let daemonUrl = "http://127.0.0.1:43111";
  let cwd = process.cwd();
  let resumeProviderSessionId: string | undefined;

  const rest = [...argv];
  while (rest.length > 0) {
    const arg = rest.shift();
    if (arg === "--daemon-url") {
      daemonUrl = rest.shift() ?? daemonUrl;
      continue;
    }
    if (arg === "--cwd") {
      cwd = rest.shift() ?? cwd;
      continue;
    }
    if (arg === "--resume-provider-session-id") {
      resumeProviderSessionId = rest.shift() ?? resumeProviderSessionId;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { daemonUrl, cwd, ...(resumeProviderSessionId ? { resumeProviderSessionId } : {}) };
}

function wrapperControlUrl(daemonUrl: string): string {
  const url = new URL(daemonUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/api/wrapper-control";
  url.search = "";
  return url.toString();
}

async function resolveCodexBinary(): Promise<string> {
  return await resolveConfiguredBinary("RAH_CODEX_BINARY", "codex");
}

function resolveRahHome(): string {
  return process.env.RAH_HOME ?? path.join(os.homedir(), ".rah", "runtime-daemon");
}

function createWrapperLogger(provider: string) {
  const logDir = path.join(resolveRahHome(), "wrapper-logs");
  mkdirSync(logDir, { recursive: true });
  const logPath = path.join(
    logDir,
    `${provider}-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}.log`,
  );
  return {
    logPath,
    log(message: string) {
      appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`, "utf8");
    },
  };
}

function makeWrapperPermissionRequest(
  requestId: string,
  title: string,
  params: Record<string, unknown>,
): PermissionRequest {
  return {
    id: requestId,
    kind: "tool",
    title,
    ...(typeof params.reason === "string" ? { description: params.reason } : {}),
    actions: [
      { id: "allow", label: "Allow", behavior: "allow", variant: "primary" },
      { id: "deny", label: "Deny", behavior: "deny", variant: "danger" },
    ],
  };
}

function makeQuestionPermissionRequestId(itemId: string): string {
  return `permission-${itemId}`;
}

function resolveApprovalDecision(
  response: PermissionResponseRequest,
  protocol: "v2" | "legacy",
): string {
  if (response.decision) {
    return response.decision;
  }
  if (protocol === "legacy") {
    return response.behavior === "allow" ? "approved" : "abort";
  }
  if (response.behavior === "allow") {
    return isPermissionSessionGrant(response)
      ? "approved_for_session"
      : "approved";
  }
  return "denied";
}

function shouldMirrorControlActivity(activity: ProviderActivity): boolean {
  switch (activity.type) {
    case "turn_started":
    case "turn_completed":
    case "turn_failed":
    case "turn_canceled":
    case "permission_requested":
    case "permission_resolved":
    case "runtime_status":
    case "usage":
      return true;
    default:
      return false;
  }
}

function readThreadStartResponse(
  response: unknown,
): { threadId: string; title?: string; preview?: string } {
  const record =
    response && typeof response === "object" && !Array.isArray(response)
      ? (response as Record<string, unknown>)
      : {};
  const thread =
    record.thread && typeof record.thread === "object" && !Array.isArray(record.thread)
      ? (record.thread as Record<string, unknown>)
      : null;
  const threadId = thread && typeof thread.id === "string" ? thread.id : null;
  if (!threadId) {
    throw new Error("Codex app-server did not return a thread id.");
  }
  const title =
    thread && typeof thread.name === "string" && thread.name.trim()
      ? thread.name
      : undefined;
  const preview =
    thread && typeof thread.preview === "string" && thread.preview.trim()
      ? thread.preview
      : undefined;
  return {
    threadId,
    ...(title !== undefined ? { title } : {}),
    ...(preview !== undefined ? { preview } : {}),
  };
}

function readTurnStartResponse(response: unknown): { turnId?: string } {
  const record =
    response && typeof response === "object" && !Array.isArray(response)
      ? (response as Record<string, unknown>)
      : {};
  const turn =
    record.turn && typeof record.turn === "object" && !Array.isArray(record.turn)
      ? (record.turn as Record<string, unknown>)
      : null;
  return turn && typeof turn.id === "string" ? { turnId: turn.id } : {};
}

function readPersistedTaskLifecycle(line: unknown):
  | { kind: "started"; turnId: string }
  | { kind: "completed"; turnId: string }
  | { kind: "canceled"; turnId: string }
  | null {
  if (!line || typeof line !== "object" || Array.isArray(line)) {
    return null;
  }
  const record = line as Record<string, unknown>;
  if (record.type !== "event_msg") {
    return null;
  }
  const payload =
    record.payload && typeof record.payload === "object" && !Array.isArray(record.payload)
      ? (record.payload as Record<string, unknown>)
      : null;
  if (!payload || typeof payload.turn_id !== "string") {
    return null;
  }
  if (payload.type === "task_started") {
    return { kind: "started", turnId: payload.turn_id };
  }
  if (payload.type === "task_complete") {
    return { kind: "completed", turnId: payload.turn_id };
  }
  if (payload.type === "turn_aborted") {
    return { kind: "canceled", turnId: payload.turn_id };
  }
  return null;
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  assertExistingWorkingDirectorySync(parsed.cwd, "Session working directory");
  const startupTimestampMs = Date.now();
  const logger = createWrapperLogger("codex");
  const sharedCodexHome = resolveCodexBaseHome();
  const wrapperCodexHome = parsed.resumeProviderSessionId
    ? null
    : createIsolatedCodexWrapperHome(sharedCodexHome);
  if (wrapperCodexHome) {
    process.env.CODEX_HOME = wrapperCodexHome;
    logger.log(`[rah] isolated codex home: ${wrapperCodexHome}`);
  } else {
    logger.log(`[rah] using shared codex home: ${sharedCodexHome}`);
  }

  let translationState: CodexRolloutTranslationState = createCodexRolloutTranslationState();
  const controlTranslationState = createCodexAppServerTranslationState();
  let processedLineCount = 0;
  let wrapperSessionId: string | null = null;
  let boundRecord: CodexStoredSessionRecord | null = null;
  let boundProviderSessionId: string | null = null;
  let promptState: TerminalWrapperPromptState = "prompt_dirty";
  let exiting = false;
  let shouldExit = false;
  let mode: WrapperMode = "local_native";
  let localTerminal: NativeTerminalProcess | null = null;
  let localExitCode = 0;
  let localExitSignal: string | null = null;
  let pendingRemoteTurn: QueuedTurn | null = null;
  let remoteKeyboardHandler: ((chunk: Buffer | string) => void) | null = null;
  let remotePromptText: string | null = null;
  let lastRenderedRemotePanel: string | null = null;
  let remoteReclaimRequested = false;
  let remotePanelActive = false;
  let historyCursorPrimed = parsed.resumeProviderSessionId === undefined;
  let controlClient: CodexJsonRpcClient | null = null;
  let currentTurnId: string | null = null;
  let bindingDetectionSinceMs = startupTimestampMs;
  let socketErrored = false;
  let remoteTurnRequestInFlight = false;
  let remoteTurnCancelRequested = false;
  let remoteInterruptSubmittedForTurnId: string | null = null;
  let remoteInterruptAttemptCount = 0;
  let webFirstBootstrapInFlight = false;
  let webFirstBootstrapCancelRequested = false;
  const pendingApprovals = new Map<
    string,
    {
      kind: "question" | "approval";
      resolve: (value: unknown) => void;
      approvalProtocol?: "v2" | "legacy";
    }
  >();

  const binary = await resolveCodexBinary();
  const socket = new WebSocket(wrapperControlUrl(parsed.daemonUrl));

  const send = (message: unknown) => {
    socket.send(JSON.stringify(message));
  };

  const ensureRemotePanelScreen = () => {
    if (remotePanelActive) {
      return;
    }
    enterAlternateScreen();
    remotePanelActive = true;
  };

  const restoreMainTerminalScreen = () => {
    if (!remotePanelActive) {
      return;
    }
    leaveAlternateScreen();
    remotePanelActive = false;
  };

  const getRemoteControlState = () =>
    deriveTerminalWrapperRemoteControlState({
      providerLabel: "Codex",
      hasPendingTurn: pendingRemoteTurn !== null,
      hasActiveTurn: currentTurnId !== null || remoteTurnRequestInFlight,
      promptState,
      cancelRequested: remoteTurnCancelRequested,
      reclaimRequested: remoteReclaimRequested,
    });

  const renderRemoteModePanel = () => {
    if (!isRemoteWriterMode(mode) || exiting) {
      lastRenderedRemotePanel = null;
      return;
    }
    const question = remotePromptText ?? pendingRemoteTurn?.text ?? "";
    const remoteControl = getRemoteControlState();
    const panel = renderTerminalWrapperPanel({
      title: "RAH Codex Remote Control",
      status: remoteControl.status,
      statusTone: remoteControl.tone,
      sessionId: boundProviderSessionId ?? "Pending session binding",
      prompt: question || "No active web prompt.",
      footer: remoteControl.footer,
      footerTone: remoteControl.tone,
    });
    if (panel === lastRenderedRemotePanel) {
      return;
    }
    lastRenderedRemotePanel = panel;
    ensureRemotePanelScreen();
    clearTerminalScreen();
    process.stdout.write(
      `${renderTerminalWrapperPanelForTerminal({
        title: "RAH Codex Remote Control",
        status: remoteControl.status,
        statusTone: remoteControl.tone,
        sessionId: boundProviderSessionId ?? "Pending session binding",
        prompt: question || "No active web prompt.",
        footer: remoteControl.footer,
        footerTone: remoteControl.tone,
      })}\r\n`,
    );
  };

  const updatePromptState = (nextState: TerminalWrapperPromptState) => {
    if (!wrapperSessionId || nextState === promptState) {
      return;
    }
    promptState = nextState;
    send({
      type: "wrapper.prompt_state.changed",
      sessionId: wrapperSessionId,
      state: promptState,
    });
  };

  const primeResumeHistoryCursor = (record: CodexStoredSessionRecord) => {
    if (historyCursorPrimed || parsed.resumeProviderSessionId === undefined) {
      return;
    }
    try {
      const content = readFileSync(record.rolloutPath, "utf8");
      processedLineCount = sliceUnprocessedRolloutLines(content, 0).nextProcessedLineCount;
      historyCursorPrimed = true;
      logger.log(
        `[rah] primed resume history cursor at line ${processedLineCount} for ${parsed.resumeProviderSessionId}`,
      );
    } catch (error) {
      logger.log(
        `[rah] failed to prime resume history cursor for ${parsed.resumeProviderSessionId}: ${String(error)}`,
      );
    }
  };

  const finishRemoteCancel = (turnId: string) => {
    remoteTurnCancelRequested = false;
    remoteInterruptSubmittedForTurnId = null;
    remoteInterruptAttemptCount = 0;
    currentTurnId = null;
    remoteTurnRequestInFlight = false;
    updatePromptState("prompt_clean");
    send({
      type: "wrapper.activity",
      sessionId: wrapperSessionId!,
      activity: {
        type: "turn_canceled",
        turnId,
        reason: "interrupted",
      },
    });
    renderRemoteModePanel();
    if (isRemoteWriterMode(mode)) {
      if (remoteReclaimRequested) {
        startLocalNative();
      } else {
        enableRemoteKeyboardControl();
      }
    }
  };

  const submitRemoteInterrupt = (turnId: string) => {
    if (!controlClient || !boundProviderSessionId || remoteInterruptSubmittedForTurnId === turnId) {
      return;
    }
    if (remoteInterruptAttemptCount >= CODEX_APP_SERVER_INTERRUPT_MAX_ATTEMPTS) {
      logger.log(`[rah] remote interrupt attempts exhausted for turn ${turnId}`);
      return;
    }
    remoteInterruptSubmittedForTurnId = turnId;
    remoteInterruptAttemptCount += 1;
    void controlClient
      .request(
        "turn/interrupt",
        {
          threadId: boundProviderSessionId,
          turnId,
        },
        CODEX_APP_SERVER_INTERRUPT_TIMEOUT_MS,
      )
      .catch((error) => {
        logger.log(`[rah] remote interrupt failed: ${String(error)}`);
        if (remoteTurnCancelRequested && remoteInterruptSubmittedForTurnId === turnId) {
          remoteInterruptSubmittedForTurnId = null;
          if (remoteInterruptAttemptCount < CODEX_APP_SERVER_INTERRUPT_MAX_ATTEMPTS) {
            globalThis.setTimeout(() => {
              if (remoteTurnCancelRequested && currentTurnId === turnId) {
                submitRemoteInterrupt(turnId);
              }
            }, 500);
          }
        }
      });
  };

  const mirrorControlActivity = (activity: ProviderActivity) => {
    if (!wrapperSessionId || !shouldMirrorControlActivity(activity)) {
      return;
    }
    if (remoteTurnCancelRequested) {
      if (activity.type === "turn_started") {
        currentTurnId = activity.turnId;
        remoteTurnRequestInFlight = false;
        updatePromptState("agent_busy");
        submitRemoteInterrupt(activity.turnId);
        renderRemoteModePanel();
        return;
      }
      if (
        activity.type === "turn_completed" ||
        activity.type === "turn_failed" ||
        activity.type === "turn_canceled"
      ) {
        finishRemoteCancel(activity.turnId);
        return;
      }
      return;
    }
    send({
      type: "wrapper.activity",
      sessionId: wrapperSessionId,
      activity,
    });
    const nextPromptState = nextPromptStateFromActivity(promptState, activity);
    updatePromptState(nextPromptState);
    if (activity.type === "turn_started") {
      currentTurnId = activity.turnId;
      remoteTurnRequestInFlight = false;
    } else if (
      activity.type === "turn_completed" ||
      activity.type === "turn_failed" ||
      activity.type === "turn_canceled"
    ) {
      currentTurnId = null;
      remoteTurnRequestInFlight = false;
      renderRemoteModePanel();
      if (isRemoteWriterMode(mode)) {
        if (remoteReclaimRequested) {
          startLocalNative();
        } else {
          enableRemoteKeyboardControl();
        }
      }
    } else if (activity.type === "session_failed" || activity.type === "session_exited") {
      remoteTurnRequestInFlight = false;
      renderRemoteModePanel();
    }
  };

  const ensureControlClient = async (args?: { skipBoundResume?: boolean }) => {
    if (controlClient) {
      return controlClient;
    }
    controlClient = await createCodexAppServerClient();
    controlClient.setNotificationHandler((notification) => {
      const translated = translateCodexAppServerNotification(
        notification,
        controlTranslationState,
      );
      for (const item of translated) {
        mirrorControlActivity(item.activity);
      }
    });
    controlClient.setRequestHandler((request) => {
      if (
        request.method === "item/tool/requestUserInput" ||
        request.method === "tool/requestUserInput"
      ) {
        const params =
          request.params && typeof request.params === "object" && !Array.isArray(request.params)
            ? (request.params as Record<string, unknown>)
            : {};
        const itemId = typeof params.itemId === "string" ? params.itemId : `question-${request.id}`;
        const permissionRequestId = makeQuestionPermissionRequestId(itemId);
        const activities = mapCodexQuestionRequestToActivities({
          itemId,
          questions: params.questions,
        });
        for (const item of activities) {
          mirrorControlActivity(item.activity);
        }
        return new Promise((resolve) => {
          pendingApprovals.set(permissionRequestId, {
            kind: "question",
            resolve,
          });
        });
      }

      if (
        request.method === "item/commandExecution/requestApproval" ||
        request.method === "item/fileChange/requestApproval" ||
        request.method === "item/permissions/requestApproval" ||
        request.method === "execCommandApproval" ||
        request.method === "applyPatchApproval" ||
        request.method === "mcpServer/elicitation/request"
      ) {
        const params =
          request.params && typeof request.params === "object" && !Array.isArray(request.params)
            ? (request.params as Record<string, unknown>)
            : {};
        const requestId =
          request.method === "mcpServer/elicitation/request"
            ? `permission-mcp-${request.id}`
            : `permission-${typeof params.itemId === "string" ? params.itemId : `approval-${request.id}`}`;
        const title =
          request.method === "item/fileChange/requestApproval" ||
          request.method === "applyPatchApproval"
            ? "Apply file changes"
            : request.method === "item/permissions/requestApproval"
              ? "Grant additional permissions"
              : request.method === "mcpServer/elicitation/request"
                ? "MCP elicitation"
                : "Run command";
        mirrorControlActivity({
          type: "permission_requested",
          ...(currentTurnId ? { turnId: currentTurnId } : {}),
          request: makeWrapperPermissionRequest(requestId, title, params),
        });
        return new Promise((resolve) => {
          pendingApprovals.set(requestId, {
            kind: "approval",
            resolve,
            approvalProtocol:
              request.method === "execCommandApproval" ||
              request.method === "applyPatchApproval"
                ? "legacy"
                : "v2",
          });
        });
      }

      return {};
    });
    if (boundProviderSessionId && !args?.skipBoundResume) {
      await controlClient.request(
        "thread/resume",
        { threadId: boundProviderSessionId },
        CODEX_APP_SERVER_REQUEST_TIMEOUT_MS,
      );
    }
    return controlClient;
  };

  const syncProviderBinding = async (args: {
    providerSessionId: string;
    reason: "initial" | "switch";
    record?: CodexStoredSessionRecord | null;
    providerTitle?: string;
    providerPreview?: string;
    skipResume?: boolean;
  }) => {
    if (!wrapperSessionId) {
      return;
    }
    const sameProviderSession = boundProviderSessionId === args.providerSessionId;
    const nextRecord =
      args.record ??
      (boundRecord?.ref.providerSessionId === args.providerSessionId ? boundRecord : null);
    const metadataChanged =
      sameProviderSession &&
      nextRecord !== null &&
      (boundRecord?.rolloutPath !== nextRecord.rolloutPath ||
        boundRecord?.ref.title !== nextRecord.ref.title ||
        boundRecord?.ref.preview !== nextRecord.ref.preview);
    if (sameProviderSession && !metadataChanged) {
      return;
    }
    boundProviderSessionId = args.providerSessionId;
    boundRecord = nextRecord;
    bindingDetectionSinceMs = Date.now();
    processedLineCount = 0;
    translationState = createCodexRolloutTranslationState();
    currentTurnId = null;
    if (nextRecord) {
      primeResumeHistoryCursor(nextRecord);
    }
    logger.log(`[rah] bound provider session: ${args.providerSessionId}`);
    send({
      type: "wrapper.provider_bound",
      sessionId: wrapperSessionId,
      providerSessionId: args.providerSessionId,
      ...(boundRecord?.ref.title
        ? { providerTitle: boundRecord.ref.title }
        : args.providerTitle
          ? { providerTitle: args.providerTitle }
          : { providerTitle: args.providerSessionId }),
      ...(boundRecord?.ref.preview
        ? { providerPreview: boundRecord.ref.preview }
        : args.providerPreview
          ? { providerPreview: args.providerPreview }
          : { providerPreview: args.providerSessionId }),
      reason: args.reason,
    });
    const client = await ensureControlClient({ skipBoundResume: true });
    if (!sameProviderSession && !args.skipResume) {
      await client.request(
        "thread/resume",
        { threadId: args.providerSessionId },
        CODEX_APP_SERVER_REQUEST_TIMEOUT_MS,
      );
    }
  };

  const disableRemoteKeyboardControl = () => {
    if (remoteKeyboardHandler) {
      process.stdin.off("data", remoteKeyboardHandler);
      remoteKeyboardHandler = null;
    }
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
  };

  let localExitForHandoff = false;

  const selectProviderBindingCandidate = (): CodexStoredSessionRecord | null => {
    const records = discoverCodexStoredSessions();
    return selectCodexStoredSessionCandidate({
      records,
      cwd: parsed.cwd,
      startupTimestampMs,
      ...(parsed.resumeProviderSessionId && !boundRecord
        ? { resumeProviderSessionId: parsed.resumeProviderSessionId }
        : {}),
      ...(parsed.resumeProviderSessionId && !boundRecord
        ? {}
        : { updatedAfterMs: bindingDetectionSinceMs }),
    });
  };

  const notifyWrapper = (activity: ProviderActivity) => {
    if (!wrapperSessionId) {
      return;
    }
    send({
      type: "wrapper.activity",
      sessionId: wrapperSessionId,
      activity,
    });
  };

  const bootstrapWebFirstSession = async () => {
    if (boundProviderSessionId) {
      mode = "remote_writer";
      void maybeStartPendingRemoteTurn();
      return;
    }
    if (webFirstBootstrapInFlight) {
      return;
    }
    webFirstBootstrapInFlight = true;
    webFirstBootstrapCancelRequested = false;

    try {
      const existingCandidate = selectProviderBindingCandidate();
      if (existingCandidate) {
        await syncProviderBinding({
          providerSessionId: existingCandidate.ref.providerSessionId,
          reason: boundProviderSessionId ? "switch" : "initial",
          record: existingCandidate,
        });
        return;
      }

      mode = "remote_writer";
      remoteReclaimRequested = false;
      updatePromptState("agent_busy");
      renderRemoteModePanel();

      const terminalToClose = localTerminal;
      if (terminalToClose) {
        localExitForHandoff = true;
        await terminalToClose.close("SIGTERM").catch((error) => {
          logger.log(`[rah] failed to stop local Codex before web-first bootstrap: ${String(error)}`);
        });
      }

      if (webFirstBootstrapCancelRequested) {
        logger.log("[rah] web-first Codex bootstrap canceled before thread creation");
        pendingRemoteTurn = null;
        remotePromptText = null;
        remoteTurnRequestInFlight = false;
        remoteTurnCancelRequested = false;
        remoteInterruptSubmittedForTurnId = null;
        remoteInterruptAttemptCount = 0;
        updatePromptState("prompt_clean");
        startLocalNative();
        return;
      }

      const candidateAfterLocalStop = selectProviderBindingCandidate();
      if (candidateAfterLocalStop) {
        await syncProviderBinding({
          providerSessionId: candidateAfterLocalStop.ref.providerSessionId,
          reason: boundProviderSessionId ? "switch" : "initial",
          record: candidateAfterLocalStop,
        });
        return;
      }

      const client = await ensureControlClient();
      const threadStart = await client.request(
        "thread/start",
        {
          cwd: parsed.cwd,
          approvalPolicy: "never",
          sandbox: "danger-full-access",
          experimentalRawEvents: false,
          persistExtendedHistory: true,
        },
        CODEX_APP_SERVER_REQUEST_TIMEOUT_MS,
      );
      const thread = readThreadStartResponse(threadStart);
      logger.log(`[rah] web-first Codex thread started: ${thread.threadId}`);
      const wasCanceled = webFirstBootstrapCancelRequested;
      await syncProviderBinding({
        providerSessionId: thread.threadId,
        reason: "initial",
        record: null,
        ...(thread.title !== undefined ? { providerTitle: thread.title } : {}),
        ...(thread.preview !== undefined ? { providerPreview: thread.preview } : {}),
        skipResume: true,
      });
      if (wasCanceled) {
        logger.log("[rah] web-first Codex bootstrap completed after cancellation; leaving turn idle");
        pendingRemoteTurn = null;
        remotePromptText = null;
        remoteTurnRequestInFlight = false;
        remoteTurnCancelRequested = false;
        remoteInterruptSubmittedForTurnId = null;
        remoteInterruptAttemptCount = 0;
        updatePromptState("prompt_clean");
        renderRemoteModePanel();
        enableRemoteKeyboardControl();
        return;
      }
      mode = "remote_writer";
      void maybeStartPendingRemoteTurn();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (webFirstBootstrapCancelRequested) {
        logger.log(`[rah] web-first Codex bootstrap canceled: ${message}`);
        pendingRemoteTurn = null;
        remotePromptText = null;
        remoteTurnRequestInFlight = false;
        remoteTurnCancelRequested = false;
        remoteInterruptSubmittedForTurnId = null;
        remoteInterruptAttemptCount = 0;
        updatePromptState("prompt_clean");
        if (!exiting && !boundProviderSessionId && !localTerminal) {
          startLocalNative();
        } else {
          renderRemoteModePanel();
          enableRemoteKeyboardControl();
        }
        return;
      }
      logger.log(`[rah] web-first Codex bootstrap failed: ${message}`);
      pendingRemoteTurn = null;
      remoteTurnRequestInFlight = false;
      updatePromptState("prompt_clean");
      renderRemoteModePanel();
      notifyWrapper({
        type: "notification",
        level: "critical",
        title: "Codex web-first start failed",
        body: message,
      });
      if (!exiting && !boundProviderSessionId && !localTerminal) {
        startLocalNative();
      }
    } finally {
      webFirstBootstrapInFlight = false;
      webFirstBootstrapCancelRequested = false;
    }
  };

  const maybeStartPendingRemoteTurn = async () => {
    if (
      exiting ||
      !isRemoteWriterMode(mode) ||
      remoteTurnCancelRequested ||
      !pendingRemoteTurn ||
      !boundProviderSessionId ||
      remoteTurnRequestInFlight ||
      currentTurnId
    ) {
      return;
    }
    const turn = pendingRemoteTurn;
    pendingRemoteTurn = null;
    remotePromptText = turn.text;
    remoteTurnRequestInFlight = true;
    remoteInterruptSubmittedForTurnId = null;
    remoteInterruptAttemptCount = 0;
    updatePromptState("agent_busy");
    renderRemoteModePanel();
    enableRemoteKeyboardControl();
    try {
      const client = await ensureControlClient();
      void client
        .request("turn/start", {
          threadId: boundProviderSessionId,
          input: [{ type: "text", text: turn.text }],
        })
        .then((response) => {
          const { turnId } = readTurnStartResponse(response);
          remoteTurnRequestInFlight = false;
          if (turnId) {
            currentTurnId = currentTurnId ?? turnId;
            if (remoteTurnCancelRequested) {
              submitRemoteInterrupt(turnId);
              renderRemoteModePanel();
            }
          }
        })
        .catch((error) => {
          if (remoteTurnCancelRequested) {
            logger.log(`[rah] remote turn start canceled: ${String(error)}`);
            remoteTurnRequestInFlight = false;
            if (currentTurnId) {
              submitRemoteInterrupt(currentTurnId);
              updatePromptState("agent_busy");
            } else if (String(error).includes("timed out")) {
              updatePromptState("agent_busy");
            } else {
              remoteTurnCancelRequested = false;
              remoteInterruptSubmittedForTurnId = null;
              remoteInterruptAttemptCount = 0;
              updatePromptState("prompt_clean");
            }
            renderRemoteModePanel();
            enableRemoteKeyboardControl();
            return;
          }
          logger.log(`[rah] remote turn start failed: ${String(error)}`);
          remoteTurnRequestInFlight = false;
          updatePromptState("prompt_clean");
          renderRemoteModePanel();
          if (wrapperSessionId) {
            send({
              type: "wrapper.activity",
              sessionId: wrapperSessionId,
              activity: {
                type: "notification",
                level: "critical",
                title: "Codex remote turn failed",
                body: error instanceof Error ? error.message : String(error),
              },
            });
          }
          enableRemoteKeyboardControl();
        });
    } catch (error) {
      logger.log(`[rah] remote writer unavailable: ${String(error)}`);
      remoteTurnRequestInFlight = false;
      updatePromptState("prompt_clean");
      renderRemoteModePanel();
      enableRemoteKeyboardControl();
    }
  };

  const startLocalNative = () => {
    disableRemoteKeyboardControl();
    mode = "local_native";
    remotePromptText = null;
    lastRenderedRemotePanel = null;
    remoteReclaimRequested = false;
    remoteTurnRequestInFlight = false;
    updatePromptState("prompt_clean");
    restoreMainTerminalScreen();
    const codexArgs = boundProviderSessionId
      ? ["resume", boundProviderSessionId]
      : parsed.resumeProviderSessionId
        ? ["resume", parsed.resumeProviderSessionId]
        : [];
    const fullAutoCodexArgs = ["--dangerously-bypass-approvals-and-sandbox", ...codexArgs];
    localTerminal = new NativeTerminalProcess({
      cwd: parsed.cwd,
      command: binary,
      args: fullAutoCodexArgs,
      env: {
        CODEX_HOME: process.env.CODEX_HOME ?? sharedCodexHome,
      },
      onExit: ({ exitCode, signal }) => {
        restoreInheritedTerminalModes();
        localTerminal = null;
        if (localExitForHandoff) {
          localExitForHandoff = false;
        } else {
          localExitCode = exitCode ?? 0;
          localExitSignal = signal ?? null;
        }
        if (exiting) {
          shouldExit = true;
          return;
        }
        if (pendingRemoteTurn) {
          mode = "remote_writer";
          void maybeStartPendingRemoteTurn();
          return;
        }
        shouldExit = true;
      },
    });
    logger.log(`[rah] local native codex started (${fullAutoCodexArgs.join(" ") || "new"})`);
  };

  const enableRemoteKeyboardControl = () => {
    if (remoteKeyboardHandler || exiting || !isRemoteWriterMode(mode)) {
      return;
    }
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    remoteKeyboardHandler = (chunk: Buffer | string) => {
      const data = chunk.toString();
      if (data === "\u0003") {
        logger.log("[rah] Ctrl+C pressed in remote handoff panel; exiting wrapper");
        localExitCode = 130;
        void cleanupAndExit().finally(() => {
          shouldExit = true;
        });
        return;
      }
      if (data === "\u001b") {
        if (!getRemoteControlState().controlAvailable) {
          remoteReclaimRequested = true;
          logger.log("[rah] local control reclaim requested; waiting for remote turn to finish");
          renderRemoteModePanel();
          return;
        }
        logger.log("[rah] local control reclaimed from terminal");
        startLocalNative();
      }
    };
    process.stdin.on("data", remoteKeyboardHandler);
    renderRemoteModePanel();
  };

  const cleanupAndExit = async () => {
    if (exiting) {
      return;
    }
    exiting = true;
    disableRemoteKeyboardControl();
    restoreMainTerminalScreen();
    if (localTerminal) {
      await localTerminal.close("SIGTERM").catch(() => undefined);
      localTerminal = null;
    }
    restoreInheritedTerminalModes();
    await controlClient?.dispose().catch(() => undefined);
    controlClient = null;
    if (wrapperSessionId) {
      send({
        type: "wrapper.exited",
        sessionId: wrapperSessionId,
        ...(localExitCode !== undefined ? { exitCode: localExitCode } : {}),
        ...(localExitSignal ? { signal: localExitSignal } : {}),
      });
    }
    socket.close();
  };

  socket.on("open", () => {
    logger.log("[rah] wrapper control connected");
    send({
      type: "wrapper.hello",
      provider: "codex",
      cwd: parsed.cwd,
      rootDir: parsed.cwd,
      terminalPid: process.pid,
      launchCommand: [
        "rah",
        "codex",
        ...(parsed.resumeProviderSessionId ? ["resume", parsed.resumeProviderSessionId] : []),
      ],
      ...(parsed.resumeProviderSessionId
        ? { resumeProviderSessionId: parsed.resumeProviderSessionId }
        : {}),
    });
  });

  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString("utf8"));
    if (message.type === "wrapper.ready") {
      wrapperSessionId = message.sessionId;
      logger.log(`[rah] terminal session registered: ${message.sessionId}`);
      if (parsed.resumeProviderSessionId) {
        void syncProviderBinding({
          providerSessionId: parsed.resumeProviderSessionId,
          reason: "initial",
        });
      } else {
        updatePromptState("prompt_clean");
      }
      return;
    }
    if (message.type === "turn.inject") {
      if (!boundProviderSessionId && webFirstBootstrapInFlight && pendingRemoteTurn) {
        logger.log("[rah] ignoring additional web-first remote turn while bootstrap is in flight");
        return;
      }
      pendingRemoteTurn = message.queuedTurn;
      if (!boundProviderSessionId) {
        logger.log("[rah] starting web-first Codex bootstrap");
        void bootstrapWebFirstSession();
        return;
      }
      if (mode === "local_native" && localTerminal) {
        localExitForHandoff = true;
        updatePromptState("agent_busy");
        void localTerminal.close("SIGTERM");
        return;
      }
      mode = "remote_writer";
      void maybeStartPendingRemoteTurn();
      return;
    }
    if (message.type === "turn.enqueue") {
      logger.log(`[rah] remote turn queued: ${message.queuedTurn.text}`);
      return;
    }
    if (message.type === "turn.interrupt") {
      if (webFirstBootstrapInFlight && !boundProviderSessionId) {
        logger.log("[rah] canceling web-first Codex bootstrap before provider binding");
        webFirstBootstrapCancelRequested = true;
        remoteTurnCancelRequested = true;
        pendingRemoteTurn = null;
        remotePromptText = null;
        remoteTurnRequestInFlight = false;
        updatePromptState("agent_busy");
        renderRemoteModePanel();
        enableRemoteKeyboardControl();
        return;
      }
      if (mode === "local_native") {
        logger.log("[rah] ignoring remote interrupt while terminal holds local control");
        return;
      }
      if (pendingRemoteTurn && !currentTurnId && !remoteTurnRequestInFlight) {
        logger.log("[rah] canceling queued remote turn before it started");
        pendingRemoteTurn = null;
        remotePromptText = null;
        remoteTurnCancelRequested = false;
        remoteInterruptSubmittedForTurnId = null;
        remoteInterruptAttemptCount = 0;
        updatePromptState("prompt_clean");
        renderRemoteModePanel();
        enableRemoteKeyboardControl();
        return;
      }
      if (remoteTurnRequestInFlight || currentTurnId || promptState === "agent_busy") {
        logger.log("[rah] requesting remote Codex turn interrupt");
        pendingRemoteTurn = null;
        remoteTurnCancelRequested = true;
        updatePromptState("agent_busy");
        if (currentTurnId) {
          submitRemoteInterrupt(currentTurnId);
        }
        renderRemoteModePanel();
        enableRemoteKeyboardControl();
        return;
      }
      logger.log("[rah] ignoring remote interrupt because no remote Codex turn is running");
      return;
    }
    if (message.type === "permission.resolve") {
      const pending = pendingApprovals.get(message.requestId);
      if (!pending) {
        logger.log(`[rah] unknown remote permission resolution: ${message.requestId}`);
        return;
      }
      pendingApprovals.delete(message.requestId);
      mirrorControlActivity(
        mapCodexPermissionResolution({
          requestId: message.requestId,
          behavior: message.response.behavior,
          ...(message.response.message !== undefined ? { message: message.response.message } : {}),
          ...(message.response.selectedActionId !== undefined
            ? { selectedActionId: message.response.selectedActionId }
            : {}),
          ...(message.response.decision !== undefined ? { decision: message.response.decision } : {}),
          ...(message.response.answers !== undefined ? { answers: message.response.answers } : {}),
        }).activity,
      );
      if (pending.kind === "question") {
        pending.resolve({ answers: message.response.answers ?? {} });
      } else {
        pending.resolve({
          decision: resolveApprovalDecision(message.response, pending.approvalProtocol ?? "v2"),
        });
      }
      return;
    }
    if (message.type === "wrapper.close") {
      void cleanupAndExit();
    }
  });

  socket.on("error", () => {
    if (socketErrored) {
      return;
    }
    socketErrored = true;
    process.stderr.write(
      `[rah] could not connect to RAH daemon at ${parsed.daemonUrl}. Start the daemon and try again.\n`,
    );
    void cleanupAndExit().finally(() => {
      process.exitCode = 1;
    });
  });

  socket.on("close", () => {
    if (socketErrored || exiting || shouldExit) {
      return;
    }
    logger.log("[rah] wrapper control channel closed");
    process.exitCode = 1;
  });

  process.on("SIGINT", () => {
    if (!exiting) {
      void cleanupAndExit();
    }
  });
  process.on("SIGTERM", () => {
    if (!exiting) {
      void cleanupAndExit();
    }
  });

  startLocalNative();

  while (!shouldExit && !exiting) {
    if (wrapperSessionId) {
      const candidate = selectProviderBindingCandidate();
      if (candidate) {
        await syncProviderBinding({
          providerSessionId: candidate.ref.providerSessionId,
          reason: boundProviderSessionId ? "switch" : "initial",
          record: candidate,
        });
      }
    }

    const activeBoundRecord: CodexStoredSessionRecord | null = boundRecord;
    if (!wrapperSessionId || !activeBoundRecord || boundProviderSessionId === null) {
      // Continue below.
    } else {
      const activeRecord = activeBoundRecord as CodexStoredSessionRecord;
      if (activeRecord.ref.providerSessionId !== boundProviderSessionId) {
        await delay(250);
        continue;
      }
      const content = readFileSync(activeRecord.rolloutPath, "utf8");
      const window = sliceUnprocessedRolloutLines(content, processedLineCount);
      processedLineCount = window.nextProcessedLineCount;
      for (const line of window.lines) {
        let parsedLine: unknown;
        try {
          parsedLine = JSON.parse(line);
        } catch {
          continue;
        }
        const lifecycle = readPersistedTaskLifecycle(parsedLine);
        if (lifecycle?.kind === "started") {
          currentTurnId = lifecycle.turnId;
          remoteTurnRequestInFlight = false;
          updatePromptState("agent_busy");
          renderRemoteModePanel();
        } else if (lifecycle?.kind === "completed" || lifecycle?.kind === "canceled") {
          if (currentTurnId && currentTurnId !== lifecycle.turnId) {
            continue;
          }
          if (lifecycle.kind === "canceled" && remoteTurnCancelRequested) {
            finishRemoteCancel(lifecycle.turnId);
            continue;
          }
          currentTurnId = null;
          remoteTurnRequestInFlight = false;
          remoteTurnCancelRequested = false;
          remoteInterruptSubmittedForTurnId = null;
          remoteInterruptAttemptCount = 0;
          updatePromptState("prompt_clean");
          renderRemoteModePanel();
          if (isRemoteWriterMode(mode)) {
            if (remoteReclaimRequested) {
              startLocalNative();
            } else {
              enableRemoteKeyboardControl();
            }
          }
        }
        const translated = translateCodexRolloutLine(parsedLine, translationState);
        for (const item of translated) {
          send({
            type: "wrapper.activity",
            sessionId: wrapperSessionId,
            activity: item.activity,
          });
          if (item.activity.type === "turn_started") {
            currentTurnId = item.activity.turnId;
            remoteTurnRequestInFlight = false;
          } else if (
            item.activity.type === "turn_completed" ||
            item.activity.type === "turn_failed" ||
            item.activity.type === "turn_canceled"
          ) {
            if (remoteTurnCancelRequested && item.activity.type === "turn_canceled") {
              finishRemoteCancel(item.activity.turnId);
              continue;
            }
            currentTurnId = null;
            remoteTurnRequestInFlight = false;
            remoteTurnCancelRequested = false;
            remoteInterruptSubmittedForTurnId = null;
            remoteInterruptAttemptCount = 0;
            updatePromptState("prompt_clean");
            renderRemoteModePanel();
            if (isRemoteWriterMode(mode)) {
              if (remoteReclaimRequested) {
                startLocalNative();
              } else {
                enableRemoteKeyboardControl();
              }
            }
          }
          const nextPromptState = nextPromptStateFromActivity(promptState, item.activity);
          updatePromptState(nextPromptState);
        }
      }
    }

    const terminalToHandoff: NativeTerminalProcess | null = localTerminal;
    if (
      pendingRemoteTurn &&
      mode === "local_native" &&
      terminalToHandoff !== null &&
      boundProviderSessionId &&
      currentTurnId === null
    ) {
      localExitForHandoff = true;
      updatePromptState("agent_busy");
      void (terminalToHandoff as NativeTerminalProcess).close("SIGTERM");
    }

    if (isRemoteWriterMode(mode) && pendingRemoteTurn) {
      void maybeStartPendingRemoteTurn();
    }

    await delay(250);
  }

  logger.log("[rah] codex terminal handoff wrapper exiting");
  await cleanupAndExit();
  process.exitCode = localExitCode;
}

void main().catch((error) => {
  process.stderr.write(`[rah] ${error instanceof Error ? error.message : String(error)}\n`);
  restoreInheritedTerminalModes();
  process.exitCode = 1;
});
