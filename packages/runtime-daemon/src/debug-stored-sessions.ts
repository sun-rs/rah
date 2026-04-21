import type { StoredSessionRef } from "@rah/runtime-protocol";

const now = new Date().toISOString();

export const DEBUG_STORED_SESSIONS: StoredSessionRef[] = [
  {
    provider: "custom",
    providerSessionId: "debug-claude-session-1",
    cwd: "/Users/sun/Code/solars",
    rootDir: "/Users/sun/Code/solars",
    title: "Refactor mobile workbench",
    preview: "Investigate adapter boundaries for Claude remote sessions.",
    updatedAt: now,
    source: "provider_history",
  },
];
