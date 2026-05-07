import {
  createClaudeStoredActivityState,
  discoverClaudeStoredSessions,
  readClaudeStoredSessionActivityBatch,
} from "./claude-session-files";
import { EMPTY_NATIVE_TUI_OUTPUT_OBSERVATION } from "./native-tui-provider-handler-utils";
import type {
  NativeTuiMirrorUpdate,
  NativeTuiProviderHandler,
  NativeTuiProviderMirror,
  NativeTuiProviderRuntimeSession,
} from "./native-tui-provider-runtime-types";

function updateClaudeMirror(
  session: NativeTuiProviderRuntimeSession,
  mirror: NativeTuiProviderMirror | undefined,
): NativeTuiMirrorUpdate {
  if (mirror?.provider !== "claude") {
    if (!session.providerSessionId) {
      return { status: "missing" };
    }
    const record = discoverClaudeStoredSessions(session.cwd).find(
      (candidate) => candidate.ref.providerSessionId === session.providerSessionId,
    ) ?? discoverClaudeStoredSessions().find(
      (candidate) => candidate.ref.providerSessionId === session.providerSessionId,
    );
    if (!record) {
      return { status: "missing" };
    }
    mirror = {
      provider: "claude",
      providerSessionId: session.providerSessionId,
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
  observeOutput: () => EMPTY_NATIVE_TUI_OUTPUT_OBSERVATION,
  updateMirror: updateClaudeMirror,
};
