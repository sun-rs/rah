import type { StoredSessionRef } from "@rah/runtime-protocol";

export interface CodexStoredSessionRecord {
  ref: StoredSessionRef;
  rolloutPath: string;
}

export const REHYDRATED_CAPABILITIES = {
  livePermissions: false,
  steerInput: false,
  queuedInput: false,
  renameSession: true,
  modelSwitch: false,
  planMode: false,
  subagents: false,
} as const;
