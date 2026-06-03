import type { StoredSessionRef } from "@rah/runtime-protocol";

export interface CodexStoredSessionRecord {
  ref: StoredSessionRef;
  rolloutPath: string;
  archived: boolean;
}

export const REHYDRATED_CAPABILITIES = {
  liveAttach: false,
  structuredTimeline: true,
  nativeTui: false,
  rawPtyInput: false,
  chatMirror: false,
  structuredControl: false,
  livePermissions: false,
  contextUsage: false,
  resumeByProvider: true,
  listProviderSessions: true,
  steerInput: false,
  queuedInput: false,
  renameSession: true,
  actions: {
    info: true,
    stop: false,
    delete: true,
    rename: "native",
  },
  modelSwitch: false,
  planMode: false,
  subagents: false,
} as const;
