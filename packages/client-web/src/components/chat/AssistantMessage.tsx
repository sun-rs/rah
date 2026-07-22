import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { copyTextToClipboard } from "../../clipboard";
import { MarkdownRenderer } from "./MarkdownRenderer";

export function AssistantMessage(props: {
  content: string;
  copyable?: boolean;
  variant?: "final" | "process";
  onOpenLocalFile?: (path: string) => void;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if ((await copyTextToClipboard(props.content)) === "copied") {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  };
  const isFinalReply = props.variant === "final" || (props.copyable ?? false);

  return (
    <div className="flex flex-col items-start" data-testid="chat-assistant-message">
      {isFinalReply ? (
        <MarkdownRenderer
          className="prose-chat prose-chat-final max-w-none text-[var(--app-fg)]"
          content={props.content}
          {...(props.onOpenLocalFile ? { onOpenLocalFile: props.onOpenLocalFile } : {})}
        />
      ) : (
        <div className="assistant-process-message">
          <MarkdownRenderer
            className="prose-chat prose-chat-process max-w-none text-[14px] leading-relaxed text-[var(--app-muted)]"
            content={props.content}
            {...(props.onOpenLocalFile ? { onOpenLocalFile: props.onOpenLocalFile } : {})}
          />
        </div>
      )}
      {props.copyable ? (
        <div className="mt-2 flex w-full justify-start">
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
      ) : null}
    </div>
  );
}
