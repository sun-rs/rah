import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { copyTextToClipboard } from "../../clipboard";

export function AssistantTurnCopyAction(props: { content: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if ((await copyTextToClipboard(props.content)) === "copied") {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <div
      className="flex w-full justify-start"
      data-testid="assistant-turn-copy-action"
    >
      <button
        type="button"
        onClick={() => void handleCopy()}
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]"
        aria-label="Copy reply"
        title="Copy reply"
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </div>
  );
}
