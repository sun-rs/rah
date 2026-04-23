import type { ProviderActivity } from "./provider-activity";
import type { CodexStoredSessionRecord } from "./codex-stored-sessions";
import type { TerminalWrapperPromptState } from "./terminal-wrapper-control";

const SESSION_MATCH_WINDOW_MS = 2 * 60 * 1000;

export interface LocalTerminalPromptTracker {
  draftText: string;
}

const ANSI_ESCAPE_PATTERN =
  /(?:\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[0-?]*[ -/]*[@-~]|\u001b[@-_])/g;

function normalizeComparablePath(value: string): string {
  const resolved = value.trim().replace(/[\\/]+$/, "");
  if (resolved.startsWith("/private/")) {
    return resolved.slice("/private".length);
  }
  return resolved;
}

function timestampMs(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function selectCodexStoredSessionCandidate(params: {
  records: CodexStoredSessionRecord[];
  cwd: string;
  startupTimestampMs: number;
  resumeProviderSessionId?: string;
  updatedAfterMs?: number;
  allowWindowFallback?: boolean;
}): CodexStoredSessionRecord | null {
  if (params.resumeProviderSessionId) {
    return (
      params.records.find(
        (record) => record.ref.providerSessionId === params.resumeProviderSessionId,
      ) ?? null
    );
  }

  const normalizedCwd = normalizeComparablePath(params.cwd);
  const matchingCwd = params.records.filter(
    (record) =>
      (record.ref.cwd && normalizeComparablePath(record.ref.cwd) === normalizedCwd) ||
      (record.ref.rootDir && normalizeComparablePath(record.ref.rootDir) === normalizedCwd),
  );
  if (matchingCwd.length === 0) {
    return null;
  }

  if (params.updatedAfterMs !== undefined) {
    const updatedAfter = matchingCwd
      .filter((record) => timestampMs(record.ref.updatedAt) >= params.updatedAfterMs!)
      .sort((left, right) => timestampMs(right.ref.updatedAt) - timestampMs(left.ref.updatedAt));
    if (updatedAfter.length > 0) {
      return updatedAfter[0] ?? null;
    }
    if (!params.allowWindowFallback) {
      return null;
    }
  }

  const withinWindow = matchingCwd.filter((record) => {
    const updatedAtMs = timestampMs(record.ref.updatedAt);
    return Math.abs(updatedAtMs - params.startupTimestampMs) <= SESSION_MATCH_WINDOW_MS;
  });
  const ranked = (withinWindow.length > 0 ? withinWindow : matchingCwd).sort(
    (left, right) => timestampMs(right.ref.updatedAt) - timestampMs(left.ref.updatedAt),
  );
  return ranked[0] ?? null;
}

export function nextPromptStateFromActivity(
  current: TerminalWrapperPromptState,
  activity: ProviderActivity,
): TerminalWrapperPromptState {
  switch (activity.type) {
    case "turn_started":
    case "turn_step_started":
    case "runtime_status":
      if (
        activity.type === "runtime_status" &&
        !["thinking", "streaming", "retrying"].includes(activity.status)
      ) {
        return current;
      }
      return "agent_busy";
    case "turn_completed":
    case "turn_failed":
    case "turn_canceled":
    case "session_failed":
    case "session_exited":
      return "prompt_clean";
    default:
      return current;
  }
}

function isPrintableInput(char: string): boolean {
  return char >= " " && char !== "\u007f";
}

export function applyLocalTerminalInput(params: {
  tracker: LocalTerminalPromptTracker;
  promptState: TerminalWrapperPromptState;
  data: string;
}): TerminalWrapperPromptState {
  if (params.promptState === "agent_busy") {
    params.tracker.draftText = "";
    return "agent_busy";
  }

  if (params.data.includes("\u001b")) {
    return params.tracker.draftText.length > 0 ? "prompt_dirty" : params.promptState;
  }

  for (const char of params.data) {
    if (char === "\r" || char === "\n") {
      if (params.tracker.draftText.length > 0) {
        params.tracker.draftText = "";
        return "agent_busy";
      }
      continue;
    }

    if (char === "\u007f" || char === "\b") {
      params.tracker.draftText = params.tracker.draftText.slice(
        0,
        Math.max(0, params.tracker.draftText.length - 1),
      );
      continue;
    }

    if (char === "\u0015" || char === "\u0003") {
      params.tracker.draftText = "";
      continue;
    }

    if (isPrintableInput(char)) {
      params.tracker.draftText += char;
    }
  }

  return params.tracker.draftText.length > 0 ? "prompt_dirty" : "prompt_clean";
}

export function sliceUnprocessedRolloutLines(
  content: string,
  processedLineCount: number,
): { lines: string[]; nextProcessedLineCount: number } {
  const allLines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const lines = allLines.slice(processedLineCount);
  return {
    lines,
    nextProcessedLineCount: allLines.length,
  };
}

export function extractCodexTerminalSessionId(output: string): string | null {
  const stripped = output.replace(ANSI_ESCAPE_PATTERN, "");
  const match = /Session:\s+([0-9a-f]{8}-[0-9a-f-]{27,})/i.exec(stripped);
  return match?.[1] ?? null;
}

export function hasCodexTerminalPrompt(output: string): boolean {
  const stripped = output.replace(ANSI_ESCAPE_PATTERN, "").replace(/\r/g, "\n");
  const lines = stripped.split("\n");
  while (lines.length > 0 && !lines.at(-1)?.trim()) {
    lines.pop();
  }
  const tail = lines.at(-1) ?? "";
  return /^[ \t]*›\s*$/u.test(tail);
}
