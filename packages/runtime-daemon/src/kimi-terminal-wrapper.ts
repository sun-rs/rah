import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import {
  isPermissionDenied,
  isPermissionSessionGrant,
  type PermissionResponseRequest,
} from "@rah/runtime-protocol";
import { WebSocket } from "ws";
import type { ProviderActivity } from "./provider-activity";
import type {
  QueuedTurn,
  TerminalWrapperPromptState,
} from "./terminal-wrapper-control";
import { NativeTerminalProcess } from "./native-terminal-process";
import {
  createKimiClient,
  resolveKimiCommand,
  type KimiJsonRpcClient,
} from "./kimi-live-rpc";
import {
  JSON_RPC_TIMEOUT_MS,
  PROMPT_TIMEOUT_MS,
  type JsonRpcEvent,
  type JsonRpcRequest,
  type KimiToolCallState,
  type PendingInteractiveRequest,
} from "./kimi-live-types";
import {
  discoverKimiStoredSessions,
  parseKimiWireLine,
  type KimiStoredSessionRecord,
} from "./kimi-session-files";
import {
  clearTerminalScreen,
  enterAlternateScreen,
  leaveAlternateScreen,
  renderTerminalWrapperPanel,
  renderTerminalWrapperPanelForTerminal,
  restoreInheritedTerminalModes,
} from "./terminal-wrapper-panel";
import { deriveTerminalWrapperRemoteControlState } from "./terminal-wrapper-remote-control";

type WrapperMode = "local_native" | "remote_writer";

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

function classifyKimiToolFamily(name: string) {
  const normalized = name.toLowerCase();
  if (normalized.includes("read")) return "file_read" as const;
  if (normalized.includes("write")) return "file_write" as const;
  if (normalized.includes("replace") || normalized.includes("edit")) return "file_edit" as const;
  if (normalized.includes("shell") || normalized.includes("bash")) return "shell" as const;
  if (normalized.includes("grep") || normalized.includes("glob") || normalized.includes("search"))
    return "search" as const;
  if (normalized.includes("fetch")) return "web_fetch" as const;
  if (normalized.includes("web")) return "web_search" as const;
  if (normalized.includes("todo")) return "todo" as const;
  if (normalized.includes("agent") || normalized.includes("subagent")) return "subagent" as const;
  if (normalized.includes("mcp")) return "mcp" as const;
  return "other" as const;
}

function extractText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(extractText).filter(Boolean).join("");
  }
  if (!value || typeof value !== "object") {
    return "";
  }
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  if (typeof record.think === "string") return record.think;
  if (typeof record.description === "string") return record.description;
  if (typeof record.output === "string") return record.output;
  if (typeof record.message === "string") return record.message;
  if (record.return_value && typeof record.return_value === "object") {
    return extractText(record.return_value);
  }
  if (record.function && typeof record.function === "object") {
    return extractText(record.function);
  }
  return "";
}

function usageFromStatus(payload: Record<string, unknown>): ProviderActivity | null {
  const tokenUsage =
    payload.token_usage && typeof payload.token_usage === "object" && !Array.isArray(payload.token_usage)
      ? (payload.token_usage as Record<string, unknown>)
      : null;
  if (
    tokenUsage === null &&
    typeof payload.context_tokens !== "number" &&
    typeof payload.max_context_tokens !== "number"
  ) {
    return null;
  }
  return {
    type: "usage",
    usage: {
      ...(typeof payload.context_tokens === "number" ? { usedTokens: payload.context_tokens } : {}),
      ...(typeof payload.max_context_tokens === "number"
        ? { contextWindow: payload.max_context_tokens }
        : {}),
      ...(typeof payload.context_usage === "number"
        ? { percentRemaining: Math.max(0, 100 - payload.context_usage * 100) }
        : {}),
      ...(tokenUsage && typeof tokenUsage.input_other === "number"
        ? { inputTokens: tokenUsage.input_other }
        : {}),
      ...(tokenUsage && typeof tokenUsage.input_cache_read === "number"
        ? { cachedInputTokens: tokenUsage.input_cache_read }
        : {}),
      ...(tokenUsage && typeof tokenUsage.output === "number"
        ? { outputTokens: tokenUsage.output }
        : {}),
    },
  };
}

function approvalDecision(response: PermissionResponseRequest) {
  if (
    response.selectedActionId === "approve_for_session" ||
    isPermissionSessionGrant(response)
  ) {
    return "approve_for_session";
  }
  if (isPermissionDenied(response)) {
    return "reject";
  }
  return "approve";
}

function countWireLines(filePath: string): number {
  try {
    return readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean).length;
  } catch {
    return 0;
  }
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const providerSessionId = parsed.resumeProviderSessionId ?? randomUUID();
  const kimiCommand = await resolveKimiCommand();
  const socket = new WebSocket(wrapperControlUrl(parsed.daemonUrl));

  let wrapperSessionId: string | null = null;
  let promptState: TerminalWrapperPromptState = "prompt_dirty";
  let currentTurnId: string | null = null;
  let mode: WrapperMode = "local_native";
  let localTerminal: NativeTerminalProcess | null = null;
  let localExitCode = 0;
  let localExitSignal: string | null = null;
  let pendingRemoteTurn: QueuedTurn | null = null;
  let remoteClient: KimiJsonRpcClient | null = null;
  let remoteKeyboardHandler: ((chunk: Buffer | string) => void) | null = null;
  let remotePromptText: string | null = null;
  let remotePanelActive = false;
  let remoteReclaimRequested = false;
  let remoteTurnInFlight = false;
  let remoteTurnCancelRequested = false;
  let remoteTurnInterrupted = false;
  let remoteTurnFinalized = false;
  let lastRenderedRemotePanel: string | null = null;
  let restartLocalAfterCanceledPendingTurn = false;
  let exiting = false;
  let shouldExit = false;
  let boundRecord: KimiStoredSessionRecord | null = null;
  let processedLineCount = 0;
  let historyCursorPrimed = parsed.resumeProviderSessionId === undefined;
  let localTurnCounter = 0;
  let currentStepIndex: number | undefined;
  let remoteLatestToolCallId: string | null = null;
  let localLatestToolCallId: string | null = null;
  const remoteToolCalls = new Map<string, KimiToolCallState>();
  const localToolCalls = new Map<string, KimiToolCallState>();
  const pendingRequests = new Map<string, PendingInteractiveRequest>();

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

  const bindProviderSession = () => {
    if (!wrapperSessionId) {
      return;
    }
    send({
      type: "wrapper.provider_bound",
      sessionId: wrapperSessionId,
      providerSessionId,
      providerTitle: providerSessionId,
      providerPreview: providerSessionId,
      reason: parsed.resumeProviderSessionId ? "resume" : "initial",
    });
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
      providerLabel: "Kimi",
      hasPendingTurn: pendingRemoteTurn !== null,
      hasActiveTurn: remoteTurnInFlight || currentTurnId !== null,
      promptState,
      cancelRequested: remoteTurnCancelRequested,
      reclaimRequested: remoteReclaimRequested,
    });

  const renderRemoteModePanel = () => {
    if (mode !== "remote_writer" || exiting) {
      lastRenderedRemotePanel = null;
      return;
    }
    const question = remotePromptText ?? pendingRemoteTurn?.text ?? "";
    const remoteControl = getRemoteControlState();
    const panel = renderTerminalWrapperPanel({
      title: "RAH Kimi Remote Control",
      status: remoteControl.status,
      statusTone: remoteControl.tone,
      sessionId: providerSessionId,
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
        title: "RAH Kimi Remote Control",
        status: remoteControl.status,
        statusTone: remoteControl.tone,
        sessionId: providerSessionId,
        prompt: question || "No active web prompt.",
        footer: remoteControl.footer,
        footerTone: remoteControl.tone,
      })}\r\n`,
    );
  };

  const findBoundRecord = () => {
    const record =
      discoverKimiStoredSessions().find(
        (candidate) => candidate.ref.providerSessionId === providerSessionId,
      ) ?? null;
    if (record) {
      boundRecord = record;
    }
    return record;
  };

  const primeResumeHistoryCursor = (record: KimiStoredSessionRecord) => {
    if (historyCursorPrimed) {
      return;
    }
    processedLineCount = countWireLines(record.wirePath);
    historyCursorPrimed = true;
  };

  const syncHistoryCursorToEnd = () => {
    const record = boundRecord ?? findBoundRecord();
    if (!record) {
      return;
    }
    processedLineCount = countWireLines(record.wirePath);
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

  const startLocalNative = () => {
    disableRemoteKeyboardControl();
    mode = "local_native";
    remotePromptText = null;
    lastRenderedRemotePanel = null;
    remoteReclaimRequested = false;
    remoteTurnCancelRequested = false;
    remoteTurnInterrupted = false;
    remoteTurnInFlight = false;
    updatePromptState("prompt_clean");
    restoreMainTerminalScreen();
    const args = [...kimiCommand.args, "--session", providerSessionId];
    localTerminal = new NativeTerminalProcess({
      cwd: parsed.cwd,
      command: kimiCommand.command,
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
          startLocalNative();
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
      if (data === "\u001b") {
        if (!getRemoteControlState().controlAvailable) {
          remoteReclaimRequested = true;
          renderRemoteModePanel();
          return;
        }
        startLocalNative();
      }
    };
    process.stdin.on("data", remoteKeyboardHandler);
    renderRemoteModePanel();
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

  const applyKimiEventPayload = (args: {
    eventType: string;
    payload: Record<string, unknown>;
    source: "local" | "remote";
  }) => {
    const { eventType, payload, source } = args;
    const toolCalls = source === "remote" ? remoteToolCalls : localToolCalls;
    const getLatestToolCallId = () =>
      source === "remote" ? remoteLatestToolCallId : localLatestToolCallId;
    const setLatestToolCallId = (id: string | null) => {
      if (source === "remote") {
        remoteLatestToolCallId = id;
      } else {
        localLatestToolCallId = id;
      }
    };
    const ensureLocalTurn = () => {
      if (currentTurnId) {
        return currentTurnId;
      }
      currentTurnId = `kimi-local:${providerSessionId}:${localTurnCounter++}`;
      currentStepIndex = undefined;
      updatePromptState("agent_busy");
      notifyActivity({ type: "turn_started", turnId: currentTurnId });
      return currentTurnId;
    };

    if (eventType === "TurnBegin" || eventType === "SteerInput") {
      if (source === "remote") {
        return;
      }
      const turnId = ensureLocalTurn();
      const text = extractText(payload.user_input);
      if (text) {
        notifyActivity({
          type: "timeline_item",
          turnId,
          item: { kind: "user_message", text },
        });
      }
      return;
    }

    if (eventType === "TurnEnd") {
      if (source === "remote" || !currentTurnId) {
        return;
      }
      const completedTurnId = currentTurnId;
      currentTurnId = null;
      currentStepIndex = undefined;
      notifyActivity({ type: "turn_completed", turnId: completedTurnId });
      updatePromptState("prompt_clean");
      return;
    }

    const turnId = currentTurnId ?? (source === "local" ? ensureLocalTurn() : null);

    if (eventType === "StepBegin") {
      currentStepIndex = typeof payload.n === "number" ? payload.n : currentStepIndex;
      if (turnId) {
        notifyActivity({
          type: "turn_step_started",
          turnId,
          ...(currentStepIndex !== undefined ? { index: currentStepIndex } : {}),
        });
      }
      return;
    }

    if (eventType === "StepInterrupted") {
      if (turnId) {
        notifyActivity({
          type: "turn_step_interrupted",
          turnId,
          ...(currentStepIndex !== undefined ? { index: currentStepIndex } : {}),
        });
      }
      return;
    }

    if (eventType === "TextPart" || eventType === "ThinkPart" || eventType === "ContentPart") {
      if (!turnId) {
        return;
      }
      const partType =
        eventType === "ThinkPart"
          ? "think"
          : eventType === "ContentPart" && typeof payload.type === "string"
            ? payload.type
            : "text";
      const text = extractText(payload);
      if (!text) {
        return;
      }
      notifyActivity({
        type: "timeline_item",
        turnId,
        item: {
          kind: partType === "think" ? "reasoning" : "assistant_message",
          text,
        },
      });
      return;
    }

    if (eventType === "ToolCall") {
      if (!turnId) {
        return;
      }
      const functionBody =
        payload.function && typeof payload.function === "object" && !Array.isArray(payload.function)
          ? (payload.function as Record<string, unknown>)
          : {};
      const name =
        typeof functionBody.name === "string"
          ? functionBody.name
          : typeof payload.name === "string"
            ? payload.name
            : "unknown";
      const id = typeof payload.id === "string" ? payload.id : randomUUID();
      const state: KimiToolCallState = {
        id,
        name,
        family: classifyKimiToolFamily(name),
        title: name,
        argsText: typeof functionBody.arguments === "string" ? functionBody.arguments : "",
      };
      toolCalls.set(id, state);
      setLatestToolCallId(id);
      let input: Record<string, unknown> | undefined;
      if (state.argsText) {
        try {
          const parsedArgs = JSON.parse(state.argsText);
          if (parsedArgs && typeof parsedArgs === "object" && !Array.isArray(parsedArgs)) {
            input = parsedArgs as Record<string, unknown>;
          }
        } catch {}
      }
      notifyActivity({
        type: "tool_call_started",
        turnId,
        toolCall: {
          id,
          family: state.family,
          providerToolName: name,
          title: name,
          ...(input ? { input } : {}),
        },
      });
      return;
    }

    if (eventType === "ToolCallPart") {
      const latestToolCallId = getLatestToolCallId();
      if (!latestToolCallId) {
        return;
      }
      const current = toolCalls.get(latestToolCallId);
      if (current && typeof payload.arguments_part === "string") {
        current.argsText += payload.arguments_part;
      }
      return;
    }

    if (eventType === "ToolResult") {
      const toolCallId = typeof payload.tool_call_id === "string" ? payload.tool_call_id : null;
      if (!toolCallId) {
        return;
      }
      const pending = toolCalls.get(toolCallId);
      const returnValue =
        payload.return_value && typeof payload.return_value === "object" && !Array.isArray(payload.return_value)
          ? (payload.return_value as Record<string, unknown>)
          : {};
      let input: Record<string, unknown> | undefined;
      if (pending?.argsText) {
        try {
          const parsedInput = JSON.parse(pending.argsText);
          if (parsedInput && typeof parsedInput === "object" && !Array.isArray(parsedInput)) {
            input = parsedInput as Record<string, unknown>;
          }
        } catch {}
      }
      const text = extractText(returnValue);
      if (returnValue.is_error) {
        notifyActivity({
          type: "tool_call_failed",
          ...(turnId ? { turnId } : {}),
          toolCallId,
          error: text || "Tool failed",
        });
        return;
      }
      notifyActivity({
        type: "tool_call_completed",
        ...(turnId ? { turnId } : {}),
        toolCall: {
          id: toolCallId,
          family: pending?.family ?? "other",
          providerToolName: pending?.name ?? "unknown",
          title: pending?.title ?? "Tool",
          ...(input ? { input } : {}),
          ...(text
            ? {
                detail: {
                  artifacts: [{ kind: "text", label: "output", text }],
                },
              }
            : {}),
        },
      });
      return;
    }

    if (eventType === "StatusUpdate") {
      const usage = usageFromStatus(payload);
      if (usage) {
        notifyActivity({
          ...usage,
          ...(turnId ? { turnId } : {}),
        });
      }
      return;
    }

    if (eventType === "Notification") {
      notifyActivity({
        type: "notification",
        level:
          payload.severity === "error"
            ? "critical"
            : payload.severity === "warning"
              ? "warning"
              : "info",
        title: typeof payload.title === "string" ? payload.title : "Notification",
        body: typeof payload.body === "string" ? payload.body : "",
        ...(turnId ? { turnId } : {}),
      });
      return;
    }

    if (eventType === "PlanDisplay") {
      if (turnId && typeof payload.content === "string") {
        notifyActivity({
          type: "timeline_item",
          turnId,
          item: { kind: "plan", text: payload.content },
        });
      }
      return;
    }

    if (eventType === "ApprovalResponse") {
      notifyActivity({
        type: "permission_resolved",
        ...(turnId ? { turnId } : {}),
        resolution: {
          requestId: String(payload.request_id ?? ""),
          behavior: payload.response === "reject" ? "deny" : "allow",
          ...(typeof payload.response === "string" ? { decision: payload.response } : {}),
        },
      });
    }
  };

  const handleRemoteRequest = async (request: JsonRpcRequest) => {
    if (request.params.type === "ApprovalRequest") {
      pendingRequests.set(request.id, { kind: "approval" });
      notifyActivity({
        type: "permission_requested",
        ...(currentTurnId ? { turnId: currentTurnId } : {}),
        request: {
          id: request.id,
          kind: "tool",
          title:
            typeof request.params.payload.action === "string"
              ? request.params.payload.action
              : "Approval required",
          ...(typeof request.params.payload.description === "string"
            ? { description: request.params.payload.description }
            : {}),
          detail: {
            artifacts: [{ kind: "json", label: "approval", value: request.params.payload }],
          },
          actions: [
            { id: "approve", label: "Allow", behavior: "allow", variant: "primary" },
            {
              id: "approve_for_session",
              label: "Allow for session",
              behavior: "allow",
              variant: "secondary",
            },
            { id: "reject", label: "Reject", behavior: "deny", variant: "danger" },
          ],
        },
      });
      return;
    }
    if (request.params.type === "QuestionRequest") {
      const rawQuestions = Array.isArray(request.params.payload.questions)
        ? request.params.payload.questions
        : [];
      const questions = rawQuestions
        .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
        .map((entry) => entry as Record<string, unknown>)
        .map((entry, index) => ({
          id: `q${index}`,
          question: typeof entry.question === "string" ? entry.question : `Question ${index + 1}`,
          header: typeof entry.header === "string" ? entry.header : `Q${index + 1}`,
          options: Array.isArray(entry.options)
            ? entry.options
                .filter((option) => option && typeof option === "object" && !Array.isArray(option))
                .map((option) => option as Record<string, unknown>)
                .flatMap((option) =>
                  typeof option.label === "string"
                    ? [
                        {
                          label: option.label,
                          ...(typeof option.description === "string"
                            ? { description: option.description }
                            : {}),
                        },
                      ]
                    : [],
                )
            : [],
        }));
      pendingRequests.set(request.id, {
        kind: "question",
        questions: questions.map((question) => ({
          id: question.id,
          question: question.question,
        })),
      });
      notifyActivity({
        type: "permission_requested",
        ...(currentTurnId ? { turnId: currentTurnId } : {}),
        request: {
          id: request.id,
          kind: "question",
          title: "Question",
          input: {
            questions,
          },
        },
      });
      return;
    }
    remoteClient?.respondError(request.id, `Unsupported Kimi wire request: ${request.params.type}`);
  };

  const finishRemoteTurn = async (activity: ProviderActivity) => {
    if (remoteTurnFinalized) {
      return;
    }
    remoteTurnFinalized = true;
    notifyActivity(activity);
    notifyActivity({ type: "session_state", state: "idle" });
    currentTurnId = null;
    remoteTurnInFlight = false;
    remoteTurnCancelRequested = false;
    remoteTurnInterrupted = false;
    pendingRequests.clear();
    updatePromptState("prompt_clean");
    await remoteClient?.dispose().catch(() => undefined);
    remoteClient = null;
    syncHistoryCursorToEnd();
    if (remoteReclaimRequested) {
      startLocalNative();
      return;
    }
    renderRemoteModePanel();
    enableRemoteKeyboardControl();
  };

  const startRemoteTurn = async (queuedTurn: QueuedTurn) => {
    disableRemoteKeyboardControl();
    mode = "remote_writer";
    remotePromptText = queuedTurn.text;
    remoteReclaimRequested = false;
    remoteTurnInterrupted = false;
    remoteTurnCancelRequested = false;
    remoteTurnFinalized = false;
    remoteTurnInFlight = true;
    currentTurnId = randomUUID();
    remoteLatestToolCallId = null;
    remoteToolCalls.clear();
    pendingRequests.clear();
    updatePromptState("agent_busy");
    renderRemoteModePanel();
    emitUserInput(queuedTurn.text, currentTurnId);
    notifyActivity({ type: "session_state", state: "running" });

    try {
      remoteClient = await createKimiClient({
        providerSessionId,
        cwd: parsed.cwd,
        onEvent: (event: JsonRpcEvent) => {
          applyKimiEventPayload({
            eventType: event.params.type,
            payload: event.params.payload,
            source: "remote",
          });
        },
        onRequest: handleRemoteRequest,
      });
      if (remoteTurnCancelRequested) {
        void remoteClient.request("cancel", {}, JSON_RPC_TIMEOUT_MS).catch(() => undefined);
      }
      const result = await remoteClient.request(
        "prompt",
        { user_input: queuedTurn.text },
        PROMPT_TIMEOUT_MS,
      );
      const record =
        result && typeof result === "object" && !Array.isArray(result)
          ? (result as Record<string, unknown>)
          : {};
      const status = typeof record.status === "string" ? record.status : "finished";
      if (status === "finished") {
        await finishRemoteTurn({ type: "turn_completed", turnId: currentTurnId });
        return;
      }
      if (status === "cancelled" || status === "canceled") {
        await finishRemoteTurn({
          type: "turn_canceled",
          turnId: currentTurnId,
          reason: "cancelled",
        });
        return;
      }
      await finishRemoteTurn({
        type: "turn_failed",
        turnId: currentTurnId,
        error: status,
      });
    } catch (error) {
      const turnId = currentTurnId;
      await finishRemoteTurn(
        remoteTurnInterrupted && turnId
          ? {
              type: "turn_canceled",
              turnId,
              reason: "interrupted",
            }
          : {
              type: "turn_failed",
              turnId: turnId ?? randomUUID(),
              error: error instanceof Error ? error.message : String(error),
            },
      );
    }
  };

  const handlePermissionResolve = (requestId: string, response: PermissionResponseRequest) => {
    const pending = pendingRequests.get(requestId);
    if (!pending || !remoteClient) {
      return;
    }
    if (pending.kind === "approval") {
      remoteClient.respondSuccess(requestId, {
        request_id: requestId,
        response: approvalDecision(response),
        ...(response.message ? { feedback: response.message } : {}),
      });
      pendingRequests.delete(requestId);
      return;
    }
    const answers: Record<string, string> = {};
    for (const question of pending.questions) {
      const raw = response.answers?.[question.id];
      const value = raw?.answers?.filter((entry): entry is string => typeof entry === "string").join(", ");
      if (value) {
        answers[question.question] = value;
      }
    }
    remoteClient.respondSuccess(requestId, {
      request_id: requestId,
      answers,
    });
    pendingRequests.delete(requestId);
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
    await remoteClient?.dispose().catch(() => undefined);
    remoteClient = null;
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
      provider: "kimi",
      cwd: parsed.cwd,
      rootDir: parsed.cwd,
      terminalPid: process.pid,
      launchCommand: [
        "rah",
        "kimi",
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
      bindProviderSession();
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
      if (remoteTurnInFlight) {
        remoteTurnInterrupted = true;
        remoteTurnCancelRequested = true;
        renderRemoteModePanel();
        void remoteClient?.request("cancel", {}, JSON_RPC_TIMEOUT_MS).catch(() => undefined);
      }
      return;
    }
    if (message.type === "permission.resolve") {
      handlePermissionResolve(message.requestId, message.response);
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

  startLocalNative();

  while (!shouldExit && !exiting) {
    const record = boundRecord ?? findBoundRecord();
    if (record) {
      primeResumeHistoryCursor(record);
    }
    if (mode === "local_native" && wrapperSessionId && record) {
      const lines = readFileSync(record.wirePath, "utf8").split(/\r?\n/).filter(Boolean);
      const nextLines = lines.slice(processedLineCount);
      processedLineCount = lines.length;
      for (const line of nextLines) {
        const parsedLine = parseKimiWireLine(line);
        if (!parsedLine) {
          continue;
        }
        applyKimiEventPayload({
          eventType: parsedLine.type,
          payload: parsedLine.payload,
          source: "local",
        });
      }
    }
    await delay(250);
  }

  await cleanupAndExit();
}

void main().catch((error) => {
  process.stderr.write(`[rah] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
