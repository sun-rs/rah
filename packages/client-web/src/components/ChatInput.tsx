import React, { useState, useRef, useEffect } from "react";
import { Send, Hash, Sparkles } from "lucide-react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import * as api from "../api";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function ChatInput({ sessionId }: { sessionId: string }) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = async () => {
    if (!value.trim()) return;
    try {
      await api.sendSessionInput(sessionId, {
        clientId: "chat-input",
        text: value,
      });
      setValue("");
    } catch (err) {
      console.error("Failed to send input", err);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, [value]);

  return (
    <div className="p-6 bg-gradient-to-t from-background via-background to-transparent pt-12">
      <div className="max-w-4xl mx-auto relative group">
        <div className="absolute -inset-0.5 bg-gradient-to-r from-primary/20 via-primary/10 to-primary/20 rounded-2xl blur opacity-30 group-focus-within:opacity-100 transition duration-1000 group-focus-within:duration-200"></div>
        <div className="relative flex items-end gap-2 bg-card border border-border rounded-2xl p-2 shadow-2xl focus-within:ring-2 focus-within:ring-primary/20 transition-all">
          <div className="flex flex-col gap-2 p-2">
            <button className="p-1.5 hover:bg-muted rounded-lg text-muted-foreground hover:text-primary transition-colors">
              <Sparkles size={18} />
            </button>
          </div>
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type your command or message..."
            className="flex-1 bg-transparent border-none focus:ring-0 text-sm py-3 px-2 min-h-[44px] max-h-[200px] resize-none placeholder:text-muted-foreground/50 leading-relaxed"
            rows={1}
          />
          <div className="p-2">
            <button
              onClick={handleSend}
              disabled={!value.trim()}
              className={cn(
                "p-2.5 rounded-xl transition-all shadow-lg",
                value.trim() 
                  ? "bg-primary text-primary-foreground hover:scale-105 active:scale-95" 
                  : "bg-muted text-muted-foreground opacity-50 cursor-not-allowed"
              )}
            >
              <Send size={18} />
            </button>
          </div>
        </div>
        <div className="flex justify-between items-center mt-3 px-2">
          <div className="flex items-center gap-4 text-[10px] text-muted-foreground font-medium">
             <div className="flex items-center gap-1"><kbd className="bg-muted px-1.5 py-0.5 rounded border border-border shadow-sm font-mono">Shift + Enter</kbd> for newline</div>
             <div className="flex items-center gap-1"><kbd className="bg-muted px-1.5 py-0.5 rounded border border-border shadow-sm font-mono">Enter</kbd> to send</div>
          </div>
          <div className="text-[10px] text-muted-foreground/50 italic font-medium">
            CLI Interceptor Active
          </div>
        </div>
      </div>
    </div>
  );
}
