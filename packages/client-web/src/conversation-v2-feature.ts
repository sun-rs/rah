const CONVERSATION_V2_STORAGE_KEY = "rah.experimental.conversationV2";

export function resolveConversationV2Enabled(
  queryOverride: string | null,
  storedOverride: string | null,
): boolean {
  if (queryOverride === "1") {
    return true;
  }
  if (queryOverride === "0") {
    return false;
  }
  if (storedOverride === "1") {
    return true;
  }
  if (storedOverride === "0") {
    return false;
  }
  return true;
}

export function conversationV2Enabled(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return resolveConversationV2Enabled(
      new URLSearchParams(window.location.search).get("conversationV2"),
      window.localStorage.getItem(CONVERSATION_V2_STORAGE_KEY),
    );
  } catch {
    return true;
  }
}
