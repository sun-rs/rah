import {
  createClaudeStoredActivityState,
  translateClaudeStoredSessionActivityLines,
  type ClaudeStoredSessionRecord,
} from "./claude-session-files";
import {
  createIncrementalJsonlCursor,
  readIncrementalJsonlBatch,
} from "./incremental-jsonl-reader";
import {
  sameNativeTuiDirectory,
} from "./native-tui-provider-handler-utils";
import type { NativeTuiHistoryCatalog } from "./native-tui-history-catalog";
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
  const tail = lines.slice(-12);
  let promptIndex = -1;
  for (let index = tail.length - 1; index >= 0; index -= 1) {
    if (/^(?:›|❯|>)\s*$/u.test(tail[index] ?? "")) {
      promptIndex = index;
      break;
    }
  }
  if (promptIndex >= 0) {
    return tail
      .slice(promptIndex + 1)
      .every((line) => /bypass permissions|shift\+tab|^\s*[•>*-]*\s*$/i.test(line));
  }
  return tail.at(-1) ? /bypass permissions/i.test(tail.at(-1)!) : false;
}

function claudeRecords(
  historyCatalog: NativeTuiHistoryCatalog,
): ClaudeStoredSessionRecord[] {
  return historyCatalog.list("claude").map((record) => ({
    ref: record.ref,
    filePath: record.storagePath,
  }));
}

function selectClaudeBindingRecord(
  session: NativeTuiProviderRuntimeSession,
  historyCatalog: NativeTuiHistoryCatalog,
) {
  const records = claudeRecords(historyCatalog);
  const excludedProviderSessionIds = new Set(
    session.excludedProviderSessionIds ?? [],
  );
  if (session.providerSessionId) {
    const boundRecord = records.find(
      (candidate) =>
        candidate.ref.providerSessionId === session.providerSessionId,
    );
    if (!boundRecord) {
      historyCatalog.requestRefresh("claude");
    }
    // A bound runtime identity is authoritative. Never substitute the newest
    // transcript from the same cwd while the catalog refresh is catching up:
    // that would mirror another Claude session into this conversation.
    return boundRecord;
  }
  const candidate = records
    .filter(
      (record) =>
        !excludedProviderSessionIds.has(record.ref.providerSessionId),
    )
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
  if (!candidate) {
    historyCatalog.requestRefresh("claude");
  }
  return candidate;
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

function probeClaudeBinding(
  session: NativeTuiProviderRuntimeSession,
  historyCatalog: NativeTuiHistoryCatalog,
) {
  const record = selectClaudeBindingRecord(session, historyCatalog);
  if (!record) {
    return null;
  }
  return {
    providerSessionId: record.ref.providerSessionId,
    record,
    authority: "history_probe" as const,
  };
}

async function updateClaudeMirror(
  session: NativeTuiProviderRuntimeSession,
  mirror: NativeTuiProviderMirror | undefined,
  historyCatalog: NativeTuiHistoryCatalog,
): Promise<NativeTuiMirrorUpdate> {
  if (mirror?.provider !== "claude") {
    const record = selectClaudeBindingRecord(session, historyCatalog);
    if (!record) {
      return { status: "missing" };
    }
    mirror = {
      provider: "claude",
      providerSessionId: record.ref.providerSessionId,
      record,
      jsonlCursor: createIncrementalJsonlCursor(),
      activityState: createClaudeStoredActivityState(),
    };
  }

  try {
    const batch = await readIncrementalJsonlBatch(
      mirror.record.filePath,
      mirror.jsonlCursor,
    );
    return {
      status: "ok",
      mirror,
      items: translateClaudeStoredSessionActivityLines({
        lines: batch.lines,
        providerSessionId: mirror.record.ref.providerSessionId,
        state: mirror.activityState,
      }),
      ...(batch.hasMore ? { hasMore: true } : {}),
    };
  } catch (error) {
    return { status: "failed", mirror, phase: "read_claude_jsonl", error };
  }
}

export function createClaudeNativeTuiProviderHandler(
  historyCatalog: NativeTuiHistoryCatalog,
): NativeTuiProviderHandler {
  return {
    provider: "claude",
    canProbeBinding: true,
    observeOutput: observeClaudeOutput,
    probeBinding: (session) => probeClaudeBinding(session, historyCatalog),
    updateMirror: (session, mirror) =>
      updateClaudeMirror(session, mirror, historyCatalog),
  };
}
