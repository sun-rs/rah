import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import type { TimelineItem } from "@rah/runtime-protocol";
import type { ProviderActivity } from "./provider-activity";
import type { QueuedTurn, TerminalWrapperPromptState } from "./terminal-wrapper-control";
import {
  findClaudeStoredSessionRecord,
  type ClaudeStoredSessionRecord,
} from "./claude-session-files";
import {
  resolveClaudeBaseHome,
} from "./claude-wrapper-home";
import { NativeTerminalProcess } from "./native-terminal-process";
import {
  extractAssistantMessageText,
  extractUserMessageText,
  safeParseClaudeRecord,
  sliceUnprocessedLines,
  toolActivitiesFromAssistantRecord,
  type ClaudeRawRecord,
  usageFromAssistant,
} from "./claude-terminal-wrapper-history";
import {
  clearTerminalScreen,
  enterAlternateScreen,
  leaveAlternateScreen,
  renderTerminalWrapperPanel,
  renderTerminalWrapperPanelForTerminal,
  restoreInheritedTerminalModes,
} from "./terminal-wrapper-panel";
import { deriveTerminalWrapperRemoteControlState } from "./terminal-wrapper-remote-control";
import { resolveConfiguredBinary } from "./provider-binary-utils";

type WrapperMode = "local_native" | "remote_writer";

function parseArgs(argv: string[]) {
  let daemonUrl = "http://127.0.0.1:43111";
  let cwd = process.cwd();
  let resumeProviderSessionId: string | undefined;
  let permissionMode: string | undefined;

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
    if (arg === "--permission-mode") {
      const value = rest.shift();
      if (!value || !CLAUDE_REMOTE_PERMISSION_MODES.has(value)) {
        throw new Error(`Unsupported Claude permission mode: ${value ?? "<missing>"}`);
      }
      permissionMode = value;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    daemonUrl,
    cwd,
    ...(resumeProviderSessionId ? { resumeProviderSessionId } : {}),
    ...(permissionMode ? { permissionMode } : {}),
  };
}

function wrapperControlUrl(daemonUrl: string): string {
  const url = new URL(daemonUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/api/wrapper-control";
  url.search = "";
  return url.toString();
}

async function resolveClaudeBinary(): Promise<string> {
  return await resolveConfiguredBinary("RAH_CLAUDE_BINARY", "claude");
}

const CLAUDE_REMOTE_PERMISSION_MODES = new Set([
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "default",
  "plan",
]);

function resolveClaudeHandoffPermissionMode(cliPermissionMode?: string): string {
  const value = cliPermissionMode ?? process.env.RAH_CLAUDE_REMOTE_PERMISSION_MODE?.trim();
  if (value && CLAUDE_REMOTE_PERMISSION_MODES.has(value)) {
    return value;
  }
  return "bypassPermissions";
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

function buildClaudeRemotePrintArgs(args: {
  providerSessionId: string;
  text: string;
  hasPersistedSession: boolean;
  permissionMode: string;
}): string[] {
  return [
    "--print",
    "--permission-mode",
    args.permissionMode,
    ...(args.hasPersistedSession
      ? ["--resume", args.providerSessionId]
      : ["--session-id", args.providerSessionId]),
    args.text,
  ];
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const baseClaudeHome = resolveClaudeBaseHome();
  const logger = createWrapperLogger("claude");
  const forcedProviderSessionId = parsed.resumeProviderSessionId ?? randomUUID();
  const handoffPermissionMode = resolveClaudeHandoffPermissionMode(parsed.permissionMode);
  process.env.CLAUDE_CONFIG_DIR = baseClaudeHome;
  logger.log(`[rah] using native claude home: ${baseClaudeHome}`);
  logger.log(`[rah] claude handoff permission mode: ${handoffPermissionMode}`);

  let processedLineCount = 0;
  let wrapperSessionId: string | null = null;
  let boundRecord: ClaudeStoredSessionRecord | null = null;
  let promptState: TerminalWrapperPromptState = "prompt_dirty";
  let currentTurnId: string | null = null;
  let exiting = false;
  let shouldExit = false;
  let mode: WrapperMode = "local_native";
  let localTerminal: NativeTerminalProcess | null = null;
  let localExitCode = 0;
  let localExitSignal: string | null = null;
  let pendingRemoteTurn: QueuedTurn | null = null;
  let remoteTurnProcess: ChildProcess | null = null;
  let remoteKeyboardHandler: ((chunk: Buffer | string) => void) | null = null;
  let remotePromptText: string | null = null;
  let lastRenderedRemotePanel: string | null = null;
  let remoteReclaimRequested = false;
  let remotePanelActive = false;
  let historyCursorPrimed = parsed.resumeProviderSessionId === undefined;
  let remoteTurnInterrupted = false;
  let remoteTurnCancelRequested = false;
  let interruptedRemotePromptText: string | null = null;
  let restartLocalAfterCanceledPendingTurn = false;
  let socketErrored = false;

  const getRemoteControlState = () =>
    deriveTerminalWrapperRemoteControlState({
      providerLabel: "Claude",
      hasPendingTurn: pendingRemoteTurn !== null,
      hasActiveTurn: remoteTurnProcess !== null || currentTurnId !== null,
      promptState,
      cancelRequested: remoteTurnCancelRequested,
      reclaimRequested: remoteReclaimRequested,
    });

  const binary = await resolveClaudeBinary();
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

  const primeResumeHistoryCursor = (record: ClaudeStoredSessionRecord) => {
    if (historyCursorPrimed || parsed.resumeProviderSessionId === undefined) {
      return;
    }
    try {
      const content = readFileSync(record.filePath, "utf8");
      processedLineCount = sliceUnprocessedLines(content, 0).nextProcessedLineCount;
      historyCursorPrimed = true;
      logger.log(
        `[rah] primed resume history cursor at line ${processedLineCount} for ${forcedProviderSessionId}`,
      );
    } catch (error) {
      logger.log(
        `[rah] failed to prime resume history cursor for ${forcedProviderSessionId}: ${String(error)}`,
      );
    }
  };

  const renderRemoteModePanel = () => {
    if (mode !== "remote_writer" || exiting) {
      lastRenderedRemotePanel = null;
      return;
    }
    const question = remotePromptText ?? pendingRemoteTurn?.text ?? "";
    const remoteControl = getRemoteControlState();
    const panelLines = renderTerminalWrapperPanel({
      title: "RAH Claude Remote Control",
      status: remoteControl.status,
      statusTone: remoteControl.tone,
      sessionId: forcedProviderSessionId,
      prompt: question || "No active web prompt.",
      footer: remoteControl.footer,
      footerTone: remoteControl.tone,
    });
    if (panelLines === lastRenderedRemotePanel) {
      return;
    }
    lastRenderedRemotePanel = panelLines;
    ensureRemotePanelScreen();
    clearTerminalScreen();
    process.stdout.write(
      `${renderTerminalWrapperPanelForTerminal({
        title: "RAH Claude Remote Control",
        status: remoteControl.status,
        statusTone: remoteControl.tone,
        sessionId: forcedProviderSessionId,
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

  const syncProviderBinding = (record?: ClaudeStoredSessionRecord | null) => {
    if (!wrapperSessionId) {
      return;
    }
    const hadBoundRecord = boundRecord !== null;
    const nextRecord =
      record ?? findClaudeStoredSessionRecord(forcedProviderSessionId, parsed.cwd) ?? null;
    const metadataChanged =
      nextRecord !== null &&
      (boundRecord?.filePath !== nextRecord.filePath ||
        boundRecord?.ref.title !== nextRecord.ref.title ||
        boundRecord?.ref.preview !== nextRecord.ref.preview);
    if (boundRecord && !metadataChanged) {
      return;
    }
    boundRecord = nextRecord;
    send({
      type: "wrapper.provider_bound",
      sessionId: wrapperSessionId,
      providerSessionId: forcedProviderSessionId,
      ...(nextRecord?.ref.title
        ? { providerTitle: nextRecord.ref.title }
        : { providerTitle: forcedProviderSessionId }),
      ...(nextRecord?.ref.preview
        ? { providerPreview: nextRecord.ref.preview }
        : { providerPreview: forcedProviderSessionId }),
      reason: hadBoundRecord ? "switch" : "initial",
    });
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
    interruptedRemotePromptText = null;
    updatePromptState("prompt_clean");
    restoreMainTerminalScreen();
    const claudeArgs = parsed.resumeProviderSessionId || boundRecord
      ? ["--permission-mode", handoffPermissionMode, "--resume", forcedProviderSessionId]
      : ["--permission-mode", handoffPermissionMode, "--session-id", forcedProviderSessionId];
    localTerminal = new NativeTerminalProcess({
      cwd: parsed.cwd,
      command: binary,
      args: claudeArgs,
      env: {
        CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? baseClaudeHome,
      },
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
    logger.log(`[rah] local native claude started (${claudeArgs.join(" ")})`);
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

  const startRemoteTurn = async (queuedTurn: QueuedTurn) => {
    disableRemoteKeyboardControl();
    mode = "remote_writer";
    remoteReclaimRequested = false;
    remoteTurnInterrupted = false;
    remoteTurnCancelRequested = false;
    interruptedRemotePromptText = null;
    remotePromptText = queuedTurn.text;
    updatePromptState("agent_busy");
    renderRemoteModePanel();
    const args = buildClaudeRemotePrintArgs({
      providerSessionId: forcedProviderSessionId,
      text: queuedTurn.text,
      hasPersistedSession: boundRecord !== null || parsed.resumeProviderSessionId !== undefined,
      permissionMode: handoffPermissionMode,
    });
    logger.log(
      `[rah] remote print turn start ${queuedTurn.queuedTurnId} permissionMode=${handoffPermissionMode}`,
    );
    const child = spawn(binary, args, {
      cwd: parsed.cwd,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? baseClaudeHome,
      },
      stdio: ["ignore", "ignore", "pipe"],
      shell: false,
    });
    remoteTurnProcess = child;
    renderRemoteModePanel();
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) {
        logger.log(`[rah] remote stderr ${text}`);
      }
    });
    child.on("exit", (exitCode, signal) => {
      logger.log(
        `[rah] remote print turn exit ${queuedTurn.queuedTurnId} code=${exitCode ?? "null"} signal=${signal ?? "null"}`,
      );
      remoteTurnProcess = null;
      if (!exiting) {
        const wasInterrupted = remoteTurnInterrupted;
        remoteTurnInterrupted = false;
        remoteTurnCancelRequested = false;
        if (wrapperSessionId && wasInterrupted && currentTurnId) {
          const canceledTurnId = currentTurnId;
          currentTurnId = null;
          send({
            type: "wrapper.activity",
            sessionId: wrapperSessionId,
            activity: {
              type: "turn_canceled",
              turnId: canceledTurnId,
              reason: "interrupted",
            },
          });
        } else if (wasInterrupted) {
          interruptedRemotePromptText = queuedTurn.text;
        }
        if (!currentTurnId) {
          updatePromptState("prompt_clean");
        }
        if (remoteReclaimRequested) {
          logger.log("[rah] remote turn finished; restoring local control");
          startLocalNative();
          return;
        }
        renderRemoteModePanel();
        enableRemoteKeyboardControl();
      }
    });
  };

  socket.on("open", () => {
    logger.log("[rah] wrapper control connected");
    send({
      type: "wrapper.hello",
      provider: "claude",
      cwd: parsed.cwd,
      rootDir: parsed.cwd,
      terminalPid: process.pid,
      launchCommand: [
        "rah",
        "claude",
        ...(parsed.resumeProviderSessionId ? ["resume", parsed.resumeProviderSessionId] : []),
        "--permission-mode",
        handoffPermissionMode,
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
      syncProviderBinding();
      updatePromptState("prompt_clean");
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
      logger.log(`[rah] remote turn queued: ${message.queuedTurn.text}`);
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
        interruptedRemotePromptText = null;
        updatePromptState("prompt_clean");
        if (mode === "remote_writer") {
          renderRemoteModePanel();
          enableRemoteKeyboardControl();
        }
        return;
      }
      if (mode === "local_native") {
        logger.log("[rah] ignoring remote interrupt while terminal holds local control");
        return;
      }
      if (remoteTurnProcess && remoteTurnProcess.exitCode === null && !remoteTurnProcess.killed) {
        remoteTurnInterrupted = true;
        remoteTurnCancelRequested = true;
        renderRemoteModePanel();
        remoteTurnProcess.kill("SIGINT");
        setTimeout(() => {
          if (remoteTurnProcess && remoteTurnProcess.exitCode === null && !remoteTurnProcess.killed) {
            remoteTurnProcess.kill("SIGTERM");
          }
        }, 250).unref();
      }
      return;
    }
    if (message.type === "permission.resolve") {
      logger.log(
        `[rah] remote permission resolution is not wired for hapi-like claude wrapper yet: ${message.requestId}`,
      );
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
    disableRemoteKeyboardControl();
    restoreMainTerminalScreen();
    restoreInheritedTerminalModes();
    if (localTerminal) {
      await localTerminal.close("SIGTERM").catch(() => undefined);
      localTerminal = null;
    }
    if (remoteTurnProcess && remoteTurnProcess.exitCode === null && !remoteTurnProcess.killed) {
      remoteTurnProcess.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (remoteTurnProcess && remoteTurnProcess.exitCode === null && !remoteTurnProcess.killed) {
            remoteTurnProcess.kill("SIGKILL");
          }
        }, 2_000);
        remoteTurnProcess?.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
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

  socket.on("error", (error) => {
    if (socketErrored) {
      return;
    }
    socketErrored = true;
    logger.log(
      `[rah] wrapper control socket error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.stderr.write(
      `[rah] could not connect to RAH daemon at ${parsed.daemonUrl}. Start the daemon and try again.\n`,
    );
    void cleanupAndExit().finally(() => {
      shouldExit = true;
      process.exitCode = 1;
    });
  });

  socket.on("close", () => {
    if (socketErrored || exiting || shouldExit) {
      return;
    }
    process.stderr.write("[rah] wrapper control channel closed\n");
    shouldExit = true;
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
    const latestRecord = findClaudeStoredSessionRecord(forcedProviderSessionId, parsed.cwd);
    if (latestRecord) {
      syncProviderBinding(latestRecord);
      primeResumeHistoryCursor(latestRecord);
    }

    const activeBoundRecord = boundRecord as ClaudeStoredSessionRecord | null;
    if (wrapperSessionId && activeBoundRecord) {
      const content = readFileSync(
        (activeBoundRecord as ClaudeStoredSessionRecord).filePath,
        "utf8",
      );
      const window = sliceUnprocessedLines(content, processedLineCount);
      processedLineCount = window.nextProcessedLineCount;
      for (const line of window.lines) {
        const record = safeParseClaudeRecord(line);
        if (!record) {
          continue;
        }
        if (record.type === "user") {
          const text = extractUserMessageText(record.message.content);
          if (!text) {
            continue;
          }
          if (
            interruptedRemotePromptText !== null &&
            text === interruptedRemotePromptText &&
            !currentTurnId
          ) {
            const canceledTurnId = record.uuid;
            interruptedRemotePromptText = null;
            send({
              type: "wrapper.activity",
              sessionId: wrapperSessionId,
              activity: {
                type: "turn_started",
                turnId: canceledTurnId,
              },
            });
            send({
              type: "wrapper.activity",
              sessionId: wrapperSessionId,
              activity: {
                type: "timeline_item",
                turnId: canceledTurnId,
                item: {
                  kind: "user_message",
                  text,
                  messageId: record.uuid,
                } satisfies TimelineItem,
              },
            });
            send({
              type: "wrapper.activity",
              sessionId: wrapperSessionId,
              activity: {
                type: "turn_canceled",
                turnId: canceledTurnId,
                reason: "interrupted",
              },
            });
            updatePromptState("prompt_clean");
            renderRemoteModePanel();
            enableRemoteKeyboardControl();
            continue;
          }
          currentTurnId = record.uuid;
          updatePromptState("agent_busy");
          send({
            type: "wrapper.activity",
            sessionId: wrapperSessionId,
            activity: {
              type: "turn_started",
              turnId: record.uuid,
            },
          });
          send({
            type: "wrapper.activity",
            sessionId: wrapperSessionId,
            activity: {
              type: "timeline_item",
              turnId: record.uuid,
              item: {
                kind: "user_message",
                text,
                messageId: record.uuid,
              } satisfies TimelineItem,
            },
          });
          renderRemoteModePanel();
          continue;
        }

        if (record.type === "assistant" && record.message) {
          for (const activity of toolActivitiesFromAssistantRecord(record, currentTurnId ?? undefined)) {
            send({
              type: "wrapper.activity",
              sessionId: wrapperSessionId,
              activity,
            });
          }
          const text = extractAssistantMessageText(record.message.content);
          if (text) {
            send({
              type: "wrapper.activity",
              sessionId: wrapperSessionId,
              activity: {
                type: "timeline_item",
                ...(currentTurnId ? { turnId: currentTurnId } : {}),
                item: {
                  kind: "assistant_message",
                  text,
                  ...(typeof record.message.id === "string" ? { messageId: record.message.id } : {}),
                } satisfies TimelineItem,
              },
            });
          }
          if (record.message.stop_reason === "end_turn") {
            const completedTurnId = currentTurnId;
            currentTurnId = null;
            if (completedTurnId) {
              send({
                type: "wrapper.activity",
                sessionId: wrapperSessionId,
                activity: {
                  type: "turn_completed",
                  turnId: completedTurnId,
                  ...(usageFromAssistant(record) ? { usage: usageFromAssistant(record) } : {}),
                },
              });
            }
            updatePromptState("prompt_clean");
            renderRemoteModePanel();
            enableRemoteKeyboardControl();
          } else if (record.message.stop_reason === "tool_use") {
            updatePromptState("agent_busy");
            renderRemoteModePanel();
          }
          continue;
        }

        if (record.type === "system" && record.subtype === "api_error") {
          const error =
            typeof record.error === "string"
              ? record.error
              : typeof record.error === "object" && record.error !== null
                ? JSON.stringify(record.error)
                : "Unknown Claude error";
          send({
            type: "wrapper.activity",
            sessionId: wrapperSessionId,
            activity: {
              type: "notification",
              ...(currentTurnId ? { turnId: currentTurnId } : {}),
              level: "critical",
              title: "Claude API error",
              body: error,
            },
          });
          const failedTurnId = currentTurnId;
          currentTurnId = null;
          if (wrapperSessionId && failedTurnId) {
            send({
              type: "wrapper.activity",
              sessionId: wrapperSessionId,
              activity: {
                type: "turn_failed",
                turnId: failedTurnId,
                error,
              },
            });
          }
          updatePromptState("prompt_clean");
          renderRemoteModePanel();
          enableRemoteKeyboardControl();
        }
      }
    }

    await delay(250);
  }

  logger.log("[rah] claude terminal wrapper exiting");
  await cleanupAndExit();
  process.exitCode = localExitCode;
}

void main().catch((error) => {
  process.stderr.write(`[rah] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
