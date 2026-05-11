import { readFileSync } from "node:fs";
import path from "node:path";
import {
  createCodexRolloutTranslationState,
  translateCodexRolloutLine,
} from "./codex-rollout-activity";
import type { CodexStoredSessionRecord } from "./codex-stored-sessions";
import {
  extractCodexTerminalSessionId,
  hasCodexTerminalPrompt,
  readPersistedTaskLifecycle,
  selectCodexStoredSessionCandidate,
  sliceUnprocessedRolloutLines,
} from "./codex-native-tui-bridge";
import { discoverCodexStoredSessions } from "./codex-stored-sessions";
import type {
  NativeTuiMirrorUpdate,
  NativeTuiOutputObservation,
  NativeTuiProviderActivityEnvelope,
  NativeTuiProviderHandler,
  NativeTuiProviderMirror,
  NativeTuiProviderRuntimeSession,
} from "./native-tui-provider-runtime-types";

function isWithinDirectory(filePath: string, directory: string): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(filePath));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function codexRecordsForRuntimeSession(
  session: NativeTuiProviderRuntimeSession,
): CodexStoredSessionRecord[] {
  const records = discoverCodexStoredSessions();
  const codexHome = session.launchEnv?.CODEX_HOME;
  if (!codexHome) {
    return records;
  }
  return records.filter(
    (record) =>
      isWithinDirectory(record.rolloutPath, path.join(codexHome, "sessions")) ||
      isWithinDirectory(record.rolloutPath, path.join(codexHome, "archived_sessions")),
  );
}

function observeCodexOutput(
  session: NativeTuiProviderRuntimeSession,
  data: string,
): NativeTuiOutputObservation {
  const promptClean = hasCodexTerminalPrompt(data);
  if (session.providerSessionId) {
    return { promptClean, binding: null };
  }
  const providerSessionId = extractCodexTerminalSessionId(data);
  if (!providerSessionId) {
    return { promptClean, binding: null };
  }
  const record = codexRecordsForRuntimeSession(session).find(
    (candidate) => candidate.ref.providerSessionId === providerSessionId,
  );
  return {
    promptClean,
    binding: {
      providerSessionId,
      record: record ?? null,
    },
  };
}

function probeCodexBinding(session: NativeTuiProviderRuntimeSession) {
  const candidate = selectCodexStoredSessionCandidate({
    records: codexRecordsForRuntimeSession(session),
    cwd: session.cwd,
    startupTimestampMs: session.startupTimestampMs,
    updatedAfterMs: session.startupTimestampMs,
    allowWindowFallback: false,
  });
  if (!candidate) {
    return null;
  }
  return {
    providerSessionId: candidate.ref.providerSessionId,
    record: candidate,
  };
}

function updateCodexMirror(
  session: NativeTuiProviderRuntimeSession,
  mirror: NativeTuiProviderMirror | undefined,
): NativeTuiMirrorUpdate {
  if (mirror?.provider !== "codex") {
    const record = codexRecordsForRuntimeSession(session).find(
      (candidate) => candidate.ref.providerSessionId === session.providerSessionId,
    );
    if (!record || !session.providerSessionId) {
      return { status: "missing" };
    }
    mirror = {
      provider: "codex",
      providerSessionId: session.providerSessionId,
      record,
      processedLineCount: 0,
      translationState: createCodexRolloutTranslationState({
        providerSessionId: session.providerSessionId,
      }),
    };
  }

  let content: string;
  try {
    content = readFileSync(mirror.record.rolloutPath, "utf8");
  } catch (error) {
    return { status: "failed", mirror, phase: "read_codex_rollout", error };
  }

  const items: NativeTuiProviderActivityEnvelope[] = [];
  const window = sliceUnprocessedRolloutLines(content, mirror.processedLineCount);
  mirror.processedLineCount = window.nextProcessedLineCount;
  for (const line of window.lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const lifecycle = readPersistedTaskLifecycle(parsed);
    if (lifecycle?.kind === "started") {
      items.push({
        meta: {
          provider: "codex",
          channel: "structured_persisted",
          authority: "authoritative",
          ...(lifecycle.ts ? { ts: lifecycle.ts } : {}),
        },
        activity: { type: "turn_started", turnId: lifecycle.turnId },
      });
    } else if (lifecycle?.kind === "completed") {
      items.push({
        meta: {
          provider: "codex",
          channel: "structured_persisted",
          authority: "authoritative",
          ...(lifecycle.ts ? { ts: lifecycle.ts } : {}),
        },
        activity: { type: "turn_completed", turnId: lifecycle.turnId },
      });
    } else if (lifecycle?.kind === "canceled") {
      items.push({
        meta: {
          provider: "codex",
          channel: "structured_persisted",
          authority: "authoritative",
          ...(lifecycle.ts ? { ts: lifecycle.ts } : {}),
        },
        activity: { type: "turn_canceled", turnId: lifecycle.turnId, reason: "interrupted" },
      });
    }
    for (const item of translateCodexRolloutLine(parsed, mirror.translationState)) {
      items.push({
        meta: {
          provider: "codex",
          ...(item.channel !== undefined ? { channel: item.channel } : {}),
          ...(item.authority !== undefined ? { authority: item.authority } : {}),
          ...(item.raw !== undefined ? { raw: item.raw } : {}),
          ...(item.ts !== undefined ? { ts: item.ts } : {}),
        },
        activity: item.activity,
      });
    }
  }
  return { status: "ok", mirror, items };
}

export const codexNativeTuiProviderHandler: NativeTuiProviderHandler = {
  provider: "codex",
  canProbeBinding: true,
  observeOutput: observeCodexOutput,
  probeBinding: probeCodexBinding,
  updateMirror: updateCodexMirror,
};
