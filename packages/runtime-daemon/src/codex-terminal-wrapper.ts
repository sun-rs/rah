import { readFileSync } from "node:fs";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import {
  isPermissionSessionGrant,
  type PermissionRequest,
  type PermissionResponseRequest,
} from "@rah/runtime-protocol";
import type { TerminalWrapperPromptState } from "./terminal-wrapper-control";
import {
  discoverCodexStoredSessions,
  type CodexStoredSessionRecord,
} from "./codex-stored-sessions";
import { type ProviderActivity } from "./provider-activity";
import {
  createCodexRolloutTranslationState,
  translateCodexRolloutLine,
  type CodexRolloutTranslationState,
} from "./codex-rollout-activity";
import {
  CodexJsonRpcClient,
  createCodexAppServerClient,
} from "./codex-live-client";
import {
  createCodexAppServerTranslationState,
  mapCodexPermissionResolution,
  mapCodexQuestionRequestToActivities,
  translateCodexAppServerNotification,
} from "./codex-app-server-activity";
import {
  applyLocalTerminalInput,
  extractCodexTerminalSessionId,
  hasCodexTerminalPrompt,
  nextPromptStateFromActivity,
  selectCodexStoredSessionCandidate,
  sliceUnprocessedRolloutLines,
} from "./codex-terminal-wrapper-bridge";
import {
  createIsolatedCodexWrapperHome,
  resolveCodexBaseHome,
} from "./codex-wrapper-home";
import { IndependentTerminalProcess } from "./independent-terminal";

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
  return process.env.RAH_CODEX_BINARY ?? "codex";
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

async function injectRemoteTurnIntoTerminal(
  terminal: IndependentTerminalProcess,
  text: string,
): Promise<void> {
  terminal.write(text);
  await delay(25);
  terminal.write("\r\n");
}

async function disposeControlClient(client: CodexJsonRpcClient | null): Promise<void> {
  if (client !== null) {
    await client.dispose().catch(() => undefined);
  }
}

function readPersistedTaskLifecycle(line: unknown):
  | { kind: "started"; turnId: string }
  | { kind: "completed"; turnId: string }
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
  return null;
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const startupTimestampMs = Date.now();
  const sharedCodexHome = resolveCodexBaseHome();
  const wrapperCodexHome = parsed.resumeProviderSessionId
    ? null
    : createIsolatedCodexWrapperHome(sharedCodexHome);
  if (wrapperCodexHome) {
    process.env.CODEX_HOME = wrapperCodexHome;
    process.stderr.write(`[rah] isolated codex home: ${wrapperCodexHome}\n`);
  }
  let translationState: CodexRolloutTranslationState = createCodexRolloutTranslationState();
  const controlTranslationState = createCodexAppServerTranslationState();
  const localPromptTracker = { draftText: "" };
  let processedLineCount = 0;
  let wrapperSessionId: string | null = null;
  let boundRecord: CodexStoredSessionRecord | null = null;
  let boundProviderSessionId: string | null = null;
  let promptState: "prompt_clean" | "prompt_dirty" | "agent_busy" = "prompt_dirty";
  let exiting = false;
  let childExited = false;
  let childExitCode = 0;
  let childExitSignal: string | null = null;
  let controlClient: CodexJsonRpcClient | null = null;
  let controlThreadId: string | null = null;
  let currentTurnId: string | null = null;
  let awaitingTurnStart = false;
  let promptReadyTimer: NodeJS.Timeout | null = null;
  let bindingDetectionSinceMs = startupTimestampMs;
  let ptyStatusBuffer = "";
  const pendingApprovals = new Map<
    string,
    {
      kind: "question" | "approval";
      resolve: (value: unknown) => void;
      approvalProtocol?: "v2" | "legacy";
    }
  >();
  const binary = await resolveCodexBinary();
  const codexArgs = parsed.resumeProviderSessionId
    ? ["resume", parsed.resumeProviderSessionId]
    : [];

  const send = (message: unknown) => {
    socket.send(JSON.stringify(message));
  };

  const armPromptReadyTimer = (options?: { allowNoPrompt?: boolean; delayMs?: number }) => {
    if (
      !wrapperSessionId ||
      childExited ||
      awaitingTurnStart ||
      currentTurnId ||
      localPromptTracker.draftText.length > 0
    ) {
      return;
    }
    if (!options?.allowNoPrompt && !hasCodexTerminalPrompt(ptyStatusBuffer)) {
      return;
    }
    if (promptReadyTimer) {
      clearTimeout(promptReadyTimer);
    }
    promptReadyTimer = setTimeout(() => {
      promptReadyTimer = null;
      if (
        !childExited &&
        !awaitingTurnStart &&
        !currentTurnId &&
          localPromptTracker.draftText.length === 0
      ) {
        updatePromptState("prompt_clean");
      }
    }, options?.delayMs ?? 400);
    promptReadyTimer.unref();
  };

  const terminal = new IndependentTerminalProcess({
    cwd: parsed.cwd,
    command: binary,
    args: codexArgs,
    env: {
      CODEX_HOME: process.env.CODEX_HOME ?? sharedCodexHome,
    },
    ...(typeof process.stdout.columns === "number" ? { cols: process.stdout.columns } : {}),
    ...(typeof process.stdout.rows === "number" ? { rows: process.stdout.rows } : {}),
    onData: (data) => {
      process.stdout.write(data);
      if (wrapperSessionId) {
        send({
          type: "wrapper.pty.output",
          sessionId: wrapperSessionId,
          data,
        });
      }
      ptyStatusBuffer = `${ptyStatusBuffer}${data}`.slice(-8192);
      const statusSessionId = extractCodexTerminalSessionId(ptyStatusBuffer);
      if (statusSessionId) {
        const exactRecord =
          discoverCodexStoredSessions().find(
            (candidate) => candidate.ref.providerSessionId === statusSessionId,
          ) ?? null;
        void syncProviderBinding({
          providerSessionId: statusSessionId,
          reason: boundProviderSessionId ? "switch" : "initial",
          ...(exactRecord ? { record: exactRecord } : {}),
        });
      }
      if (
        wrapperSessionId &&
        hasCodexTerminalPrompt(ptyStatusBuffer) &&
        localPromptTracker.draftText.length === 0 &&
        currentTurnId === null
      ) {
        awaitingTurnStart = false;
        armPromptReadyTimer();
      } else if (
        wrapperSessionId &&
        !awaitingTurnStart &&
        !currentTurnId &&
        localPromptTracker.draftText.length === 0
      ) {
        armPromptReadyTimer();
      }
    },
    onExit: ({ exitCode, signal }) => {
      childExited = true;
      childExitCode = exitCode ?? 0;
      childExitSignal = signal ?? null;
    },
  });

  try {
    await terminal.waitUntilReady();
  } catch (error) {
    process.stderr.write(
      `[rah] failed to launch codex terminal: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const socket = new WebSocket(wrapperControlUrl(parsed.daemonUrl));

  function updatePromptState(nextState: TerminalWrapperPromptState) {
    if (!wrapperSessionId || nextState === promptState) {
      return;
    }
    if (nextState === "prompt_clean") {
      localPromptTracker.draftText = "";
    }
    promptState = nextState;
    send({
      type: "wrapper.prompt_state.changed",
      sessionId: wrapperSessionId,
      state: promptState,
    });
  }

  const mirrorControlActivity = (activity: ProviderActivity) => {
    if (!wrapperSessionId || !shouldMirrorControlActivity(activity)) {
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
      awaitingTurnStart = false;
    } else if (
      activity.type === "turn_completed" ||
      activity.type === "turn_failed" ||
      activity.type === "turn_canceled"
    ) {
      currentTurnId = null;
      awaitingTurnStart = false;
    } else if (activity.type === "session_failed" || activity.type === "session_exited") {
      awaitingTurnStart = false;
    }
    if (
      activity.type === "turn_completed" ||
      activity.type === "turn_failed" ||
      activity.type === "turn_canceled" ||
      activity.type === "session_failed" ||
      activity.type === "session_exited"
    ) {
      armPromptReadyTimer();
    }
  };

  const ensureControlClient = async () => {
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
    return controlClient;
  };

  const syncProviderBinding = async (args: {
    providerSessionId: string;
    reason: "initial" | "switch";
    record?: CodexStoredSessionRecord | null;
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
    awaitingTurnStart = false;
    process.stderr.write(
      `[rah] bound provider session: ${args.providerSessionId}\n`,
    );
    send({
      type: "wrapper.provider_bound",
      sessionId: wrapperSessionId,
      providerSessionId: args.providerSessionId,
      ...(boundRecord?.ref.title
        ? { providerTitle: boundRecord.ref.title }
        : { providerTitle: args.providerSessionId }),
      ...(boundRecord?.ref.preview
        ? { providerPreview: boundRecord.ref.preview }
        : { providerPreview: args.providerSessionId }),
      reason: args.reason,
    });
    const client = await ensureControlClient();
    controlThreadId = args.providerSessionId;
    if (!sameProviderSession) {
      await client.request(
        "thread/resume",
        { threadId: args.providerSessionId },
        90_000,
      );
    }
  };

  const onTerminalInput = (chunk: Buffer | string) => {
    const data = chunk.toString();
    terminal.write(data);
    const nextPromptState = applyLocalTerminalInput({
      tracker: localPromptTracker,
      promptState,
      data,
    });
    if (nextPromptState === "agent_busy") {
      awaitingTurnStart = true;
      if (promptReadyTimer) {
        clearTimeout(promptReadyTimer);
        promptReadyTimer = null;
      }
    }
    updatePromptState(nextPromptState);
  };

  process.stdin.setEncoding("utf8");
  process.stdin.resume();
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.on("data", onTerminalInput);

  const onResize = () => {
    if (
      typeof process.stdout.columns === "number" &&
      typeof process.stdout.rows === "number"
    ) {
      terminal.resize(process.stdout.columns, process.stdout.rows);
    }
  };
  process.stdout.on("resize", onResize);

  socket.on("open", () => {
    process.stderr.write("[rah] wrapper control connected\n");
    send({
      type: "wrapper.hello",
      provider: "codex",
      cwd: parsed.cwd,
      rootDir: parsed.cwd,
      terminalPid: process.pid,
      launchCommand: ["rah", "codex", ...codexArgs],
      ...(parsed.resumeProviderSessionId
        ? { resumeProviderSessionId: parsed.resumeProviderSessionId }
        : {}),
    });
  });

  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString("utf8"));
    if (message.type === "wrapper.ready") {
      wrapperSessionId = message.sessionId;
      process.stderr.write(
        `[rah] terminal session registered: ${message.sessionId}\n`,
      );
      armPromptReadyTimer({ allowNoPrompt: true, delayMs: 1200 });
      return;
    }
    if (message.type === "turn.inject") {
      void injectRemoteTurnIntoTerminal(terminal, message.queuedTurn.text);
      localPromptTracker.draftText = "";
      awaitingTurnStart = true;
      if (promptReadyTimer) {
        clearTimeout(promptReadyTimer);
        promptReadyTimer = null;
      }
      updatePromptState("agent_busy");
      return;
    }
    if (message.type === "turn.enqueue") {
      process.stderr.write(
        `[rah] remote turn queued: ${message.queuedTurn.text}\n`,
      );
      return;
    }
    if (message.type === "permission.resolve") {
      const pending = pendingApprovals.get(message.requestId);
      if (!pending) {
        process.stderr.write(`[rah] unknown remote permission resolution: ${message.requestId}\n`);
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

  const cleanupAndExit = async () => {
    if (exiting) {
      return;
    }
    exiting = true;
    if (promptReadyTimer) {
      clearTimeout(promptReadyTimer);
      promptReadyTimer = null;
    }
    process.stdin.off("data", onTerminalInput);
    process.stdin.pause();
    process.stdout.off("resize", onResize);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    await terminal.close().catch(() => undefined);
    if (wrapperSessionId) {
      send({
        type: "wrapper.exited",
        sessionId: wrapperSessionId,
        ...(childExitCode !== undefined ? { exitCode: childExitCode } : {}),
        ...(childExitSignal ? { signal: childExitSignal } : {}),
      });
    }
    socket.close();
    process.exitCode = childExitCode;
  };

  process.on("SIGINT", () => {
    if (!childExited) {
      void terminal.close();
    }
  });
  process.on("SIGTERM", () => {
    if (!childExited) {
      void terminal.close();
    }
  });

  while (!childExited) {
    if (wrapperSessionId) {
      const records = discoverCodexStoredSessions();
      const candidate = selectCodexStoredSessionCandidate({
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

      if (candidate) {
        await syncProviderBinding({
          providerSessionId: candidate.ref.providerSessionId,
          reason: boundProviderSessionId ? "switch" : "initial",
          record: candidate,
        });
      }
    }

    const activeBoundRecord = boundRecord as CodexStoredSessionRecord | null;
    if (
      wrapperSessionId &&
      activeBoundRecord !== null &&
      boundProviderSessionId !== null &&
      activeBoundRecord.ref.providerSessionId === boundProviderSessionId
    ) {
      const content = readFileSync(activeBoundRecord.rolloutPath, "utf8");
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
          awaitingTurnStart = false;
          updatePromptState("agent_busy");
        } else if (lifecycle?.kind === "completed") {
          if (currentTurnId && currentTurnId !== lifecycle.turnId) {
            continue;
          }
          currentTurnId = null;
          awaitingTurnStart = false;
          updatePromptState("prompt_clean");
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
            awaitingTurnStart = false;
          } else if (
            item.activity.type === "turn_completed" ||
            item.activity.type === "turn_failed" ||
            item.activity.type === "turn_canceled"
          ) {
            currentTurnId = null;
            awaitingTurnStart = false;
            armPromptReadyTimer();
          }
          const nextPromptState = nextPromptStateFromActivity(promptState, item.activity);
          if (nextPromptState !== promptState) {
            promptState = nextPromptState;
            send({
              type: "wrapper.prompt_state.changed",
              sessionId: wrapperSessionId,
              state: promptState,
            });
          }
        }
      }
    }
    await delay(250);
  }

  process.stderr.write("[rah] codex terminal wrapper exiting\n");
  await disposeControlClient(controlClient);
  await cleanupAndExit();
}

void main();
