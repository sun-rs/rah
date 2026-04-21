import { useCallback, useEffect, useState } from "react";

const HIDE_TOOL_CALLS_KEY = "rah-hide-tool-calls-in-chat";

function isBrowser(): boolean {
  return typeof window !== "undefined";
}

function readBoolean(key: string): boolean {
  if (!isBrowser()) return false;
  try {
    return localStorage.getItem(key) === "true";
  } catch {
    return false;
  }
}

function writeBoolean(key: string, value: boolean): void {
  if (!isBrowser()) return;
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // ignore
  }
}

export function useChatPreferences(): {
  hideToolCallsInChat: boolean;
  setHideToolCallsInChat: (value: boolean) => void;
} {
  const [hideToolCallsInChat, setHideToolCallsInChatState] = useState<boolean>(() =>
    readBoolean(HIDE_TOOL_CALLS_KEY),
  );

  useEffect(() => {
    if (!isBrowser()) return;
    const onStorage = (event: StorageEvent) => {
      if (event.key !== HIDE_TOOL_CALLS_KEY) return;
      setHideToolCallsInChatState(readBoolean(HIDE_TOOL_CALLS_KEY));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setHideToolCallsInChat = useCallback((value: boolean) => {
    setHideToolCallsInChatState(value);
    writeBoolean(HIDE_TOOL_CALLS_KEY, value);
  }, []);

  return { hideToolCallsInChat, setHideToolCallsInChat };
}
