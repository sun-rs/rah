export type SessionConversationNavigationTarget =
  | { kind: "tail" }
  | {
      kind: "reply_start";
      entryKey: string | null;
      turnId: string | null;
      replyTimestampMs: number | null;
    };

export type SessionConversationNavigationRequest = {
  revision: number;
  sessionId: string | null;
  target: SessionConversationNavigationTarget;
};

export const TAIL_SESSION_NAVIGATION_TARGET: SessionConversationNavigationTarget = {
  kind: "tail",
};

export function advanceSessionConversationNavigationRequest(
  current: SessionConversationNavigationRequest,
  sessionId: string | null,
  target: SessionConversationNavigationTarget = TAIL_SESSION_NAVIGATION_TARGET,
): SessionConversationNavigationRequest {
  return {
    revision: current.revision + 1,
    sessionId,
    target,
  };
}

export function acknowledgeSessionConversationNavigationRequest(
  current: SessionConversationNavigationRequest,
  revision: number,
): SessionConversationNavigationRequest {
  if (current.revision !== revision || current.target.kind === "tail") {
    return current;
  }
  return { ...current, target: TAIL_SESSION_NAVIGATION_TARGET };
}
