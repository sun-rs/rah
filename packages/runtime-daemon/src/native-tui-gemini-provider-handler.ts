import {
  createGeminiStoredActivityState,
  discoverGeminiStoredSessions,
  isGeminiStoredSessionRecordResumable,
  readGeminiStoredSessionActivityBatch,
} from "./gemini-session-files";
import { sameNativeTuiDirectory } from "./native-tui-provider-handler-utils";
import type {
  NativeTuiMirrorUpdate,
  NativeTuiOutputObservation,
  NativeTuiProviderHandler,
  NativeTuiProviderMirror,
  NativeTuiProviderRuntimeSession,
} from "./native-tui-provider-runtime-types";

const ANSI_ESCAPE_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;

function stripTerminalControl(value: string): string {
  return value
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b[()][A-Za-z0-9]/g, "")
    .replace(/\u001b/g, "");
}

function hasGeminiPrompt(data: string): boolean {
  const plain = stripTerminalControl(data).replace(/\r/g, "\n");
  return /(?:^|\n)\s*(?:[>*])\s*Type your message/i.test(plain);
}

function selectGeminiBindingRecord(session: NativeTuiProviderRuntimeSession) {
  const byProviderSessionId = session.providerSessionId
    ? discoverGeminiStoredSessions(session.cwd).find(
        (candidate) => candidate.ref.providerSessionId === session.providerSessionId,
      ) ??
      discoverGeminiStoredSessions().find(
        (candidate) => candidate.ref.providerSessionId === session.providerSessionId,
      )
    : undefined;
  if (byProviderSessionId) {
    return byProviderSessionId;
  }
  return discoverGeminiStoredSessions(session.cwd)
    .filter((record) =>
      sameNativeTuiDirectory(record.ref.cwd ?? record.ref.rootDir, session.cwd),
    )
    .filter(isGeminiStoredSessionRecordResumable)
    .filter((record) => {
      const updatedAt = Date.parse(record.ref.updatedAt ?? "");
      return Number.isFinite(updatedAt) && updatedAt >= session.startupTimestampMs - 5_000;
    })
    .sort((left, right) =>
      (right.ref.updatedAt ?? "").localeCompare(left.ref.updatedAt ?? ""),
    )[0];
}

function probeGeminiBinding(session: NativeTuiProviderRuntimeSession) {
  const record = selectGeminiBindingRecord(session);
  if (!record) {
    return null;
  }
  return {
    providerSessionId: record.ref.providerSessionId,
    record,
  };
}

function updateGeminiMirror(
  session: NativeTuiProviderRuntimeSession,
  mirror: NativeTuiProviderMirror | undefined,
): NativeTuiMirrorUpdate {
  if (mirror?.provider !== "gemini") {
    const record = selectGeminiBindingRecord(session);
    if (!record) {
      return { status: "missing" };
    }
    mirror = {
      provider: "gemini",
      providerSessionId: record.ref.providerSessionId,
      record,
      activityState: createGeminiStoredActivityState(),
    };
  }
  try {
    return {
      status: "ok",
      mirror,
      items: readGeminiStoredSessionActivityBatch({
        record: mirror.record,
        state: mirror.activityState,
      }),
    };
  } catch (error) {
    return { status: "failed", mirror, phase: "read_gemini_session", error };
  }
}

function observeGeminiOutput(
  _session: NativeTuiProviderRuntimeSession,
  data: string,
): NativeTuiOutputObservation {
  return {
    promptClean: hasGeminiPrompt(data),
    binding: null,
  };
}

export const geminiNativeTuiProviderHandler: NativeTuiProviderHandler = {
  provider: "gemini",
  canProbeBinding: true,
  observeOutput: observeGeminiOutput,
  probeBinding: probeGeminiBinding,
  updateMirror: updateGeminiMirror,
};
