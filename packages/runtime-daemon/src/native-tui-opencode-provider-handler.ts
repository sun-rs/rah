import {
  createOpenCodeActivityState,
  translateOpenCodeMessage,
} from "./opencode-activity";
import type { OpenCodeMessageWithParts } from "./opencode-api";
import {
  discoverOpenCodeStoredSessions,
  loadOpenCodeStoredMessages,
} from "./opencode-stored-sessions";
import {
  EMPTY_NATIVE_TUI_OUTPUT_OBSERVATION,
  sameNativeTuiDirectory,
} from "./native-tui-provider-handler-utils";
import type {
  NativeTuiMirrorUpdate,
  NativeTuiProviderActivityEnvelope,
  NativeTuiProviderHandler,
  NativeTuiProviderMirror,
  NativeTuiProviderRuntimeSession,
} from "./native-tui-provider-runtime-types";

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
  return JSON.stringify({
    info: message.info,
    parts: message.parts,
  });
}

function openCodeMessageTimestamp(message: OpenCodeMessageWithParts): string | undefined {
  const ms = message.info.time?.completed ?? message.info.time?.created;
  if (typeof ms !== "number" || !Number.isFinite(ms)) {
    return undefined;
  }
  return new Date(ms).toISOString();
}

function probeOpenCodeBinding(session: NativeTuiProviderRuntimeSession) {
  const candidate = discoverOpenCodeStoredSessions()
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
    return null;
  }
  return {
    providerSessionId: candidate.ref.providerSessionId,
    record: candidate,
  };
}

function updateOpenCodeMirror(
  session: NativeTuiProviderRuntimeSession,
  mirror: NativeTuiProviderMirror | undefined,
): NativeTuiMirrorUpdate {
  if (mirror?.provider !== "opencode") {
    if (!session.providerSessionId) {
      return { status: "missing" };
    }
    const record = discoverOpenCodeStoredSessions().find(
      (candidate) => candidate.ref.providerSessionId === session.providerSessionId,
    );
    if (!record) {
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
  const messages = loadOpenCodeStoredMessages(mirror.record, { limit: 1000 });
  for (const message of messages) {
    if (!isOpenCodeMessageReadyForNativeMirror(message)) {
      continue;
    }
    const revision = openCodeMessageRevision(message);
    if (mirror.processedMessageRevisions.get(message.info.id) === revision) {
      continue;
    }
    mirror.processedMessageRevisions.set(message.info.id, revision);
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
  return { status: "ok", mirror, items };
}

export const opencodeNativeTuiProviderHandler: NativeTuiProviderHandler = {
  provider: "opencode",
  canProbeBinding: true,
  observeOutput: () => EMPTY_NATIVE_TUI_OUTPUT_OBSERVATION,
  probeBinding: probeOpenCodeBinding,
  updateMirror: updateOpenCodeMirror,
};
