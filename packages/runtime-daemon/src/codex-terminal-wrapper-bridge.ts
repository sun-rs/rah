import type { CodexStoredSessionRecord } from "./codex-stored-sessions";

const SESSION_MATCH_WINDOW_MS = 2 * 60 * 1000;

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

export function readPersistedTaskLifecycle(line: unknown):
  | { kind: "started"; turnId: string; ts?: string }
  | { kind: "completed"; turnId: string; ts?: string }
  | { kind: "canceled"; turnId: string; ts?: string }
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
  const ts = typeof record.timestamp === "string" ? record.timestamp : undefined;
  if (payload.type === "task_started") {
    return { kind: "started", turnId: payload.turn_id, ...(ts ? { ts } : {}) };
  }
  if (payload.type === "task_complete") {
    return { kind: "completed", turnId: payload.turn_id, ...(ts ? { ts } : {}) };
  }
  if (payload.type === "turn_aborted") {
    return { kind: "canceled", turnId: payload.turn_id, ...(ts ? { ts } : {}) };
  }
  return null;
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
