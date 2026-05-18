import { useCallback, useEffect, useState } from "react";
import type { ProviderChoice } from "../components/ProviderSelector";

const HIDE_TOOL_CALLS_KEY = "rah-hide-tool-calls-in-chat";
const HIDE_OPENCODE_REASONING_KEY = "rah-hide-opencode-reasoning-in-chat";
const SHOW_MODEL_INFO_KEY_PREFIX = "rah-show-model-info-in-chat:";
const CHAT_PREFERENCES_EVENT = "rah:chat-preferences-updated";
const MODEL_INFO_PROVIDERS: ProviderChoice[] = ["codex", "claude", "opencode"];

function isBrowser(): boolean {
  return typeof window !== "undefined";
}

function readBoolean(key: string, defaultValue: boolean): boolean {
  if (!isBrowser()) return defaultValue;
  try {
    const value = localStorage.getItem(key);
    if (value === null) return defaultValue;
    return value === "true";
  } catch {
    return defaultValue;
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
  hideOpenCodeReasoningInChat: boolean;
  setHideOpenCodeReasoningInChat: (value: boolean) => void;
  showModelInfoInChat: Record<ProviderChoice, boolean>;
  setShowModelInfoInChat: (provider: ProviderChoice, value: boolean) => void;
} {
  const [hideToolCallsInChat, setHideToolCallsInChatState] = useState<boolean>(() =>
    readBoolean(HIDE_TOOL_CALLS_KEY, true),
  );
  const [hideOpenCodeReasoningInChat, setHideOpenCodeReasoningInChatState] = useState<boolean>(() =>
    readBoolean(HIDE_OPENCODE_REASONING_KEY, true),
  );
  const [showModelInfoInChat, setShowModelInfoInChatState] =
    useState<Record<ProviderChoice, boolean>>(() => readShowModelInfoPreferences());

  useEffect(() => {
    if (!isBrowser()) return;
    const syncPreference = () => {
      setHideToolCallsInChatState(readBoolean(HIDE_TOOL_CALLS_KEY, true));
      setHideOpenCodeReasoningInChatState(readBoolean(HIDE_OPENCODE_REASONING_KEY, true));
      setShowModelInfoInChatState(readShowModelInfoPreferences());
    };
    const onStorage = (event: StorageEvent) => {
      if (
        event.key !== HIDE_TOOL_CALLS_KEY &&
        event.key !== HIDE_OPENCODE_REASONING_KEY &&
        !event.key?.startsWith(SHOW_MODEL_INFO_KEY_PREFIX)
      ) {
        return;
      }
      syncPreference();
    };
    const onPreferenceEvent = () => {
      syncPreference();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(CHAT_PREFERENCES_EVENT, onPreferenceEvent);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(CHAT_PREFERENCES_EVENT, onPreferenceEvent);
    };
  }, []);

  const setHideToolCallsInChat = useCallback((value: boolean) => {
    setHideToolCallsInChatState(value);
    writeBoolean(HIDE_TOOL_CALLS_KEY, value);
    if (isBrowser()) {
      window.dispatchEvent(new Event(CHAT_PREFERENCES_EVENT));
    }
  }, []);

  const setHideOpenCodeReasoningInChat = useCallback((value: boolean) => {
    setHideOpenCodeReasoningInChatState(value);
    writeBoolean(HIDE_OPENCODE_REASONING_KEY, value);
    if (isBrowser()) {
      window.dispatchEvent(new Event(CHAT_PREFERENCES_EVENT));
    }
  }, []);

  const setShowModelInfoInChat = useCallback((provider: ProviderChoice, value: boolean) => {
    setShowModelInfoInChatState((current) => ({ ...current, [provider]: value }));
    writeBoolean(`${SHOW_MODEL_INFO_KEY_PREFIX}${provider}`, value);
    if (isBrowser()) {
      window.dispatchEvent(new Event(CHAT_PREFERENCES_EVENT));
    }
  }, []);

  return {
    hideToolCallsInChat,
    setHideToolCallsInChat,
    hideOpenCodeReasoningInChat,
    setHideOpenCodeReasoningInChat,
    showModelInfoInChat,
    setShowModelInfoInChat,
  };
}

function readShowModelInfoPreferences(): Record<ProviderChoice, boolean> {
  return MODEL_INFO_PROVIDERS.reduce(
    (acc, provider) => {
      acc[provider] = readBoolean(`${SHOW_MODEL_INFO_KEY_PREFIX}${provider}`, true);
      return acc;
    },
    {} as Record<ProviderChoice, boolean>,
  );
}
