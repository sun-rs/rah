import { Check, Copy } from "lucide-react";
import { useState } from "react";

export function UserMessage(props: { content: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(props.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="flex items-start justify-end gap-3">
      <div className="min-w-0 max-w-[85%] sm:max-w-[75%]">
        <div className="rounded-2xl rounded-tr-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-4 py-3 text-[var(--app-fg)]">
          <div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-[15px] leading-relaxed">
            {props.content}
          </div>
        </div>
        <div className="mt-1.5 flex justify-end">
          <button
            type="button"
            onClick={handleCopy}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)] transition-colors"
            aria-label="Copy"
            title="Copy"
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
        </div>
      </div>
    </div>
  );
}
