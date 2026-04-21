import { useState } from "react";
import { Info, MessageSquareText, Palette } from "lucide-react";
import { ThemeToggle } from "./ThemeToggle";
import { useChatPreferences } from "../hooks/useChatPreferences";

type SettingsTab = "appearance" | "chat" | "about";

const TABS: { id: SettingsTab; label: string; icon: typeof Palette }[] = [
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "chat", label: "Chat", icon: MessageSquareText },
  { id: "about", label: "About", icon: Info },
];

export function SettingsPane() {
  const [activeTab, setActiveTab] = useState<SettingsTab>("appearance");
  const { hideToolCallsInChat, setHideToolCallsInChat } = useChatPreferences();

  return (
    <div className="flex h-[60vh]">
      {/* Left sidebar tabs */}
      <div className="w-40 shrink-0 border-r border-[var(--app-border)] p-2 space-y-0.5">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const selected = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`w-full flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors text-left ${
                selected
                  ? "bg-[var(--app-subtle-bg)] text-[var(--app-fg)]"
                  : "text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]/50"
              }`}
            >
              <Icon size={14} />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Right content */}
      <div className="flex-1 overflow-y-auto custom-scrollbar p-5">
        {activeTab === "appearance" ? (
          <div className="space-y-4">
            <div className="text-sm font-semibold text-[var(--app-fg)]">Appearance</div>
            <div className="text-xs text-[var(--app-hint)]">Choose how RAH looks.</div>
            <div className="mt-4">
              <ThemeToggle />
            </div>
          </div>
        ) : activeTab === "chat" ? (
          <div className="space-y-4">
            <div className="text-sm font-semibold text-[var(--app-fg)]">Chat</div>
            <div className="text-xs text-[var(--app-hint)]">Choose what the chat thread shows.</div>
            <div className="mt-4 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-[var(--app-fg)]">
                    Hide completed tool calls
                  </div>
                  <div className="mt-1 text-xs text-[var(--app-hint)]">
                    Running and failed tools still stay visible in chat.
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={hideToolCallsInChat}
                  onClick={() => setHideToolCallsInChat(!hideToolCallsInChat)}
                  className={`relative inline-flex h-6 w-11 shrink-0 rounded-full border transition-colors ${
                    hideToolCallsInChat
                      ? "border-primary bg-primary"
                      : "border-[var(--app-border)] bg-[var(--app-subtle-bg)]"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-4.5 w-4.5 rounded-full bg-white shadow-sm transition-transform ${
                      hideToolCallsInChat ? "translate-x-5" : "translate-x-0.5"
                    }`}
                  />
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="text-sm font-semibold text-[var(--app-fg)]">About</div>
            <div className="mt-4 space-y-3 text-xs text-[var(--app-hint)]">
              <div className="flex items-center justify-between gap-3 py-2 border-b border-[var(--app-border)]">
                <span>Workbench</span>
                <span className="font-medium text-[var(--app-fg)]">{__RAH_WORKBENCH_VERSION__}</span>
              </div>
              <div className="flex items-center justify-between gap-3 py-2 border-b border-[var(--app-border)]">
                <span>Client</span>
                <span className="font-medium text-[var(--app-fg)]">{__RAH_APP_VERSION__}</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
