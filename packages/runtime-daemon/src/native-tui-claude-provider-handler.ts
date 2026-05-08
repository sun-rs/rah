import {
  createClaudeStoredActivityState,
  discoverClaudeStoredSessions,
  readClaudeStoredSessionActivityBatch,
} from "./claude-session-files";
import {
  sameNativeTuiDirectory,
} from "./native-tui-provider-handler-utils";
import type {
  NativeTuiOutputObservation,
  NativeTuiMirrorUpdate,
  NativeTuiProviderHandler,
  NativeTuiProviderMirror,
  NativeTuiProviderRuntimeSession,
} from "./native-tui-provider-runtime-types";

const ANSI_ESCAPE_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;

function hasClaudePrompt(output: string): boolean {
  const stripped = output.replace(ANSI_ESCAPE_PATTERN, "").replace(/\r/g, "\n");
  const lines = stripped
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.slice(-12).some((line) =>
    /^(?:›|❯|>)\s*$/u.test(line) ||
    /bypass permissions/i.test(line),
  );
}

function selectClaudeBindingRecord(session: NativeTuiProviderRuntimeSession) {
  const records = discoverClaudeStoredSessions(session.cwd);
  const byProviderSessionId = session.providerSessionId
    ? records.find((candidate) => candidate.ref.providerSessionId === session.providerSessionId) ??
      discoverClaudeStoredSessions().find(
        (candidate) => candidate.ref.providerSessionId === session.providerSessionId,
      )
    : undefined;
  if (byProviderSessionId) {
    return byProviderSessionId;
  }
  return records
    .filter((record) =>
      sameNativeTuiDirectory(record.ref.cwd ?? record.ref.rootDir, session.cwd),
    )
    .filter((record) => {
      const updatedAt = Date.parse(record.ref.updatedAt ?? "");
      return Number.isFinite(updatedAt) && updatedAt >= session.startupTimestampMs - 5_000;
    })
    .sort((left, right) =>
      (right.ref.updatedAt ?? "").localeCompare(left.ref.updatedAt ?? ""),
    )[0];
}

function observeClaudeOutput(
  _session: NativeTuiProviderRuntimeSession,
  data: string,
): NativeTuiOutputObservation {
  return {
    promptClean: hasClaudePrompt(data),
    binding: null,
  };
}

function probeClaudeBinding(session: NativeTuiProviderRuntimeSession) {
  const record = selectClaudeBindingRecord(session);
  if (!record) {
    return null;
  }
  return {
    providerSessionId: record.ref.providerSessionId,
    record,
  };
}

function updateClaudeMirror(
  session: NativeTuiProviderRuntimeSession,
  mirror: NativeTuiProviderMirror | undefined,
): NativeTuiMirrorUpdate {
  if (mirror?.provider !== "claude") {
    const record = selectClaudeBindingRecord(session);
    if (!record) {
      return { status: "missing" };
    }
    mirror = {
      provider: "claude",
      providerSessionId: record.ref.providerSessionId,
      record,
      activityState: createClaudeStoredActivityState(),
    };
  }

  try {
    return {
      status: "ok",
      mirror,
      items: readClaudeStoredSessionActivityBatch({
        record: mirror.record,
        state: mirror.activityState,
      }),
    };
  } catch (error) {
    return { status: "failed", mirror, phase: "read_claude_jsonl", error };
  }
}

export const claudeNativeTuiProviderHandler: NativeTuiProviderHandler = {
  provider: "claude",
  canProbeBinding: true,
  observeOutput: observeClaudeOutput,
  probeBinding: probeClaudeBinding,
  updateMirror: updateClaudeMirror,
};
