import type { StoredSessionRef } from "@rah/runtime-protocol";

// Debug scenarios are explicit UI exercises. They must not contribute fake
// provider-history rows to the normal Sessions dialog.
export const DEBUG_STORED_SESSIONS: StoredSessionRef[] = [];
