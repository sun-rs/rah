import type { DebugScenarioDescriptor, StoredSessionRef } from "@rah/runtime-protocol";

export interface PendingSessionTransition {
  kind: "new" | "history" | "claim_history";
  provider: StoredSessionRef["provider"];
  title?: string;
  cwd?: string;
}

export function createPendingStartTransition(args: {
  provider: StoredSessionRef["provider"];
  cwd: string;
  title?: string;
}): PendingSessionTransition {
  return {
    kind: "new",
    provider: args.provider,
    cwd: args.cwd,
    ...(args.title ? { title: args.title } : {}),
  };
}

export function createPendingScenarioTransition(
  scenario: Pick<DebugScenarioDescriptor, "provider" | "rootDir" | "title">,
): PendingSessionTransition {
  return createPendingStartTransition({
    provider: scenario.provider,
    cwd: scenario.rootDir,
    title: scenario.title,
  });
}

export function createPendingStoredSessionTransition(
  ref: Pick<StoredSessionRef, "provider" | "providerSessionId" | "title" | "preview" | "rootDir" | "cwd">,
  kind: "history" | "claim_history" = "history",
): PendingSessionTransition {
  return {
    kind,
    provider: ref.provider,
    title: ref.title ?? ref.preview ?? ref.providerSessionId,
    ...(ref.rootDir ?? ref.cwd ? { cwd: ref.rootDir ?? ref.cwd } : {}),
  };
}
