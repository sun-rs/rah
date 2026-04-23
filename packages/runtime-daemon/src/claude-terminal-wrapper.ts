import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import type { ContextUsage, TimelineItem } from "@rah/runtime-protocol";
import type { ProviderActivity } from "./provider-activity";
import type { TerminalWrapperPromptState } from "./terminal-wrapper-control";
import {
  findClaudeStoredSessionRecord,
  type ClaudeStoredSessionRecord,
} from "./claude-session-files";
import {
  createIsolatedClaudeWrapperHome,
  resolveClaudeBaseHome,
} from "./claude-wrapper-home";
import { IndependentTerminalProcess } from "./independent-terminal";

type ClaudeRawRecord =
  | {
      type: "user";
      uuid: string;
      timestamp?: string;
      cwd?: string;
      sessionId?: string;
      message: {
        role?: string;
        content: unknown;
      };
    }
  | {
      type: "assistant";
      uuid: string;
      timestamp?: string;
      cwd?: string;
      sessionId?: string;
      message?: {
        id?: string;
        role?: string;
        content: unknown;
        stop_reason?: string | null;
        usage?: {
          input_tokens?: number;
          cache_creation_input_tokens?: number;
          cache_read_input_tokens?: number;
          output_tokens?: number;
        };
      };
    }
  | {
      type: "system";
      uuid: string;
      subtype?: string;
      timestamp?: string;
      cwd?: string;
      sessionId?: string;
      error?: unknown;
    };

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

async function resolveClaudeBinary(): Promise<string> {
  return process.env.RAH_CLAUDE_BINARY ?? "claude";
}

function normalizeComparablePath(value: string): string {
  const resolved = value.trim().replace(/[\\/]+$/, "");
  if (resolved.startsWith("/private/")) {
    return resolved.slice("/private".length);
  }
  return resolved;
}

function extractTextParts(content: unknown): string[] {
  if (typeof content === "string") {
    const normalized = content.trim();
    return normalized ? [normalized] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object" || Array.isArray(block)) {
      continue;
    }
    const record = block as Record<string, unknown>;
    if (typeof record.text === "string" && record.text.trim()) {
      parts.push(record.text.trim());
    }
  }
  return parts;
}

function isToolResultOnlyContent(content: unknown): boolean {
  if (!Array.isArray(content) || content.length === 0) {
    return false;
  }
  return content.every(
    (block) =>
      block &&
      typeof block === "object" &&
      !Array.isArray(block) &&
      (block as Record<string, unknown>).type === "tool_result",
  );
}

function extractUserMessageText(content: unknown): string | null {
  if (isToolResultOnlyContent(content)) {
    return null;
  }
  const text = extractTextParts(content).join("\n").trim();
  return text || null;
}

function extractAssistantMessageText(content: unknown): string | null {
  const text = extractTextParts(content).join("\n").trim();
  return text || null;
}

function safeParseClaudeRecord(line: string): ClaudeRawRecord | null {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (parsed.type === "user" && typeof parsed.uuid === "string" && parsed.message) {
      return parsed as ClaudeRawRecord;
    }
    if (parsed.type === "assistant" && typeof parsed.uuid === "string") {
      return parsed as ClaudeRawRecord;
    }
    if (parsed.type === "system" && typeof parsed.uuid === "string") {
      return parsed as ClaudeRawRecord;
    }
    return null;
  } catch {
    return null;
  }
}

function usageFromAssistant(record: Extract<ClaudeRawRecord, { type: "assistant" }>): ContextUsage | undefined {
  const usage = record.message?.usage;
  if (!usage) {
    return undefined;
  }
  return {
    ...(typeof usage.input_tokens === "number" ? { inputTokens: usage.input_tokens } : {}),
    ...(typeof usage.cache_creation_input_tokens === "number"
      ? { cachedInputTokens: usage.cache_creation_input_tokens }
      : typeof usage.cache_read_input_tokens === "number"
        ? { cachedInputTokens: usage.cache_read_input_tokens }
        : {}),
    ...(typeof usage.output_tokens === "number" ? { outputTokens: usage.output_tokens } : {}),
  };
}

function toolActivitiesFromAssistantRecord(
  record: Extract<ClaudeRawRecord, { type: "assistant" }>,
  turnId?: string,
): ProviderActivity[] {
  const content = Array.isArray(record.message?.content) ? record.message.content : [];
  const activities: ProviderActivity[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object" || Array.isArray(block)) {
      continue;
    }
    const typedBlock = block as Record<string, unknown>;
    if (typedBlock.type !== "tool_use") {
      continue;
    }
    activities.push({
      type: "tool_call_completed",
      ...(turnId ? { turnId } : {}),
      toolCall: {
        id: typeof typedBlock.id === "string" ? typedBlock.id : `claude-tool-${randomUUID()}`,
        family: "other",
        providerToolName:
          typeof typedBlock.name === "string" ? typedBlock.name : "unknown",
        title: typeof typedBlock.name === "string" ? typedBlock.name : "unknown",
        ...(typedBlock.input &&
        typeof typedBlock.input === "object" &&
        !Array.isArray(typedBlock.input)
          ? { input: typedBlock.input as Record<string, unknown> }
          : {}),
      },
    });
  }
  return activities;
}

async function injectRemoteTurnIntoTerminal(
  terminal: IndependentTerminalProcess,
  text: string,
): Promise<void> {
  terminal.write(text);
  await delay(25);
  terminal.write("\r\n");
}

function sliceUnprocessedLines(
  content: string,
  processedLineCount: number,
): { lines: string[]; nextProcessedLineCount: number } {
  const allLines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return {
    lines: allLines.slice(processedLineCount),
    nextProcessedLineCount: allLines.length,
  };
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

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const baseClaudeHome = resolveClaudeBaseHome();
  const logger = createWrapperLogger("claude");
  const forcedProviderSessionId = parsed.resumeProviderSessionId ?? randomUUID();
  const wrapperClaudeHome = parsed.resumeProviderSessionId
    ? null
    : createIsolatedClaudeWrapperHome(baseClaudeHome);
  if (wrapperClaudeHome) {
    process.env.CLAUDE_CONFIG_DIR = wrapperClaudeHome;
    logger.log(`[rah] isolated claude home: ${wrapperClaudeHome}`);
  }

  let processedLineCount = 0;
  let wrapperSessionId: string | null = null;
  let boundRecord: ClaudeStoredSessionRecord | null = null;
  let promptState: TerminalWrapperPromptState = "prompt_dirty";
  let childExited = false;
  let childExitCode = 0;
  let childExitSignal: string | null = null;
  let exiting = false;
  let currentTurnId: string | null = null;
  let awaitingTurnStart = false;
  let promptReadyTimer: NodeJS.Timeout | null = null;
  let draftText = "";

  const binary = await resolveClaudeBinary();
  const claudeArgs = parsed.resumeProviderSessionId
    ? ["--resume", parsed.resumeProviderSessionId]
    : ["--session-id", forcedProviderSessionId];

  const terminal = new IndependentTerminalProcess({
    cwd: parsed.cwd,
    command: binary,
    args: claudeArgs,
    env: {
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? baseClaudeHome,
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
      `[rah] failed to launch claude terminal: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const socket = new WebSocket(wrapperControlUrl(parsed.daemonUrl));

  const send = (message: unknown) => {
    socket.send(JSON.stringify(message));
  };

  const updatePromptState = (nextState: TerminalWrapperPromptState) => {
    if (!wrapperSessionId || nextState === promptState) {
      return;
    }
    if (nextState === "prompt_clean") {
      draftText = "";
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
    const nextRecord = record ?? findClaudeStoredSessionRecord(forcedProviderSessionId, parsed.cwd) ?? null;
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

  const armPromptReadyTimer = (delayMs = 1200) => {
    if (!wrapperSessionId || childExited || awaitingTurnStart || currentTurnId || draftText) {
      return;
    }
    if (promptReadyTimer) {
      clearTimeout(promptReadyTimer);
    }
    promptReadyTimer = setTimeout(() => {
      promptReadyTimer = null;
      if (!awaitingTurnStart && !currentTurnId && !draftText) {
        updatePromptState("prompt_clean");
      }
    }, delayMs);
    promptReadyTimer.unref();
  };

  const onTerminalInput = (chunk: Buffer | string) => {
    const data = chunk.toString();
    terminal.write(data);
    if (promptState === "agent_busy") {
      draftText = "";
      return;
    }
    for (const char of data) {
      if (char === "\r" || char === "\n") {
        if (draftText.length > 0) {
          draftText = "";
          awaitingTurnStart = true;
          if (promptReadyTimer) {
            clearTimeout(promptReadyTimer);
            promptReadyTimer = null;
          }
          updatePromptState("agent_busy");
        }
        continue;
      }
      if (char === "\u007f" || char === "\b") {
        draftText = draftText.slice(0, Math.max(0, draftText.length - 1));
        continue;
      }
      if (char === "\u0015" || char === "\u0003") {
        draftText = "";
        continue;
      }
      if (char >= " " && char !== "\u007f") {
        draftText += char;
      }
    }
    updatePromptState(draftText.length > 0 ? "prompt_dirty" : "prompt_clean");
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
    logger.log("[rah] wrapper control connected");
    send({
      type: "wrapper.hello",
      provider: "claude",
      cwd: parsed.cwd,
      rootDir: parsed.cwd,
      terminalPid: process.pid,
      launchCommand: ["rah", "claude", ...claudeArgs],
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
      armPromptReadyTimer();
      return;
    }
    if (message.type === "turn.inject") {
      void injectRemoteTurnIntoTerminal(terminal, message.queuedTurn.text);
      draftText = "";
      awaitingTurnStart = true;
      if (promptReadyTimer) {
        clearTimeout(promptReadyTimer);
        promptReadyTimer = null;
      }
      updatePromptState("agent_busy");
      return;
    }
    if (message.type === "turn.enqueue") {
      logger.log(`[rah] remote turn queued: ${message.queuedTurn.text}`);
      return;
    }
    if (message.type === "turn.interrupt") {
      terminal.write("\u0003");
      return;
    }
    if (message.type === "permission.resolve") {
      logger.log(
        `[rah] remote permission resolution is not wired for claude wrapper yet: ${message.requestId}`,
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
    const latestRecord = findClaudeStoredSessionRecord(forcedProviderSessionId, parsed.cwd);
    if (latestRecord) {
      syncProviderBinding(latestRecord);
    }

    const activeBoundRecord = boundRecord as ClaudeStoredSessionRecord | null;
    if (wrapperSessionId && activeBoundRecord !== null) {
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
          currentTurnId = record.uuid;
          awaitingTurnStart = false;
          updatePromptState("agent_busy");
          const turnStarted: ProviderActivity = {
            type: "turn_started",
            turnId: record.uuid,
          };
          const timeline: ProviderActivity = {
            type: "timeline_item",
            turnId: record.uuid,
            item: {
              kind: "user_message",
              text,
              messageId: record.uuid,
            } satisfies TimelineItem,
          };
          send({
            type: "wrapper.activity",
            sessionId: wrapperSessionId,
            activity: turnStarted,
          });
          send({
            type: "wrapper.activity",
            sessionId: wrapperSessionId,
            activity: timeline,
          });
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
            awaitingTurnStart = false;
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
          } else if (record.message.stop_reason === "tool_use") {
            updatePromptState("agent_busy");
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
          send({
            type: "wrapper.activity",
            sessionId: wrapperSessionId,
            activity: {
              type: "session_failed",
              error,
            },
          });
          currentTurnId = null;
          awaitingTurnStart = false;
        }
      }
    }

    await delay(250);
  }

  logger.log("[rah] claude terminal wrapper exiting");
  await cleanupAndExit();
}

void main();
