import type { ProviderKind } from "@rah/runtime-protocol";
import type {
  ClaudeStoredActivityState,
  ClaudeStoredSessionRecord,
} from "./claude-session-files";
import type { CodexRolloutTranslationState } from "./codex-rollout-activity";
import type { CodexStoredSessionRecord } from "./codex-stored-sessions";
import type {
  GeminiStoredActivityState,
  GeminiStoredSessionRecord,
} from "./gemini-session-files";
import type { OpenCodeActivityState } from "./opencode-activity";
import type { OpenCodeStoredSessionRecord } from "./opencode-stored-sessions";
import type { ProviderActivity, ProviderActivityMeta } from "./provider-activity";

export type NativeTuiProviderRuntimeSession = {
  sessionId: string;
  provider: ProviderKind;
  cwd: string;
  startupTimestampMs: number;
  providerSessionId?: string;
  launchEnv?: Record<string, string>;
};

export type NativeTuiBindingRecord = {
  ref: {
    providerSessionId: string;
    title?: string;
    preview?: string;
    cwd?: string;
    rootDir?: string;
    updatedAt?: string;
  };
};

export type NativeTuiBindingCandidate = {
  providerSessionId: string;
  record: NativeTuiBindingRecord | null;
};

export type NativeTuiOutputObservation = {
  promptClean: boolean;
  binding: NativeTuiBindingCandidate | null;
};

export type NativeTuiProviderActivityEnvelope = {
  meta: ProviderActivityMeta;
  activity: ProviderActivity;
};

export type NativeTuiProviderMirror =
  | {
      provider: "codex";
      providerSessionId: string;
      record: CodexStoredSessionRecord;
      processedLineCount: number;
      translationState: CodexRolloutTranslationState;
    }
  | {
      provider: "claude";
      providerSessionId: string;
      record: ClaudeStoredSessionRecord;
      activityState: ClaudeStoredActivityState;
    }
  | {
      provider: "gemini";
      providerSessionId: string;
      record: GeminiStoredSessionRecord;
      activityState: GeminiStoredActivityState;
    }
  | {
      provider: "opencode";
      providerSessionId: string;
      record: OpenCodeStoredSessionRecord;
      processedMessageRevisions: Map<string, string>;
      activityState: OpenCodeActivityState;
    };

export type NativeTuiMirrorUpdate =
  | { status: "unbound" | "unsupported"; mirror?: NativeTuiProviderMirror }
  | { status: "missing"; mirror?: NativeTuiProviderMirror }
  | { status: "failed"; mirror?: NativeTuiProviderMirror; phase: string; error: unknown }
  | {
      status: "ok";
      mirror: NativeTuiProviderMirror;
      items: NativeTuiProviderActivityEnvelope[];
    };

export type NativeTuiBindingHandler = {
  provider: ProviderKind;
  canProbeBinding?: boolean;
  observeOutput?(
    session: NativeTuiProviderRuntimeSession,
    data: string,
  ): NativeTuiOutputObservation;
  probeBinding?(session: NativeTuiProviderRuntimeSession): NativeTuiBindingCandidate | null;
};

export type NativeTuiMirrorHandler = {
  provider: ProviderKind;
  updateMirror(
    session: NativeTuiProviderRuntimeSession,
    mirror: NativeTuiProviderMirror | undefined,
  ): NativeTuiMirrorUpdate;
};

export type NativeTuiProviderHandler = NativeTuiBindingHandler & NativeTuiMirrorHandler;
