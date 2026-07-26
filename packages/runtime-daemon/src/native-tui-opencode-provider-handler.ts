import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import {
  createOpenCodeActivityState,
  translateOpenCodeMessage,
} from "./opencode-activity";
import type { OpenCodeMessageWithParts } from "./opencode-api";
import {
  loadOpenCodeStoredMessagesAsync,
  type OpenCodeStoredSessionRecord,
} from "./opencode-stored-sessions";
import { HISTORY_WORKLOAD_PRIORITY } from "./history-workload-governor";
import {
  sameNativeTuiDirectory,
} from "./native-tui-provider-handler-utils";
import type { NativeTuiHistoryCatalog } from "./native-tui-history-catalog";
import type {
  NativeTuiMirrorUpdate,
  NativeTuiOutputObservation,
  NativeTuiProviderActivityEnvelope,
  NativeTuiProviderHandler,
  NativeTuiProviderMirror,
  NativeTuiProviderRuntimeSession,
} from "./native-tui-provider-runtime-types";

const ANSI_ESCAPE_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const OPENCODE_NATIVE_TUI_MIRROR_MESSAGE_LIMIT = 16;
const OPENCODE_NATIVE_TUI_MIRROR_REVISION_LIMIT = 64;
const OPENCODE_NATIVE_TUI_MIRROR_PART_TEXT_LIMIT = 64 * 1024;

function isOpenCodeMessageReadyForNativeMirror(message: OpenCodeMessageWithParts): boolean {
  if (message.info.role === "user") {
    return true;
  }
  return (
    message.parts.length > 0 ||
    message.info.finish !== undefined ||
    message.info.time?.completed !== undefined
  );
}

function openCodeMessageRevision(message: OpenCodeMessageWithParts): string {
  return createHash("sha256")
    .update(JSON.stringify({
      info: message.info,
      parts: message.parts,
    }))
    .digest("base64url");
}

async function openCodeStorageRevision(databasePath: string): Promise<string> {
  const fingerprints = await Promise.all(
    [databasePath, `${databasePath}-wal`].map(async (filePath) => {
      try {
        const stats = await stat(filePath);
        return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}`;
      } catch {
        return "missing";
      }
    }),
  );
  return fingerprints.join("|");
}

function openCodeMessageTimestamp(message: OpenCodeMessageWithParts): string | undefined {
  const ms = message.info.time?.completed ?? message.info.time?.created;
  if (typeof ms !== "number" || !Number.isFinite(ms)) {
    return undefined;
  }
  return new Date(ms).toISOString();
}

function openCodeRecords(
  historyCatalog: NativeTuiHistoryCatalog,
): OpenCodeStoredSessionRecord[] {
  return historyCatalog.list("opencode").map((record) => ({
    ref: record.ref,
    databasePath: record.storagePath,
  }));
}

function probeOpenCodeBinding(
  session: NativeTuiProviderRuntimeSession,
  historyCatalog: NativeTuiHistoryCatalog,
) {
  const candidate = openCodeRecords(historyCatalog)
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
    historyCatalog.requestRefresh("opencode");
    return null;
  }
  return {
    providerSessionId: candidate.ref.providerSessionId,
    record: candidate,
  };
}

function observeOpenCodeOutput(
  _session: NativeTuiProviderRuntimeSession,
  data: string,
): NativeTuiOutputObservation {
  const stripped = data.replace(ANSI_ESCAPE_PATTERN, "");
  const lastLine = stripped
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  return {
    promptClean: lastLine ? /\bAsk anything\b/i.test(lastLine) : false,
    binding: null,
  };
}

async function updateOpenCodeMirror(
  session: NativeTuiProviderRuntimeSession,
  mirror: NativeTuiProviderMirror | undefined,
  historyCatalog: NativeTuiHistoryCatalog,
): Promise<NativeTuiMirrorUpdate> {
  if (mirror?.provider !== "opencode") {
    if (!session.providerSessionId) {
      return { status: "missing" };
    }
    const record = openCodeRecords(historyCatalog).find(
      (candidate) => candidate.ref.providerSessionId === session.providerSessionId,
    );
    if (!record) {
      historyCatalog.requestRefresh("opencode");
      return { status: "missing" };
    }
    mirror = {
      provider: "opencode",
      providerSessionId: session.providerSessionId,
      record,
      processedMessageRevisions: new Map(),
      activityState: createOpenCodeActivityState(session.providerSessionId, {
        origin: "history",
      }),
    };
  }

  const items: NativeTuiProviderActivityEnvelope[] = [];
  const storageRevision = await openCodeStorageRevision(mirror.record.databasePath);
  if (mirror.storageRevision === storageRevision) {
    return { status: "ok", mirror, items };
  }
  let messages: OpenCodeMessageWithParts[];
  try {
    messages = await loadOpenCodeStoredMessagesAsync(mirror.record, {
      limit: OPENCODE_NATIVE_TUI_MIRROR_MESSAGE_LIMIT,
      maxPartTextChars: OPENCODE_NATIVE_TUI_MIRROR_PART_TEXT_LIMIT,
      throwOnReadError: true,
      workloadPriority: HISTORY_WORKLOAD_PRIORITY.liveMirror,
    });
  } catch {
    // Preserve semantic lifecycle even when a provider persisted an unusually
    // large tool payload. The detail remains in provider storage and can be
    // loaded explicitly; the live mirror must stay bounded.
    messages = await loadOpenCodeStoredMessagesAsync(mirror.record, {
      limit: OPENCODE_NATIVE_TUI_MIRROR_MESSAGE_LIMIT,
      summary: true,
      throwOnReadError: true,
      workloadPriority: HISTORY_WORKLOAD_PRIORITY.liveMirror,
    });
  }
  for (const message of messages) {
    if (!isOpenCodeMessageReadyForNativeMirror(message)) {
      continue;
    }
    const revision = openCodeMessageRevision(message);
    if (mirror.processedMessageRevisions.get(message.info.id) === revision) {
      continue;
    }
    mirror.processedMessageRevisions.delete(message.info.id);
    mirror.processedMessageRevisions.set(message.info.id, revision);
    while (
      mirror.processedMessageRevisions.size > OPENCODE_NATIVE_TUI_MIRROR_REVISION_LIMIT
    ) {
      const oldest = mirror.processedMessageRevisions.keys().next().value;
      if (typeof oldest !== "string") {
        break;
      }
      mirror.processedMessageRevisions.delete(oldest);
    }
    const ts = openCodeMessageTimestamp(message);
    for (const activity of translateOpenCodeMessage(mirror.activityState, message)) {
      items.push({
        meta: {
          provider: "opencode",
          channel: "structured_persisted",
          authority: "authoritative",
          ...(ts ? { ts } : {}),
        },
        activity,
      });
    }
  }
  mirror.storageRevision = storageRevision;
  return { status: "ok", mirror, items };
}

export function createOpenCodeNativeTuiProviderHandler(
  historyCatalog: NativeTuiHistoryCatalog,
): NativeTuiProviderHandler {
  return {
    provider: "opencode",
    canProbeBinding: true,
    observeOutput: observeOpenCodeOutput,
    probeBinding: (session) => probeOpenCodeBinding(session, historyCatalog),
    updateMirror: (session, mirror) =>
      updateOpenCodeMirror(session, mirror, historyCatalog),
  };
}
