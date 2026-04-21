import { useState } from "react";
import ReactMarkdown from "react-markdown";
import { ChevronDown, ChevronRight } from "lucide-react";

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
            <div className="prose-chat max-w-none">
              <ReactMarkdown>{text}</ReactMarkdown>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
