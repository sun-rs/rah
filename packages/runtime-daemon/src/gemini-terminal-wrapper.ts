import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";
import readline from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import type { ProviderActivity } from "./provider-activity";
import type {
  QueuedTurn,
  TerminalWrapperPromptState,
} from "./terminal-wrapper-control";
import { NativeTerminalProcess } from "./native-terminal-process";
import {
  buildGeminiArgs,
  isNoisyGeminiCliStderr,
  resolveGeminiBinary,
} from "./gemini-live-client";
import {
  discoverGeminiStoredSessions,
  findGeminiStoredSessionRecord,
  isGeminiStoredSessionRecordResumable,
  type GeminiStoredSessionRecord,
} from "./gemini-session-files";
import {
  extractGeminiUserDisplayText,
  extractTextFromContent,
} from "./gemini-conversation-utils";
import {
  knownModelContextWindow,
  withModelContextWindow,
} from "./model-context-window";
import type {
  GeminiMessageRecord,
  GeminiToolCallRecord,
} from "./gemini-session-types";
import {
  clearTerminalScreen,
  disableTerminalApplicationModes,
  enterAlternateScreen,
  leaveAlternateScreen,
  renderTerminalWrapperPanel,
  renderTerminalWrapperPanelForTerminal,
  restoreInheritedTerminalModes,
} from "./terminal-wrapper-panel";
import { deriveTerminalWrapperRemoteControlState } from "./terminal-wrapper-remote-control";

type WrapperMode = "local_native" | "remote_writer";

const REMOTE_STOP_TERM_DELAY_MS = 800;
const REMOTE_STOP_KILL_DELAY_MS = 2_000;
const REMOTE_PANEL_SETTLE_MS = 1_500;
const REMOTE_PANEL_SETTLE_REDRAW_MS = 250;
const GEMINI_REMOTE_APPROVAL_MODES = new Set(["default", "auto_edit", "yolo", "plan"]);
const GEMINI_CONTEXT_WINDOW = knownModelContextWindow({ provider: "gemini" });

function resolveGeminiHandoffApprovalMode(cliApprovalMode?: string): string {
  const value = cliApprovalMode ?? process.env.RAH_GEMINI_REMOTE_APPROVAL_MODE?.trim();
  if (value && GEMINI_REMOTE_APPROVAL_MODES.has(value)) {
    return value;
  }
  return "yolo";
}

type GeminiNativeResumeTarget =
  | { kind: "none" }
  | { kind: "latest" }
  | { kind: "session"; sessionId: string };

function parseArgs(argv: string[]) {
  let daemonUrl = "http://127.0.0.1:43111";
  let cwd = process.cwd();
  let resumeProviderSessionId: string | undefined;
  let approvalMode: string | undefined;

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
    if (arg === "--approval-mode") {
      const value = rest.shift();
      if (!value || !GEMINI_REMOTE_APPROVAL_MODES.has(value)) {
        throw new Error(`Unsupported Gemini approval mode: ${value ?? "<missing>"}`);
      }
      approvalMode = value;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    daemonUrl,
    cwd,
    ...(resumeProviderSessionId ? { resumeProviderSessionId } : {}),
    ...(approvalMode ? { approvalMode } : {}),
  };
}

function wrapperControlUrl(daemonUrl: string): string {
  const url = new URL(daemonUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/api/wrapper-control";
  url.search = "";
  return url.toString();
}

function normalizeDirectory(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim().replace(/[\\/]+$/, "");
  if (!trimmed) {
    return null;
  }
  return trimmed.startsWith("/private/var/") ? trimmed.slice("/private".length) : trimmed;
}

function sameDirectory(left: string | undefined, right: string | undefined): boolean {
  const normalizedLeft = normalizeDirectory(left);
  const normalizedRight = normalizeDirectory(right);
  return normalizedLeft !== null && normalizedRight !== null && normalizedLeft === normalizedRight;
}

function classifyGeminiToolFamily(name: string) {
  const normalized = name.toLowerCase();
  if (normalized.includes("read") || normalized.includes("open")) return "file_read" as const;
  if (normalized.includes("write")) return "file_write" as const;
  if (normalized.includes("edit") || normalized.includes("replace")) return "file_edit" as const;
  if (normalized.includes("shell") || normalized.includes("bash") || normalized.includes("run"))
    return "shell" as const;
  if (normalized.includes("search") || normalized.includes("glob") || normalized.includes("grep"))
    return "search" as const;
  if (normalized.includes("fetch")) return "web_fetch" as const;
  if (normalized.includes("web")) return "web_search" as const;
  if (normalized.includes("memory")) return "memory" as const;
  if (normalized.includes("todo")) return "todo" as const;
  if (normalized.includes("mcp")) return "mcp" as const;
  return "other" as const;
}

function extractGeminiToolError(value: unknown): string {
  if (Array.isArray(value)) {
    for (const item of value) {
      const error = extractGeminiToolError(item);
      if (error) return error;
    }
    return "";
  }
  if (value === null || typeof value !== "object") {
    return "";
  }
  const record = value as Record<string, unknown>;
  if (typeof record.error === "string" && record.error.trim()) {
    return record.error.trim();
  }
  for (const child of Object.values(record)) {
    const error = extractGeminiToolError(child);
    if (error) return error;
  }
  return "";
}

function usageFromStats(stats: Record<string, unknown>) {
  return withModelContextWindow({
    ...(typeof stats.total_tokens === "number" ? { usedTokens: stats.total_tokens } : {}),
    ...(typeof stats.input_tokens === "number" ? { inputTokens: stats.input_tokens } : {}),
    ...(typeof stats.cached === "number" ? { cachedInputTokens: stats.cached } : {}),
    ...(typeof stats.output_tokens === "number" ? { outputTokens: stats.output_tokens } : {}),
  }, GEMINI_CONTEXT_WINDOW);
}

function usageFromMessage(
  message: GeminiMessageRecord,
): Extract<ProviderActivity, { type: "usage" }> | null {
  const tokens = message.tokens;
  if (!tokens) {
    return null;
  }
  return {
    type: "usage",
    usage: withModelContextWindow({
      ...(typeof tokens.total === "number" ? { usedTokens: tokens.total } : {}),
      ...(typeof tokens.input === "number" ? { inputTokens: tokens.input } : {}),
      ...(typeof tokens.cached === "number" ? { cachedInputTokens: tokens.cached } : {}),
      ...(typeof tokens.output === "number" ? { outputTokens: tokens.output } : {}),
    }, GEMINI_CONTEXT_WINDOW),
  };
}

function toolActivitiesFromGeminiMessage(
  message: GeminiMessageRecord,
  turnId: string,
): ProviderActivity[] {
  return (message.toolCalls ?? []).flatMap((toolCall: GeminiToolCallRecord) => {
    const providerToolName = toolCall.name || "unknown";
    const title = toolCall.displayName || providerToolName;
    const detailText =
      toolCall.result !== undefined
        ? extractTextFromContent(toolCall.result) || JSON.stringify(toolCall.result)
        : "";
    const resultError = extractGeminiToolError(toolCall.result);
    const tool = {
      id: toolCall.id,
      family: classifyGeminiToolFamily(providerToolName),
      providerToolName,
      title,
      ...(toolCall.args ? { input: toolCall.args } : {}),
      ...(detailText
        ? {
            detail: {
              artifacts: [{ kind: "text" as const, label: "output", text: detailText }],
            },
          }
        : {}),
    };
    const failed =
      resultError !== "" ||
      (typeof toolCall.status === "string" &&
        ["error", "failed", "cancelled", "canceled"].includes(toolCall.status.toLowerCase()));
    return [
      { type: "tool_call_started" as const, turnId, toolCall: tool },
      failed
        ? {
            type: "tool_call_failed" as const,
            turnId,
            toolCallId: toolCall.id,
            error: resultError || detailText || toolCall.status || "Tool failed",
          }
        : {
            type: "tool_call_completed" as const,
            turnId,
            toolCall: tool,
          },
    ];
  });
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const handoffApprovalMode = resolveGeminiHandoffApprovalMode(parsed.approvalMode);
  const requestedResumeProviderSessionId = parsed.resumeProviderSessionId;
  const discoveredRequestedResumeRecord =
    requestedResumeProviderSessionId && requestedResumeProviderSessionId !== "latest"
      ? findGeminiStoredSessionRecord(requestedResumeProviderSessionId, parsed.cwd)
      : null;
  const requestedResumeRecord =
    discoveredRequestedResumeRecord &&
    isGeminiStoredSessionRecordResumable(discoveredRequestedResumeRecord)
      ? discoveredRequestedResumeRecord
      : null;
  const initialBoundProviderSessionId = requestedResumeRecord?.ref.providerSessionId ?? null;
  const startupTimeMs = Date.now();
  const socket = new WebSocket(wrapperControlUrl(parsed.daemonUrl));

  let wrapperSessionId: string | null = null;
  let promptState: TerminalWrapperPromptState = "prompt_dirty";
  let boundProviderSessionId: string | null = initialBoundProviderSessionId;
  let nativeResumeTarget: GeminiNativeResumeTarget = initialBoundProviderSessionId
    ? { kind: "session", sessionId: initialBoundProviderSessionId }
    : requestedResumeProviderSessionId === "latest"
      ? { kind: "latest" }
      : { kind: "none" };
  let currentTurnId: string | null = null;
  let mode: WrapperMode = "local_native";
  let localTerminal: NativeTerminalProcess | null = null;
  let localExitCode = 0;
  let localExitSignal: string | null = null;
  let pendingRemoteTurn: QueuedTurn | null = null;
  let remoteTurnProcess: ChildProcessWithoutNullStreams | null = null;
  let remoteKeyboardHandler: ((chunk: Buffer | string) => void) | null = null;
  let remotePromptText: string | null = null;
  let remotePanelActive = false;
  let remoteReclaimRequested = false;
  let remoteTurnRequestInFlight = false;
  let remoteTurnCancelRequested = false;
  let remoteTurnInterrupted = false;
  let remoteTurnFinalized = false;
  let lastRenderedRemotePanel: string | null = null;
  let remotePanelForceUntilMs = 0;
  let lastRemotePanelForceMs = 0;
  let remoteStopTimers: NodeJS.Timeout[] = [];
  let restartLocalAfterCanceledPendingTurn = false;
  let exiting = false;
  let shouldExit = false;
  let boundRecord: GeminiStoredSessionRecord | null = requestedResumeRecord;
  let historyCursorPrimed = requestedResumeProviderSessionId === undefined;
  let localTurnCounter = 0;
  const processedMessageIds = new Set<string>();
  const remoteToolCalls = new Map<
    string,
    {
      id: string;
      family: ReturnType<typeof classifyGeminiToolFamily>;
      providerToolName: string;
      title: string;
      input?: Record<string, unknown>;
    }
  >();

  const send = (message: unknown) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  };

  const notifyActivity = (activity: ProviderActivity) => {
    if (!wrapperSessionId) {
      return;
    }
    send({
      type: "wrapper.activity",
      sessionId: wrapperSessionId,
      activity,
    });
  };

  const sendPromptState = () => {
    if (!wrapperSessionId) {
      return;
    }
    send({
      type: "wrapper.prompt_state.changed",
      sessionId: wrapperSessionId,
      state: promptState,
    });
  };

  const updatePromptState = (nextState: TerminalWrapperPromptState) => {
    if (nextState === promptState) {
      return;
    }
    promptState = nextState;
    sendPromptState();
  };

  const bindProviderSession = (
    providerSessionId: string,
    record?: GeminiStoredSessionRecord | null,
  ) => {
    boundProviderSessionId = providerSessionId;
    if (record !== undefined) {
      boundRecord = record;
    }
    if (record) {
      nativeResumeTarget = { kind: "session", sessionId: record.ref.providerSessionId };
    }
    if (!wrapperSessionId) {
      return;
    }
    send({
      type: "wrapper.provider_bound",
      sessionId: wrapperSessionId,
      providerSessionId,
      providerTitle: record?.ref.title ?? providerSessionId,
      providerPreview: record?.ref.preview ?? providerSessionId,
      reason: requestedResumeProviderSessionId ? "resume" : "initial",
    });
  };

  const getResumableRecordById = (providerSessionId: string) => {
    const record = findGeminiStoredSessionRecord(providerSessionId, parsed.cwd);
    return record && isGeminiStoredSessionRecordResumable(record) ? record : null;
  };

  const getLatestResumableRecord = () =>
    discoverGeminiStoredSessions()
      .filter((record) => sameDirectory(record.ref.cwd ?? record.ref.rootDir, parsed.cwd))
      .filter(isGeminiStoredSessionRecordResumable)
      .sort((a, b) =>
        (b.ref.updatedAt ?? b.conversation.lastUpdated ?? "").localeCompare(
          a.ref.updatedAt ?? a.conversation.lastUpdated ?? "",
        ),
      )[0] ?? null;

  const getNativeResumeArg = () => {
    switch (nativeResumeTarget.kind) {
      case "session": {
        const record = getResumableRecordById(nativeResumeTarget.sessionId);
        if (!record) {
          nativeResumeTarget = { kind: "none" };
          return null;
        }
        return nativeResumeTarget.sessionId;
      }
      case "latest":
        return getLatestResumableRecord() ? "latest" : null;
      case "none":
        return null;
    }
  };

  const ensureRemotePanelScreen = (force = false) => {
    if (remotePanelActive && !force) {
      return;
    }
    disableTerminalApplicationModes();
    enterAlternateScreen();
    disableTerminalApplicationModes();
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
      providerLabel: "Gemini",
      hasPendingTurn: pendingRemoteTurn !== null,
      hasActiveTurn: remoteTurnRequestInFlight || currentTurnId !== null,
      promptState,
      cancelRequested: remoteTurnCancelRequested,
      reclaimRequested: remoteReclaimRequested,
    });

  const renderRemoteModePanel = (options: { force?: boolean } = {}) => {
    if (mode !== "remote_writer" || exiting) {
      lastRenderedRemotePanel = null;
      return;
    }
    const question = remotePromptText ?? pendingRemoteTurn?.text ?? "";
    const remoteControl = getRemoteControlState();
    const sessionId = boundProviderSessionId ?? "Pending session binding";
    const panel = renderTerminalWrapperPanel({
      title: "RAH Gemini Remote Control",
      status: remoteControl.status,
      statusTone: remoteControl.tone,
      sessionId,
      prompt: question || "No active web prompt.",
      footer: remoteControl.footer,
      footerTone: remoteControl.tone,
    });
    if (!options.force && panel === lastRenderedRemotePanel) {
      return;
    }
    lastRenderedRemotePanel = panel;
    ensureRemotePanelScreen(options.force);
    clearTerminalScreen();
    process.stdout.write(
      `${renderTerminalWrapperPanelForTerminal({
        title: "RAH Gemini Remote Control",
        status: remoteControl.status,
        statusTone: remoteControl.tone,
        sessionId,
        prompt: question || "No active web prompt.",
        footer: remoteControl.footer,
        footerTone: remoteControl.tone,
      })}\r\n`,
    );
    lastRemotePanelForceMs = Date.now();
  };

  const clearRemoteStopTimers = () => {
    for (const timer of remoteStopTimers) {
      clearTimeout(timer);
    }
    remoteStopTimers = [];
  };

  const signalRemoteTurnProcess = (
    child: ChildProcessWithoutNullStreams,
    signal: NodeJS.Signals,
  ) => {
    if (child.exitCode !== null) {
      return;
    }
    if (process.platform !== "win32" && child.pid !== undefined) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {}
    }
    child.kill(signal);
  };

  const requestRemoteTurnStop = () => {
    remoteTurnInterrupted = true;
    remoteTurnCancelRequested = true;
    renderRemoteModePanel({ force: true });
    const child = remoteTurnProcess;
    if (!child || child.exitCode !== null) {
      return;
    }
    clearRemoteStopTimers();
    signalRemoteTurnProcess(child, "SIGINT");
    remoteStopTimers.push(
      setTimeout(() => {
        if (child.exitCode === null) {
          signalRemoteTurnProcess(child, "SIGTERM");
        }
      }, REMOTE_STOP_TERM_DELAY_MS),
      setTimeout(() => {
        if (child.exitCode === null) {
          signalRemoteTurnProcess(child, "SIGKILL");
        }
      }, REMOTE_STOP_KILL_DELAY_MS),
    );
  };

  const isMouseOrFocusInput = (data: string) =>
    data.startsWith("\u001b[<") ||
    data.startsWith("\u001b[M") ||
    data === "\u001b[I" ||
    data === "\u001b[O";

  const isEscReclaimInput = (data: string) =>
    data === "\u001b" || data.startsWith("\u001b[27;");

  const selectBindingCandidate = () => {
    if (boundProviderSessionId) {
      return getResumableRecordById(boundProviderSessionId);
    }
    const candidates = discoverGeminiStoredSessions()
      .filter((record) => sameDirectory(record.ref.cwd ?? record.ref.rootDir, parsed.cwd))
      .filter(isGeminiStoredSessionRecordResumable)
      .filter((record) => {
        const updatedAt = Date.parse(record.ref.updatedAt ?? record.conversation.lastUpdated ?? "");
        return Number.isFinite(updatedAt) && updatedAt >= startupTimeMs - 5_000;
      })
      .sort((a, b) =>
        (b.ref.updatedAt ?? b.conversation.lastUpdated ?? "").localeCompare(
          a.ref.updatedAt ?? a.conversation.lastUpdated ?? "",
        ),
      );
    return candidates[0] ?? null;
  };

  const primeResumeHistoryCursor = (record: GeminiStoredSessionRecord) => {
    if (historyCursorPrimed) {
      return;
    }
    for (const message of record.conversation.messages) {
      processedMessageIds.add(message.id);
    }
    historyCursorPrimed = true;
  };

  const syncHistoryCursorToEnd = () => {
    const record = boundProviderSessionId
      ? getResumableRecordById(boundProviderSessionId)
      : selectBindingCandidate();
    if (!record) {
      return;
    }
    if (!boundProviderSessionId || boundProviderSessionId !== record.ref.providerSessionId) {
      bindProviderSession(record.ref.providerSessionId, record);
    } else {
      boundRecord = record;
      nativeResumeTarget = { kind: "session", sessionId: record.ref.providerSessionId };
    }
    for (const message of record.conversation.messages) {
      processedMessageIds.add(message.id);
    }
    historyCursorPrimed = true;
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

  const startLocalNative = async () => {
    disableRemoteKeyboardControl();
    mode = "local_native";
    remotePromptText = null;
    lastRenderedRemotePanel = null;
    remotePanelForceUntilMs = 0;
    lastRemotePanelForceMs = 0;
    remoteReclaimRequested = false;
    remoteTurnCancelRequested = false;
    remoteTurnInterrupted = false;
    remoteTurnRequestInFlight = false;
    updatePromptState("prompt_clean");
    restoreMainTerminalScreen();
    const binary = await resolveGeminiBinary();
    const nativeResumeArg = getNativeResumeArg();
    const args = [
      "--approval-mode",
      handoffApprovalMode,
      ...(nativeResumeArg ? ["--resume", nativeResumeArg] : []),
    ];
    localTerminal = new NativeTerminalProcess({
      cwd: parsed.cwd,
      command: binary,
      args,
      onExit: ({ exitCode, signal }) => {
        localTerminal = null;
        localExitCode = exitCode ?? 0;
        localExitSignal = signal ?? null;
        if (exiting) {
          shouldExit = true;
          return;
        }
        if (restartLocalAfterCanceledPendingTurn) {
          restartLocalAfterCanceledPendingTurn = false;
          void startLocalNative();
          return;
        }
        if (pendingRemoteTurn) {
          const turn = pendingRemoteTurn;
          pendingRemoteTurn = null;
          mode = "remote_writer";
          void startRemoteTurn(turn);
          return;
        }
        shouldExit = true;
      },
    });
  };

  const enableRemoteKeyboardControl = () => {
    if (remoteKeyboardHandler || exiting || mode !== "remote_writer") {
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
        localExitCode = 130;
        void cleanupAndExit().finally(() => {
          shouldExit = true;
        });
        return;
      }
      if (isMouseOrFocusInput(data)) {
        return;
      }
      if (isEscReclaimInput(data)) {
        if (!getRemoteControlState().controlAvailable) {
          remoteReclaimRequested = true;
          renderRemoteModePanel({ force: true });
          return;
        }
        void startLocalNative();
        return;
      }
    };
    process.stdin.on("data", remoteKeyboardHandler);
    renderRemoteModePanel({ force: true });
  };

  const emitUserInput = (text: string, turnId: string) => {
    notifyActivity({ type: "turn_started", turnId });
    notifyActivity({
      type: "timeline_item",
      turnId,
      item: {
        kind: "user_message",
        text,
      },
    });
  };

  const finishRemoteTurn = (activity: ProviderActivity) => {
    if (remoteTurnFinalized) {
      return;
    }
    remoteTurnFinalized = true;
    notifyActivity(activity);
    notifyActivity({ type: "session_state", state: "idle" });
    currentTurnId = null;
    remoteTurnRequestInFlight = false;
    remoteTurnCancelRequested = false;
    remoteTurnInterrupted = false;
    remoteTurnProcess = null;
    clearRemoteStopTimers();
    updatePromptState("prompt_clean");
    syncHistoryCursorToEnd();
    if (remoteReclaimRequested) {
      void startLocalNative();
      return;
    }
    renderRemoteModePanel();
    enableRemoteKeyboardControl();
  };

  const startRemoteTurn = async (queuedTurn: QueuedTurn) => {
    disableRemoteKeyboardControl();
    mode = "remote_writer";
    remotePromptText = queuedTurn.text;
    remotePanelForceUntilMs = Date.now() + REMOTE_PANEL_SETTLE_MS;
    lastRemotePanelForceMs = 0;
    remoteReclaimRequested = false;
    remoteTurnInterrupted = false;
    remoteTurnCancelRequested = false;
    remoteTurnFinalized = false;
    remoteTurnRequestInFlight = true;
    currentTurnId = randomUUID();
    remoteToolCalls.clear();
    updatePromptState("agent_busy");
    renderRemoteModePanel({ force: true });
    emitUserInput(queuedTurn.text, currentTurnId);
    notifyActivity({ type: "session_state", state: "running" });

    try {
      const binary = await resolveGeminiBinary();
      const nativeResumeArg = getNativeResumeArg();
      const child = spawn(
        binary,
        buildGeminiArgs({
          prompt: queuedTurn.text,
          ...(nativeResumeArg ? { providerSessionId: nativeResumeArg } : {}),
          approvalMode: handoffApprovalMode,
        }),
        {
          cwd: parsed.cwd,
          env: process.env,
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      remoteTurnProcess = child;
      child.stdin.end();
      if (remoteTurnCancelRequested) {
        requestRemoteTurnStop();
      }

      const stdout = readline.createInterface({
        input: child.stdout,
        crlfDelay: Infinity,
      });
      const stderr = readline.createInterface({
        input: child.stderr,
        crlfDelay: Infinity,
      });

      const closeReaders = () => {
        stdout.close();
        stderr.close();
      };

      stderr.on("line", (line) => {
        if (
          remoteTurnCancelRequested ||
          !line.trim() ||
          isNoisyGeminiCliStderr(line) ||
          !currentTurnId
        ) {
          return;
        }
        notifyActivity({
          type: "notification",
          level: "warning",
          title: "Gemini CLI stderr",
          body: line,
          turnId: currentTurnId,
        });
      });

      stdout.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed || !currentTurnId) {
          return;
        }
        let parsedLine: unknown;
        try {
          parsedLine = JSON.parse(trimmed);
        } catch {
          notifyActivity({
            type: "notification",
            level: "warning",
            title: "Gemini stream parse error",
            body: trimmed,
            turnId: currentTurnId,
          });
          return;
        }
        if (!parsedLine || typeof parsedLine !== "object" || Array.isArray(parsedLine)) {
          return;
        }
        if (remoteTurnCancelRequested) {
          return;
        }
        const event = parsedLine as Record<string, unknown>;
        switch (event.type) {
          case "init": {
            if (typeof event.session_id === "string") {
              renderRemoteModePanel();
            }
            break;
          }
          case "message": {
            if (event.role === "assistant" && typeof event.content === "string") {
              notifyActivity({
                type: "timeline_item",
                turnId: currentTurnId,
                item: {
                  kind: "assistant_message",
                  text: event.content,
                  messageId: `${currentTurnId}:assistant`,
                },
              });
            }
            break;
          }
          case "tool_use": {
            if (typeof event.tool_id !== "string" || typeof event.tool_name !== "string") {
              break;
            }
            const toolCall = {
              id: event.tool_id,
              family: classifyGeminiToolFamily(event.tool_name),
              providerToolName: event.tool_name,
              title: event.tool_name,
              ...(event.parameters &&
              typeof event.parameters === "object" &&
              !Array.isArray(event.parameters)
                ? { input: event.parameters as Record<string, unknown> }
                : {}),
            };
            remoteToolCalls.set(event.tool_id, toolCall);
            notifyActivity({
              type: "tool_call_started",
              turnId: currentTurnId,
              toolCall,
            });
            break;
          }
          case "tool_result": {
            if (typeof event.tool_id !== "string") {
              break;
            }
            const existing = remoteToolCalls.get(event.tool_id) ?? {
              id: event.tool_id,
              family: "other" as const,
              providerToolName: "unknown",
              title: "Gemini tool",
            };
            if (event.status === "error") {
              notifyActivity({
                type: "tool_call_failed",
                turnId: currentTurnId,
                toolCallId: event.tool_id,
                error:
                  event.error && typeof event.error === "object" && !Array.isArray(event.error)
                    ? String((event.error as Record<string, unknown>).message ?? "Tool failed")
                    : "Tool failed",
              });
              break;
            }
            notifyActivity({
              type: "tool_call_completed",
              turnId: currentTurnId,
              toolCall: {
                ...existing,
                ...(typeof event.output === "string" && event.output
                  ? {
                      detail: {
                        artifacts: [{ kind: "text", label: "output", text: event.output }],
                      },
                    }
                  : {}),
              },
            });
            break;
          }
          case "error": {
            notifyActivity({
              type: "notification",
              level: event.severity === "error" ? "critical" : "warning",
              title: "Gemini CLI error",
              body: typeof event.message === "string" ? event.message : "Gemini CLI error",
              turnId: currentTurnId,
            });
            break;
          }
          case "result": {
            const turnId = currentTurnId;
            if (event.status === "success") {
              if (event.stats && typeof event.stats === "object" && !Array.isArray(event.stats)) {
                notifyActivity({
                  type: "usage",
                  turnId,
                  usage: usageFromStats(event.stats as Record<string, unknown>),
                });
              }
              closeReaders();
              finishRemoteTurn({ type: "turn_completed", turnId });
              break;
            }
            closeReaders();
            finishRemoteTurn({
              type: "turn_failed",
              turnId,
              error:
                event.error && typeof event.error === "object" && !Array.isArray(event.error)
                  ? String((event.error as Record<string, unknown>).message ?? "Gemini turn failed")
                  : "Gemini turn failed",
            });
            break;
          }
        }
      });

      child.once("error", (error) => {
        closeReaders();
        finishRemoteTurn({
          type: "turn_failed",
          turnId: currentTurnId ?? randomUUID(),
          error: error.message,
        });
      });

      child.once("exit", (code, signal) => {
        closeReaders();
        clearRemoteStopTimers();
        if (remoteTurnFinalized) {
          return;
        }
        const turnId = currentTurnId ?? randomUUID();
        if (remoteTurnInterrupted || remoteTurnCancelRequested) {
          finishRemoteTurn({
            type: "turn_canceled",
            turnId,
            reason: signal ? `aborted:${signal}` : "aborted",
          });
          return;
        }
        finishRemoteTurn({
          type: "turn_failed",
          turnId,
          error: signal ? `Gemini CLI exited via ${signal}` : `Gemini CLI exited with ${code ?? 0}`,
        });
      });
    } catch (error) {
      finishRemoteTurn({
        type: remoteTurnInterrupted ? "turn_canceled" : "turn_failed",
        turnId: currentTurnId ?? randomUUID(),
        ...(remoteTurnInterrupted
          ? { reason: "interrupted" }
          : { error: error instanceof Error ? error.message : String(error) }),
      } as ProviderActivity);
    }
  };

  const processLocalMessage = (message: GeminiMessageRecord) => {
    if (processedMessageIds.has(message.id)) {
      return;
    }
    processedMessageIds.add(message.id);
    if (message.type === "user") {
      currentTurnId = `gemini-local:${message.id || localTurnCounter++}`;
      updatePromptState("agent_busy");
      notifyActivity({ type: "turn_started", turnId: currentTurnId });
      const text = extractGeminiUserDisplayText(message);
      if (text) {
        notifyActivity({
          type: "timeline_item",
          turnId: currentTurnId,
          item: { kind: "user_message", text, messageId: message.id },
        });
      }
      return;
    }

    if (!currentTurnId) {
      currentTurnId = `gemini-local:${message.id || localTurnCounter++}`;
      notifyActivity({ type: "turn_started", turnId: currentTurnId });
    }
    const turnId = currentTurnId;
    if (message.type === "gemini") {
      const text = extractTextFromContent(message.content);
      if (text) {
        notifyActivity({
          type: "timeline_item",
          turnId,
          item: { kind: "assistant_message", text, messageId: message.id },
        });
      }
      for (const thought of message.thoughts ?? []) {
        const thoughtText =
          (typeof thought.text === "string" ? thought.text : "") ||
          (typeof thought.subject === "string" ? thought.subject : "");
        if (thoughtText) {
          notifyActivity({
            type: "timeline_item",
            turnId,
            item: { kind: "reasoning", text: thoughtText },
          });
        }
      }
      for (const activity of toolActivitiesFromGeminiMessage(message, turnId)) {
        notifyActivity(activity);
      }
      const usage = usageFromMessage(message);
      if (usage) {
        notifyActivity({ ...usage, turnId });
      }
      notifyActivity({ type: "turn_completed", turnId });
      currentTurnId = null;
      updatePromptState("prompt_clean");
      return;
    }

    if (message.type === "error") {
      const text = extractTextFromContent(message.content) || "Gemini error";
      notifyActivity({
        type: "notification",
        level: "critical",
        title: "Gemini error",
        body: text,
        turnId,
      });
      notifyActivity({ type: "turn_failed", turnId, error: text });
      currentTurnId = null;
      updatePromptState("prompt_clean");
      return;
    }

    const text = extractTextFromContent(message.content);
    if (text) {
      notifyActivity({
        type: "timeline_item",
        turnId,
        item: {
          kind: "system",
          text,
        },
      });
    }
  };

  const scanLocalHistory = () => {
    const record = boundProviderSessionId
      ? findGeminiStoredSessionRecord(boundProviderSessionId, parsed.cwd)
      : selectBindingCandidate();
    if (!record) {
      return;
    }
    if (!boundProviderSessionId) {
      bindProviderSession(record.ref.providerSessionId, record);
    } else {
      boundRecord = record;
    }
    primeResumeHistoryCursor(record);
    for (const message of record.conversation.messages) {
      processLocalMessage(message);
    }
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
    clearRemoteStopTimers();
    if (remoteTurnProcess && remoteTurnProcess.exitCode === null) {
      signalRemoteTurnProcess(remoteTurnProcess, "SIGTERM");
    }
    restoreInheritedTerminalModes();
    if (wrapperSessionId) {
      send({
        type: "wrapper.exited",
        sessionId: wrapperSessionId,
        exitCode: localExitCode,
        ...(localExitSignal ? { signal: localExitSignal } : {}),
      });
    }
    socket.close();
  };

  socket.on("open", () => {
    send({
      type: "wrapper.hello",
      provider: "gemini",
      cwd: parsed.cwd,
      rootDir: parsed.cwd,
      terminalPid: process.pid,
      launchCommand: [
        "rah",
        "gemini",
        ...(requestedResumeProviderSessionId ? ["resume", requestedResumeProviderSessionId] : []),
        "--approval-mode",
        handoffApprovalMode,
      ],
      ...(initialBoundProviderSessionId
        ? { resumeProviderSessionId: initialBoundProviderSessionId }
        : {}),
    });
  });

  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString("utf8"));
    if (message.type === "wrapper.ready") {
      wrapperSessionId = message.sessionId;
      if (boundProviderSessionId) {
        const record = findGeminiStoredSessionRecord(boundProviderSessionId, parsed.cwd);
        if (record) {
          boundRecord = record;
          primeResumeHistoryCursor(record);
        }
        bindProviderSession(boundProviderSessionId, record);
      } else if (
        requestedResumeProviderSessionId &&
        requestedResumeProviderSessionId !== "latest"
      ) {
        notifyActivity({
          type: "notification",
          level: "warning",
          title: "Gemini resume fallback",
          body:
            `Gemini CLI did not expose native session ${requestedResumeProviderSessionId}; ` +
            "RAH is starting without --resume until a native Gemini session is discovered.",
        });
      }
      sendPromptState();
      return;
    }
    if (message.type === "turn.inject") {
      if (mode === "local_native" && localTerminal) {
        pendingRemoteTurn = message.queuedTurn;
        updatePromptState("agent_busy");
        void localTerminal.close("SIGTERM");
        return;
      }
      void startRemoteTurn(message.queuedTurn);
      return;
    }
    if (message.type === "turn.enqueue") {
      renderRemoteModePanel();
      return;
    }
    if (message.type === "turn.interrupt") {
      if (pendingRemoteTurn) {
        if (mode === "local_native" && localTerminal) {
          restartLocalAfterCanceledPendingTurn = true;
        }
        pendingRemoteTurn = null;
        remotePromptText = null;
        remoteTurnInterrupted = false;
        remoteTurnCancelRequested = false;
        remoteReclaimRequested = false;
        updatePromptState("prompt_clean");
        if (mode === "remote_writer") {
          renderRemoteModePanel();
          enableRemoteKeyboardControl();
        }
        return;
      }
      if (mode === "local_native") {
        return;
      }
      if (remoteTurnRequestInFlight) {
        requestRemoteTurnStop();
      }
      return;
    }
    if (message.type === "permission.resolve") {
      return;
    }
    if (message.type === "wrapper.close") {
      void cleanupAndExit().finally(() => {
        shouldExit = true;
      });
    }
  });

  socket.on("close", () => {
    shouldExit = true;
  });

  socket.on("error", (error) => {
    process.stderr.write(`[rah] ${error.message}\n`);
    shouldExit = true;
  });

  process.on("SIGINT", () => {
    if (!exiting) {
      void cleanupAndExit().finally(() => {
        shouldExit = true;
      });
    }
  });
  process.on("SIGTERM", () => {
    if (!exiting) {
      void cleanupAndExit().finally(() => {
        shouldExit = true;
      });
    }
  });

  await startLocalNative();

  while (!shouldExit && !exiting) {
    if (mode === "local_native" && wrapperSessionId) {
      scanLocalHistory();
    }
    if (
      (mode as WrapperMode) === "remote_writer" &&
      Date.now() <= remotePanelForceUntilMs &&
      Date.now() - lastRemotePanelForceMs >= REMOTE_PANEL_SETTLE_REDRAW_MS
    ) {
      renderRemoteModePanel({ force: true });
    }
    await delay(250);
  }

  await cleanupAndExit();
}

void main().catch((error) => {
  process.stderr.write(`[rah] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
