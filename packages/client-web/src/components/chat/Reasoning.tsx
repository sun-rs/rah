import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { MarkdownRenderer } from "./MarkdownRenderer";

export function Reasoning({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex justify-start">
      <div className="max-w-[92%]">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1 text-xs text-[var(--app-hint)] hover:text-[var(--app-fg)] transition-colors"
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span className="italic">Reasoning</span>
        </button>
        {open ? (
          <div className="mt-1 rounded-lg border border-[var(--app-border)] bg-[var(--app-code-bg)] px-3 py-2 text-sm text-[var(--app-hint)] italic">
            <MarkdownRenderer
              className="prose-chat max-w-none"
              content={text}
              fallbackClassName="whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
