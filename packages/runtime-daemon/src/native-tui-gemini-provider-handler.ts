import {
  geminiMessageRevision,
  loadGeminiConversationRecord,
  translateGeminiConversationToActivities,
} from "./gemini-conversation-utils";
import {
  discoverGeminiStoredSessions,
  isGeminiStoredSessionRecordResumable,
} from "./gemini-session-files";
import {
  EMPTY_NATIVE_TUI_OUTPUT_OBSERVATION,
  sameNativeTuiDirectory,
} from "./native-tui-provider-handler-utils";
import type {
  NativeTuiMirrorUpdate,
  NativeTuiProviderHandler,
  NativeTuiProviderMirror,
  NativeTuiProviderRuntimeSession,
} from "./native-tui-provider-runtime-types";

function probeGeminiBinding(session: NativeTuiProviderRuntimeSession) {
  const candidate = discoverGeminiStoredSessions()
    .filter((record) =>
      sameNativeTuiDirectory(record.ref.cwd ?? record.ref.rootDir, session.cwd),
    )
    .filter(isGeminiStoredSessionRecordResumable)
    .filter((record) => {
      const updatedAt = Date.parse(record.ref.updatedAt ?? record.conversation.lastUpdated ?? "");
      return Number.isFinite(updatedAt) && updatedAt >= session.startupTimestampMs - 5_000;
    })
    .sort((left, right) =>
      (right.ref.updatedAt ?? right.conversation.lastUpdated ?? "").localeCompare(
        left.ref.updatedAt ?? left.conversation.lastUpdated ?? "",
      ),
    )[0];
  if (!candidate) {
    return null;
  }
  return {
    providerSessionId: candidate.ref.providerSessionId,
    record: candidate,
  };
}

function updateGeminiMirror(
  session: NativeTuiProviderRuntimeSession,
  mirror: NativeTuiProviderMirror | undefined,
): NativeTuiMirrorUpdate {
  if (mirror?.provider !== "gemini") {
    if (!session.providerSessionId) {
      return { status: "missing" };
    }
    const record = discoverGeminiStoredSessions()
      .filter((candidate) => candidate.ref.providerSessionId === session.providerSessionId)
      .sort((left, right) =>
        (right.ref.updatedAt ?? right.conversation.lastUpdated ?? "").localeCompare(
          left.ref.updatedAt ?? left.conversation.lastUpdated ?? "",
        ),
      )[0];
    if (!record) {
      return { status: "missing" };
    }
    mirror = {
      provider: "gemini",
      providerSessionId: session.providerSessionId,
      record,
      processedMessageRevisions: new Map(),
    };
  }

  const conversation = loadGeminiConversationRecord(mirror.record.filePath);
  if (!conversation || conversation.sessionId !== mirror.record.ref.providerSessionId) {
    return {
      status: "failed",
      mirror,
      phase: "load_gemini_conversation",
      error: new Error("Gemini conversation file could not be loaded for the bound provider session."),
    };
  }
  const changedMessageIds = new Set<string>();
  for (const message of conversation.messages) {
    const revision = geminiMessageRevision(message);
    if (mirror.processedMessageRevisions.get(message.id) !== revision) {
      changedMessageIds.add(message.id);
      mirror.processedMessageRevisions.set(message.id, revision);
    }
  }
  if (changedMessageIds.size === 0) {
    return { status: "ok", mirror, items: [] };
  }
  const items = translateGeminiConversationToActivities(conversation)
    .filter((item) => changedMessageIds.has(item.messageId))
    .map((item) => ({
      meta: item.meta,
      activity: item.activity,
    }));
  return { status: "ok", mirror, items };
}

export const geminiNativeTuiProviderHandler: NativeTuiProviderHandler = {
  provider: "gemini",
  canProbeBinding: true,
  observeOutput: () => EMPTY_NATIVE_TUI_OUTPUT_OBSERVATION,
  probeBinding: probeGeminiBinding,
  updateMirror: updateGeminiMirror,
};
