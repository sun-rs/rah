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
} from "./codex-native-tui-bridge";
import {
  createIncrementalJsonlCursor,
  readIncrementalJsonlBatch,
} from "./incremental-jsonl-reader";
import type { NativeTuiHistoryCatalog } from "./native-tui-history-catalog";
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
  historyCatalog: NativeTuiHistoryCatalog,
): CodexStoredSessionRecord[] {
  const records = historyCatalog.list("codex").map((record) => ({
    ref: record.ref,
    rolloutPath: record.storagePath,
    archived: record.archived ?? record.ref.providerState?.archived === true,
  }));
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
  historyCatalog: NativeTuiHistoryCatalog,
): NativeTuiOutputObservation {
  const promptClean = hasCodexTerminalPrompt(data);
  if (session.providerSessionId) {
    return { promptClean, binding: null };
  }
  const providerSessionId = extractCodexTerminalSessionId(data);
  if (!providerSessionId) {
    return { promptClean, binding: null };
  }
  const record = codexRecordsForRuntimeSession(session, historyCatalog).find(
    (candidate) => candidate.ref.providerSessionId === providerSessionId,
  );
  if (!record) {
    historyCatalog.requestRefresh("codex");
  }
  return {
    promptClean,
    binding: {
      providerSessionId,
      record: record ?? null,
    },
  };
}

function probeCodexBinding(
  session: NativeTuiProviderRuntimeSession,
  historyCatalog: NativeTuiHistoryCatalog,
) {
  const candidate = selectCodexStoredSessionCandidate({
    records: codexRecordsForRuntimeSession(session, historyCatalog),
    cwd: session.cwd,
    startupTimestampMs: session.startupTimestampMs,
    updatedAfterMs: session.startupTimestampMs,
    allowWindowFallback: false,
  });
  if (!candidate) {
    historyCatalog.requestRefresh("codex");
    return null;
  }
  return {
    providerSessionId: candidate.ref.providerSessionId,
    record: candidate,
  };
}

async function updateCodexMirror(
  session: NativeTuiProviderRuntimeSession,
  mirror: NativeTuiProviderMirror | undefined,
  historyCatalog: NativeTuiHistoryCatalog,
): Promise<NativeTuiMirrorUpdate> {
  if (mirror?.provider !== "codex") {
    const record = codexRecordsForRuntimeSession(session, historyCatalog).find(
      (candidate) => candidate.ref.providerSessionId === session.providerSessionId,
    );
    if (!record || !session.providerSessionId) {
      historyCatalog.requestRefresh("codex");
      return { status: "missing" };
    }
    mirror = {
      provider: "codex",
      providerSessionId: session.providerSessionId,
      record,
      jsonlCursor: createIncrementalJsonlCursor(),
      translationState: createCodexRolloutTranslationState({
        providerSessionId: session.providerSessionId,
      }),
    };
  }

  let batch;
  try {
    batch = await readIncrementalJsonlBatch(
      mirror.record.rolloutPath,
      mirror.jsonlCursor,
    );
  } catch (error) {
    return { status: "failed", mirror, phase: "read_codex_rollout", error };
  }

  const items: NativeTuiProviderActivityEnvelope[] = [];
  for (const line of batch.lines) {
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
  return {
    status: "ok",
    mirror,
    items,
    ...(batch.hasMore ? { hasMore: true } : {}),
  };
}

export function createCodexNativeTuiProviderHandler(
  historyCatalog: NativeTuiHistoryCatalog,
): NativeTuiProviderHandler {
  return {
    provider: "codex",
    canProbeBinding: true,
    observeOutput: (session, data) =>
      observeCodexOutput(session, data, historyCatalog),
    probeBinding: (session) => probeCodexBinding(session, historyCatalog),
    updateMirror: (session, mirror) =>
      updateCodexMirror(session, mirror, historyCatalog),
  };
}
